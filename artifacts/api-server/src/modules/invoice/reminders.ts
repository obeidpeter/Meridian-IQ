// Automatic deadline reminders (SME-05 closing the loop): the dashboard
// classifies unsubmitted invoices as due-soon/overdue passively; this sweep
// makes the alert active — the client is told through their enabled channels
// instead of having to look. Fan-out mirrors the B2C pre-breach alert:
// messaging rail (with failover) + push, pointer-only payloads (SEC-12).
//
// The claim-first loop — classification, claim-first-commit, the dark-flag/
// stale/opt-out gates and the fan-out — is the shared sweep skeleton
// (modules/messaging/reminder-sweep.ts, one home with the obligation sweep);
// this module keeps its own SQL prefilter, deadline function and claim
// ledger.
import { and, inArray, lte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  deadlineReminderSendsTable,
} from "@workspace/db";
import {
  runClaimFirstReminderSweep,
  type ReminderKind,
} from "../messaging/reminder-sweep";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString } from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS, submissionDeadline } from "./compliance-window";

// Mirrors the dashboard's classification exactly (routes/sme.ts): due_soon at
// <= 3 days to the submission deadline, overdue past it. A reminder fires once
// per invoice per threshold — the deadline_reminder_sends ledger is the
// idempotency guard, not the sweep cadence.
export const DUE_SOON_DAYS = 3;

// An invoice this far past its deadline predates the reminder feature (or sat
// in a dead book): claim its slot silently instead of sending. Without this,
// enabling reminders on an existing deployment would blast a message for
// every stale draft ever left behind.
export const STALE_OVERDUE_DAYS = 60;

// Bound one pass; stragglers are picked up next tick (the sweep runs every
// minute, so a burst of due invoices drains within a few passes).
const BATCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the number of slots CLAIMED this pass (sends may be fewer: opt-outs,
// dark flag and stale invoices claim silently). Zero means the book is fully
// processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context (the shared driver's
// transaction-scope note in reminder-sweep.ts tells the story).
export async function sweepDeadlineReminders(
  now = new Date(),
): Promise<number> {
  // SQL prefilter: daysUntil(issueDate + WINDOW, now) <= DUE_SOON_DAYS implies
  // issueDate < now - (WINDOW - DUE_SOON_DAYS) days. Date-only granularity may
  // admit a boundary row; the driver's exact JS classification settles it.
  // Oldest first: the most overdue invoices are processed ahead of the merely
  // due-soon when a backlog exceeds one pass.
  const cutoff = lagosDateString(
    new Date(now.getTime() - (SUBMISSION_WINDOW_DAYS - DUE_SOON_DAYS) * DAY_MS),
  );
  // Exclude invoices already claimed at their CURRENT threshold — without
  // this, a backlog wider than the limit keeps returning the same processed
  // rows and newer due invoices never enter the window. The CASE mirrors the
  // JS classification: past the deadline instant (Lagos midnight after the
  // window, matching submissionDeadline) means overdue.
  const unclaimedAtThreshold = sql`NOT EXISTS (
    SELECT 1 FROM deadline_reminder_sends s
    WHERE s.invoice_id = ${invoicesTable.id}
      AND s.kind::text = CASE
        WHEN ((${invoicesTable.issueDate}::date
              + ${SUBMISSION_WINDOW_DAYS} * interval '1 day')::timestamp
              AT TIME ZONE 'Africa/Lagos') < ${now}
        THEN 'overdue' ELSE 'due_soon' END
  )`;
  // The live-engagement wall, same enumeration and rationale as the
  // obligation reminder sweep (modules/obligations/reminders.ts) and the
  // client-statement sweep: a dormant book — every engagement completed or
  // archived, client not offboarded — must not keep receiving deadline
  // nudges. No claim slot is consumed while walled, so re-opening the
  // engagement resumes exactly where the ladder left off.
  const liveEngagement = sql`EXISTS (
    SELECT 1 FROM engagements e
    WHERE e.firm_id = ${invoicesTable.firmId}
      AND e.client_party_id = ${invoicesTable.supplierPartyId}
      AND e.status IN ('open', 'in_progress')
  )`;
  const candidates = await getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        inArray(invoicesTable.status, ["draft", "validated"]),
        lte(invoicesTable.issueDate, cutoff),
        unclaimedAtThreshold,
        liveEngagement,
      ),
    )
    .orderBy(invoicesTable.issueDate)
    .limit(BATCH_LIMIT * 2);

  return runClaimFirstReminderSweep(now, candidates, {
    batchLimit: BATCH_LIMIT,
    dueSoonDays: DUE_SOON_DAYS,
    staleOverdueDays: STALE_OVERDUE_DAYS,
    deadlineFor: (inv) => submissionDeadline(inv.issueDate),
    clientPartyIdOf: (inv) => inv.supplierPartyId,
    firmIdOf: (inv) => inv.firmId,
    // Claim the (invoice, kind) slot — the unique index is the atomic
    // cross-instance once-only gate.
    claim: async (inv, kind: ReminderKind) => {
      const claim = await runInBypassContext(() =>
        getDb()
          .insert(deadlineReminderSendsTable)
          .values({
            invoiceId: inv.id,
            clientPartyId: inv.supplierPartyId,
            firmId: inv.firmId,
            kind,
          })
          .onConflictDoNothing()
          .returning({ id: deadlineReminderSendsTable.id }),
      );
      return claim.length > 0;
    },
    // One template for both thresholds — the historical invoice shape (the
    // obligation sweep keys per kind).
    templateKeyFor: () => "deadline_reminder",
    entityType: "invoice",
    entityRef: (inv) => pointerEntityRef("inv", inv.id),
  });
}
