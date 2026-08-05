// Obligation deadline reminders (Notice Desk): the module's due-soon/overdue
// classification is passive; this sweep makes it active — the client is told
// through their enabled channels that an authority notice needs a response.
//
// The claim-first loop — classification, claim-first-commit, the dark-flag/
// stale/opt-out gates and the consent-gated pointer-only fan-out (SEC-12) —
// is the shared sweep skeleton (modules/messaging/reminder-sweep.ts, one home
// with the invoice sweep); this module keeps its own SQL prefilter with the
// NOT-EXISTS unclaimed-at-current-threshold subquery, its deadline function
// and its (obligation, kind) claim ledger.
import { and, lte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  obligationsTable,
  obligationReminderSendsTable,
} from "@workspace/db";
import {
  runClaimFirstReminderSweep,
  type ReminderKind,
} from "../messaging/reminder-sweep";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString, lagosMidnightPlusDays } from "../../lib/lagos-time";
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
  return lagosMidnightPlusDays(responseDueDate, 1);
}

// Returns the number of slots CLAIMED this pass (sends may be fewer:
// opt-outs, dark flag and stale obligations claim silently). Zero means the
// book is fully processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context (the shared driver's
// transaction-scope note in reminder-sweep.ts tells the story).
export async function sweepObligationReminders(
  now = new Date(),
): Promise<number> {
  // SQL prefilter: anything due within the window (or already past it).
  // Date-only granularity may admit a boundary row; the driver's exact JS
  // classification settles it. Soonest deadline first: the most overdue
  // obligations are processed ahead of the merely due-soon when a backlog
  // exceeds one pass.
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
  // The firm↔client relationship must still be LIVE (an open/in_progress
  // engagement) for the platform to keep nudging the client about this
  // firm's obligation book: offboarding archives every engagement — and
  // deletes the client logins that could have silenced the alerts — and a
  // dormant book must not keep sending either. Same wall, same status
  // enumeration as the standing-approval sweep's engagement_closed
  // tripwire and the client-statement enumeration; deliberately spelled
  // locally like theirs (rbac's firmEngagesParty counts ARCHIVED
  // engagements for retention-era reads and must keep doing so). The
  // obligation row itself stays open and visible on the firm's surfaces —
  // evidence of an unresolved matter — only the SENDS stop; re-opening an
  // engagement resumes them, and no claim slot is consumed meanwhile.
  const liveEngagement = sql`EXISTS (
    SELECT 1 FROM engagements e
    WHERE e.firm_id = ${obligationsTable.firmId}
      AND e.client_party_id = ${obligationsTable.clientPartyId}
      AND e.status IN ('open', 'in_progress')
  )`;
  const candidates = await getDb()
    .select()
    .from(obligationsTable)
    .where(
      and(
        OBLIGATION_OPEN,
        lte(obligationsTable.responseDueDate, cutoff),
        unclaimedAtThreshold,
        liveEngagement,
      ),
    )
    .orderBy(obligationsTable.responseDueDate)
    .limit(BATCH_LIMIT * 2);

  // Notices deserve more runway than invoices: OBLIGATION_DUE_SOON_DAYS is a
  // full week (obligations.ts). Reminders honour the SAME deadline-alerts
  // opt-out and the same deadline_alerts consent purpose as invoice
  // reminders — one switch for every statutory-clock nudge, deliberately NOT
  // a new purpose.
  return runClaimFirstReminderSweep(now, candidates, {
    batchLimit: BATCH_LIMIT,
    dueSoonDays: OBLIGATION_DUE_SOON_DAYS,
    staleOverdueDays: OBLIGATION_STALE_OVERDUE_DAYS,
    deadlineFor: (o) => responseDeadline(o.responseDueDate),
    clientPartyIdOf: (o) => o.clientPartyId,
    firmIdOf: (o) => o.firmId,
    // Claim the (obligation, kind) slot — the unique index is the atomic
    // cross-instance once-only gate.
    claim: async (o, kind: ReminderKind) => {
      const claim = await runInBypassContext(() =>
        getDb()
          .insert(obligationReminderSendsTable)
          .values({
            obligationId: o.id,
            clientPartyId: o.clientPartyId,
            firmId: o.firmId,
            kind,
          })
          .onConflictDoNothing()
          .returning({ id: obligationReminderSendsTable.id }),
      );
      return claim.length > 0;
    },
    templateKeyFor: (kind) =>
      kind === "overdue" ? "obligation_overdue" : "obligation_due_soon",
    entityType: "obligation",
    entityRef: (o) => pointerEntityRef("obl", o.id),
  });
}
