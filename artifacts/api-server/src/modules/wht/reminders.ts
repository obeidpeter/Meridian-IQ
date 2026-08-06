// WHT credit-note chase reminders (WHT Desk): a recorded deduction whose
// buyer credit note is still outstanding goes stale — after the chase window
// the client is nudged through their enabled channels to chase the buyer.
//
// The claim-first loop — classification, claim-first-commit, the dark-flag/
// stale/opt-out gates and the consent-gated pointer-only fan-out (SEC-12) —
// is the shared sweep skeleton (modules/messaging/reminder-sweep.ts, one
// home with the invoice/obligation/filing sweeps); this module keeps its own
// SQL prefilter with the NOT-EXISTS unclaimed-at-current-threshold subquery,
// its deadline function (deducted date + the chase window) and its
// (credit, kind) claim ledger. Fail-closed rails throughout: the messaging
// flag dark means claims land silently, and consent stays the shared
// deadline_alerts purpose inside fanOutAlert — never a new purpose.
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  whtCreditsTable,
  whtReminderSendsTable,
} from "@workspace/db";
import {
  runClaimFirstReminderSweep,
  type ReminderKind,
} from "../messaging/reminder-sweep";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString, lagosMidnightPlusDays } from "../../lib/lagos-time";

// The chase clock: a buyer that has not produced the credit note this many
// days after the deduction is chased. The deadline instant is Lagos midnight
// ON day deducted+30 — SQL prefilter expressions that classify against it
// must use the matching `(deducted_date::date + 30)::timestamp AT TIME ZONE
// 'Africa/Lagos'` spelling.
export const WHT_NOTE_CHASE_DAYS = 30;

// Same runway as the statutory sweeps: the "due soon" warning lands a week
// before the chase deadline.
export const WHT_CHASE_DUE_SOON_DAYS = 7;

// A credit this far past its chase deadline predates the reminder feature
// (or sat in a dead book): claim its slot silently instead of sending — the
// no-day-one-blast rule. Wider than the filings window: a credit note can
// legitimately trail by months, and an old ledger must not blast on day one.
export const WHT_STALE_OVERDUE_DAYS = 180;

// Bound one pass; stragglers are picked up next tick.
const BATCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// The instant the chase falls due: Lagos midnight on the 30th day after the
// deduction.
function chaseDeadline(deductedDate: string): Date {
  return lagosMidnightPlusDays(deductedDate, WHT_NOTE_CHASE_DAYS);
}

// Returns the number of slots CLAIMED this pass (sends may be fewer:
// opt-outs, dark flag and stale credits claim silently). Zero means the
// ledger is fully processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context (the shared driver's
// transaction-scope note in reminder-sweep.ts tells the story).
export async function sweepWhtReminders(now = new Date()): Promise<number> {
  // SQL prefilter: any awaiting-note credit whose chase deadline falls
  // within the due-soon window (or already passed). Date-only granularity
  // may admit a boundary row; the driver's exact JS classification settles
  // it. Oldest deduction first: the stalest chases are processed ahead of
  // the merely due-soon when a backlog exceeds one pass.
  const cutoff = lagosDateString(
    new Date(now.getTime() + WHT_CHASE_DUE_SOON_DAYS * DAY_MS),
  );
  // Exclude credits already claimed at their CURRENT threshold — without
  // this, a backlog wider than the limit keeps returning the same processed
  // rows. The CASE mirrors the JS classification: past the deadline instant
  // (Lagos midnight on deducted+30, matching chaseDeadline) means overdue.
  const unclaimedAtThreshold = sql`NOT EXISTS (
    SELECT 1 FROM wht_reminder_sends s
    WHERE s.credit_id = ${whtCreditsTable.id}
      AND s.kind::text = CASE
        WHEN ((${whtCreditsTable.deductedDate}::date
              + ${sql.raw(String(WHT_NOTE_CHASE_DAYS))})::timestamp
              AT TIME ZONE 'Africa/Lagos') < ${now}
        THEN 'overdue' ELSE 'due_soon' END
  )`;
  // The firm↔client relationship must still be LIVE (an open/in_progress
  // engagement) for the platform to keep nudging the client about this
  // firm's chase ledger — the filings reminder wall verbatim: offboarding
  // archives every engagement (and deletes the client logins that could
  // have silenced the alerts), and a dormant book must not keep sending.
  // The credit row itself stays visible on the firm's surfaces — only the
  // SENDS stop, and no claim slot is consumed meanwhile, so re-opening an
  // engagement resumes them.
  const liveEngagement = sql`EXISTS (
    SELECT 1 FROM engagements e
    WHERE e.firm_id = ${whtCreditsTable.firmId}
      AND e.client_party_id = ${whtCreditsTable.clientPartyId}
      AND e.status IN ('open', 'in_progress')
  )`;
  const candidates = await getDb()
    .select()
    .from(whtCreditsTable)
    .where(
      and(
        eq(whtCreditsTable.status, "awaiting_note"),
        sql`(${whtCreditsTable.deductedDate}::date + ${sql.raw(String(WHT_NOTE_CHASE_DAYS))}) <= ${cutoff}::date`,
        unclaimedAtThreshold,
        liveEngagement,
      ),
    )
    .orderBy(whtCreditsTable.deductedDate)
    .limit(BATCH_LIMIT * 2);

  // Reminders honour the SAME deadline-alerts opt-out and the same
  // deadline_alerts consent purpose as the invoice, obligation and filing
  // sweeps — one switch for every statutory-clock nudge, deliberately NOT a
  // new purpose (fanOutAlert enforces both inside the shared driver).
  return runClaimFirstReminderSweep(now, candidates, {
    batchLimit: BATCH_LIMIT,
    dueSoonDays: WHT_CHASE_DUE_SOON_DAYS,
    staleOverdueDays: WHT_STALE_OVERDUE_DAYS,
    deadlineFor: (c) => chaseDeadline(c.deductedDate),
    clientPartyIdOf: (c) => c.clientPartyId,
    firmIdOf: (c) => c.firmId,
    // Claim the (credit, kind) slot — the unique index is the atomic
    // cross-instance once-only gate.
    claim: async (c, kind: ReminderKind) => {
      const claim = await runInBypassContext(() =>
        getDb()
          .insert(whtReminderSendsTable)
          .values({
            creditId: c.id,
            clientPartyId: c.clientPartyId,
            firmId: c.firmId,
            kind,
          })
          .onConflictDoNothing()
          .returning({ id: whtReminderSendsTable.id }),
      );
      return claim.length > 0;
    },
    templateKeyFor: (kind) =>
      kind === "overdue" ? "wht_note_overdue" : "wht_note_due_soon",
    entityType: "wht_credit",
    entityRef: (c) => pointerEntityRef("whc", c.id),
  });
}
