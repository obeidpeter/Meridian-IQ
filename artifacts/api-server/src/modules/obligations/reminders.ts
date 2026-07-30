// Obligation deadline reminders (Notice Desk): the module's due-soon/overdue
// classification is passive; this sweep makes it active — the client is told
// through their enabled channels that an authority notice needs a response.
// The SHAPE is modules/invoice/reminders.ts verbatim: SQL prefilter with a
// NOT-EXISTS unclaimed-at-current-threshold subquery, exact JS classification,
// claim FIRST in its own committed bypass transaction (the unique
// (obligation, kind) index is the cross-instance once-only gate), then the
// consent-gated pointer-only fan-out (SEC-12).
import { and, lte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  obligationsTable,
  obligationReminderSendsTable,
  alertPreferencesTable,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { fanOutAlert } from "../messaging/fan-out";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString, lagosMidnight } from "../../lib/lagos-time";
import { daysUntil } from "../invoice/compliance-window";
import { OBLIGATION_DUE_SOON_DAYS, OBLIGATION_OPEN } from "./obligations";

// An obligation this far past its response date predates the reminder feature
// (or sat in a dead book): claim its slot silently instead of sending — the
// invoice sweep's no-day-one-blast rule.
export const OBLIGATION_STALE_OVERDUE_DAYS = 60;

// Bound one pass; stragglers are picked up next tick.
const BATCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// The instant an obligation BECOMES overdue: Lagos midnight AFTER the
// response day (the module's `response_due_date < today` boundary — on the
// due day itself the response can still go out). SQL prefilter expressions
// that classify against this deadline must use the matching
// `(response_due_date + 1)::timestamp AT TIME ZONE 'Africa/Lagos'` spelling.
function responseDeadline(responseDueDate: string): Date {
  const d = lagosMidnight(responseDueDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// Returns the number of slots CLAIMED this pass (sends may be fewer:
// opt-outs, dark flag and stale obligations claim silently). Zero means the
// book is fully processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context. The candidate read, the
// prefs read and the sends run on the ambient-free raw pool (autocommit);
// only the per-row CLAIM opens a transaction, and it COMMITS before any send
// leaves — a claimed reminder whose sends then fail is NOT re-offered
// (at-most-once by design; the obligations list still shows the deadline).
export async function sweepObligationReminders(
  now = new Date(),
): Promise<number> {
  // SQL prefilter: anything due within the window (or already past it).
  // Date-only granularity may admit a boundary row; the exact JS
  // classification below settles it. Soonest deadline first: the most
  // overdue obligations are processed ahead of the merely due-soon when a
  // backlog exceeds one pass.
  const cutoff = lagosDateString(
    new Date(now.getTime() + OBLIGATION_DUE_SOON_DAYS * DAY_MS),
  );
  // Exclude obligations already claimed at their CURRENT threshold — without
  // this, a backlog wider than the limit keeps returning the same processed
  // rows. The CASE mirrors the JS classification: past the deadline instant
  // (Lagos midnight after the response day, matching responseDeadline) means
  // overdue.
  const unclaimedAtThreshold = sql`NOT EXISTS (
    SELECT 1 FROM obligation_reminder_sends s
    WHERE s.obligation_id = ${obligationsTable.id}
      AND s.kind::text = CASE
        WHEN ((${obligationsTable.responseDueDate}::date
              + 1)::timestamp
              AT TIME ZONE 'Africa/Lagos') < ${now}
        THEN 'overdue' ELSE 'due_soon' END
  )`;
  const candidates = await getDb()
    .select()
    .from(obligationsTable)
    .where(
      and(
        OBLIGATION_OPEN,
        lte(obligationsTable.responseDueDate, cutoff),
        unclaimedAtThreshold,
      ),
    )
    .orderBy(obligationsTable.responseDueDate)
    .limit(BATCH_LIMIT * 2);

  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const obligation of candidates) {
    if (claimed >= BATCH_LIMIT) break;
    const days = daysUntil(responseDeadline(obligation.responseDueDate), now);
    if (days > OBLIGATION_DUE_SOON_DAYS) continue; // boundary row still upcoming
    const kind = days < 0 ? ("overdue" as const) : ("due_soon" as const);

    // Claim the (obligation, kind) slot first, in its OWN short committed
    // transaction — the unique index makes the insert the atomic cross-
    // instance once-only gate.
    const claim = await runInBypassContext(() =>
      getDb()
        .insert(obligationReminderSendsTable)
        .values({
          obligationId: obligation.id,
          clientPartyId: obligation.clientPartyId,
          firmId: obligation.firmId,
          kind,
        })
        .onConflictDoNothing()
        .returning({ id: obligationReminderSendsTable.id }),
    );
    if (claim.length === 0) continue; // already reminded at this threshold
    claimed++;

    // The claim row is written even while messaging is dark (PL-02), and
    // ancient stale notices claim silently: turning the flag on later must
    // not blast reminders for a backlog nobody is acting on.
    if (!messagingOn) continue;
    if (days < -OBLIGATION_STALE_OVERDUE_DAYS) continue;

    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(
        sql`${alertPreferencesTable.clientPartyId} = ${obligation.clientPartyId}`,
      )
      .limit(1);
    // No prefs row means the table defaults apply: whatsapp/email/push on,
    // sms off, deadline alerts on. Obligation reminders honour the SAME
    // deadline-alerts opt-out as invoice reminders — one switch for every
    // statutory-clock nudge.
    if (prefs && !prefs.deadlineAlerts) continue;
    // Sends happen strictly AFTER the claim committed, outside any open
    // transaction. Consent (CORE-03) is checked inside fanOutAlert under the
    // deadline_alerts purpose — obligation deadlines are the same
    // compliance-alert purpose as invoice deadlines, deliberately NOT a new
    // purpose. Payloads are pointer-only (SEC-12).
    await fanOutAlert({
      prefs,
      clientPartyId: obligation.clientPartyId,
      firmId: obligation.firmId,
      templateKey:
        kind === "overdue" ? "obligation_overdue" : "obligation_due_soon",
      entityType: "obligation",
      entityId: pointerEntityRef("obl", obligation.id),
      // The invoice deadline-reminder default preserved: with no prefs row,
      // SMS stays off.
      smsDefaultWhenNoPrefs: false,
    });
  }
  return claimed;
}
