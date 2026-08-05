import { sql } from "drizzle-orm";
import { getDb, alertPreferencesTable } from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { daysUntil } from "../invoice/compliance-window";
import { fanOutAlert } from "./fan-out";
import type { PushTemplateKey } from "../push/push";

// The claim-first deadline-reminder sweep skeleton (refactor round 7), shared
// by the invoice sweep (modules/invoice/reminders.ts) and the obligation
// sweep (modules/obligations/reminders.ts). Before this the two loop bodies
// were kept in lockstep by comment convention alone ("the SHAPE is
// modules/invoice/reminders.ts verbatim"); now the shared behavior — exact JS
// classification with the boundary-row skip, claim-first-commit, the dark-
// flag/stale/opt-out gates and the consent-gated pointer-only fan-out — has
// ONE home, and each module keeps only what genuinely differs: its SQL
// prefilter + NOT-EXISTS fragment (one home per predicate), its deadline
// function and window constants, its claim ledger, and its template keys.
//
// Sweep-only: must run OUTSIDE any request context, mirroring the digest
// delivery shape (deliverFirmDigests). The candidate read, the prefs read and
// the sends run on the ambient-free raw pool (autocommit — each message/push
// insert is individually durable); only the per-row CLAIM (the module's
// `claim` callback) opens a transaction, and it COMMITS before any send
// leaves. Holding one bypass transaction across the whole pass — claims,
// prefs reads AND the provider sends — meant a mid-pass failure rolled back
// every claim and message row while real-provider sends had already left the
// building, and sibling instances blocked on the row locks for the duration.

export type ReminderKind = "due_soon" | "overdue";

export interface ReminderSweepConfig<Row> {
  // Bound one pass; stragglers are picked up next tick. Candidates should be
  // fetched at 2x this bound so boundary rows the exact classification skips
  // do not starve a full batch.
  batchLimit: number;
  // due_soon at <= this many days to the deadline instant; overdue past it.
  dueSoonDays: number;
  // A row this far past its deadline predates the reminder feature (or sat
  // in a dead book): claim its slot silently instead of sending — the
  // no-day-one-blast rule.
  staleOverdueDays: number;
  // The deadline instant (Lagos midnight boundary) the row is classified
  // against — must match the module's SQL prefilter spelling.
  deadlineFor(row: Row): Date;
  clientPartyIdOf(row: Row): string;
  firmIdOf(row: Row): string;
  // Claim the (row, kind) slot in its OWN short committed transaction — the
  // module's unique index makes the insert the atomic cross-instance
  // once-only gate. Returns false when the slot was already claimed.
  claim(row: Row, kind: ReminderKind): Promise<boolean>;
  templateKeyFor(kind: ReminderKind): PushTemplateKey;
  entityType: string;
  // Pointer-only entity ref (SEC-12) for the fan-out payload.
  entityRef(row: Row): string;
}

// Run the shared loop over one pass's candidates (the module's own SQL
// prefilter, soonest deadline first). Returns the number of slots CLAIMED
// this pass (sends may be fewer: opt-outs, dark flag and stale rows claim
// silently). Zero means the book is fully processed — callers can drain by
// looping until then.
export async function runClaimFirstReminderSweep<Row>(
  now: Date,
  candidates: Row[],
  cfg: ReminderSweepConfig<Row>,
): Promise<number> {
  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const row of candidates) {
    if (claimed >= cfg.batchLimit) break;
    const days = daysUntil(cfg.deadlineFor(row), now);
    if (days > cfg.dueSoonDays) continue; // boundary row still upcoming
    const kind: ReminderKind = days < 0 ? "overdue" : "due_soon";

    // Claim the slot first, in its OWN short committed transaction:
    // committing it BEFORE any send leaves is the at-most-once trade — a
    // claimed reminder whose sends then fail is NOT re-offered (better a
    // missed nudge than a double alert; the module's own surfaces still show
    // the row as due/overdue either way).
    if (!(await cfg.claim(row, kind))) continue; // already reminded at this threshold
    claimed++;

    // The claim row is written even while messaging is dark (PL-02), and
    // ancient stale rows claim silently: turning the flag on later must not
    // blast reminders for a backlog nobody is acting on.
    if (!messagingOn) continue;
    if (days < -cfg.staleOverdueDays) continue;

    const clientPartyId = cfg.clientPartyIdOf(row);
    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(sql`${alertPreferencesTable.clientPartyId} = ${clientPartyId}`)
      .limit(1);
    // No prefs row means the table defaults apply: whatsapp/email/push on,
    // sms off, deadline alerts on.
    if (prefs && !prefs.deadlineAlerts) continue;
    // Sends happen strictly AFTER the claim committed, outside any open
    // transaction: each message/push write is an autocommit insert, so a
    // failure here loses at most this reminder's remaining channels — never
    // a committed claim (fanOutAlert absorbs per-channel failures; they land
    // in the messages ledger). Consent (CORE-03) is checked inside
    // fanOutAlert under the shared deadline_alerts purpose; payloads are
    // pointer-only (SEC-12).
    await fanOutAlert({
      prefs,
      clientPartyId,
      firmId: cfg.firmIdOf(row),
      templateKey: cfg.templateKeyFor(kind),
      entityType: cfg.entityType,
      entityId: cfg.entityRef(row),
      // Both sweeps preserve the historical deadline-reminder default: with
      // no prefs row, SMS stays off (unlike the B2C pre-breach alert).
      smsDefaultWhenNoPrefs: false,
    });
  }
  return claimed;
}
