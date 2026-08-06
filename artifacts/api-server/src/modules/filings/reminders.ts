// Filing deadline reminders (Filing Desk Phase 2): the register's due-soon/
// overdue classification is passive; this sweep makes it active — the client
// is told through their enabled channels that a statutory return needs
// filing.
//
// The claim-first loop — classification, claim-first-commit, the dark-flag/
// stale/opt-out gates and the consent-gated pointer-only fan-out (SEC-12) —
// is the shared sweep skeleton (modules/messaging/reminder-sweep.ts, one home
// with the invoice and obligation sweeps); this module keeps its own SQL
// prefilter with the NOT-EXISTS unclaimed-at-current-threshold subquery, its
// deadline function and its (filing, kind) claim ledger.
import { and, lte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  filingReturnsTable,
  filingReminderSendsTable,
} from "@workspace/db";
import {
  runClaimFirstReminderSweep,
  type ReminderKind,
} from "../messaging/reminder-sweep";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString, lagosMidnightPlusDays } from "../../lib/lagos-time";
import { FILING_DUE_SOON_DAYS, FILING_UNFILED } from "./filings";

// A return this far past its statutory date predates the reminder feature
// (or sat in a dead book): claim its slot silently instead of sending — the
// invoice sweep's no-day-one-blast rule.
export const FILING_STALE_OVERDUE_DAYS = 60;

// Bound one pass; stragglers are picked up next tick.
const BATCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// The instant a return BECOMES overdue: Lagos midnight AFTER the due day
// (the module's `due_date < today` boundary — on the due day itself the
// return can still be filed, so that day classifies as due-soon, never
// overdue). SQL prefilter expressions that classify against this deadline
// must use the matching `(due_date::date + 1)::timestamp AT TIME ZONE
// 'Africa/Lagos'` spelling.
function filingDeadline(dueDate: string): Date {
  return lagosMidnightPlusDays(dueDate, 1);
}

// Returns the number of slots CLAIMED this pass (sends may be fewer:
// opt-outs, dark flag and stale returns claim silently). Zero means the
// register is fully processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context (the shared driver's
// transaction-scope note in reminder-sweep.ts tells the story).
export async function sweepFilingReminders(now = new Date()): Promise<number> {
  // SQL prefilter: anything due within the window (or already past it).
  // Date-only granularity may admit a boundary row; the driver's exact JS
  // classification settles it. Soonest deadline first: the most overdue
  // returns are processed ahead of the merely due-soon when a backlog
  // exceeds one pass.
  const cutoff = lagosDateString(
    new Date(now.getTime() + FILING_DUE_SOON_DAYS * DAY_MS),
  );
  // Exclude returns already claimed at their CURRENT threshold — without
  // this, a backlog wider than the limit keeps returning the same processed
  // rows. The CASE mirrors the JS classification: past the deadline instant
  // (Lagos midnight after the due day, matching filingDeadline) means
  // overdue.
  const unclaimedAtThreshold = sql`NOT EXISTS (
    SELECT 1 FROM filing_reminder_sends s
    WHERE s.filing_id = ${filingReturnsTable.id}
      AND s.kind::text = CASE
        WHEN ((${filingReturnsTable.dueDate}::date
              + 1)::timestamp
              AT TIME ZONE 'Africa/Lagos') < ${now}
        THEN 'overdue' ELSE 'due_soon' END
  )`;
  // The firm↔client relationship must still be LIVE (an open/in_progress
  // engagement) for the platform to keep nudging the client about this
  // firm's filing register: offboarding archives every engagement — and
  // deletes the client logins that could have silenced the alerts — and a
  // dormant book must not keep sending either. Same wall, same status
  // enumeration as the obligation reminder sweep and the mint's
  // LIVE_ENGAGEMENT; deliberately spelled locally like theirs (rbac's
  // firmEngagesParty counts ARCHIVED engagements for retention-era reads and
  // must keep doing so). The register row itself stays visible on the firm's
  // surfaces — evidence of an unfiled return — only the SENDS stop;
  // re-opening an engagement resumes them, and no claim slot is consumed
  // meanwhile.
  const liveEngagement = sql`EXISTS (
    SELECT 1 FROM engagements e
    WHERE e.firm_id = ${filingReturnsTable.firmId}
      AND e.client_party_id = ${filingReturnsTable.clientPartyId}
      AND e.status IN ('open', 'in_progress')
  )`;
  const candidates = await getDb()
    .select()
    .from(filingReturnsTable)
    .where(
      and(
        FILING_UNFILED,
        lte(filingReturnsTable.dueDate, cutoff),
        unclaimedAtThreshold,
        liveEngagement,
      ),
    )
    .orderBy(filingReturnsTable.dueDate)
    .limit(BATCH_LIMIT * 2);

  // Returns get the same runway as obligations: FILING_DUE_SOON_DAYS is a
  // full week (filings.ts). Reminders honour the SAME deadline-alerts
  // opt-out and the same deadline_alerts consent purpose as invoice and
  // obligation reminders — one switch for every statutory-clock nudge,
  // deliberately NOT a new purpose.
  return runClaimFirstReminderSweep(now, candidates, {
    batchLimit: BATCH_LIMIT,
    dueSoonDays: FILING_DUE_SOON_DAYS,
    staleOverdueDays: FILING_STALE_OVERDUE_DAYS,
    deadlineFor: (f) => filingDeadline(f.dueDate),
    clientPartyIdOf: (f) => f.clientPartyId,
    firmIdOf: (f) => f.firmId,
    // Claim the (filing, kind) slot — the unique index is the atomic
    // cross-instance once-only gate.
    claim: async (f, kind: ReminderKind) => {
      const claim = await runInBypassContext(() =>
        getDb()
          .insert(filingReminderSendsTable)
          .values({
            filingId: f.id,
            clientPartyId: f.clientPartyId,
            firmId: f.firmId,
            kind,
          })
          .onConflictDoNothing()
          .returning({ id: filingReminderSendsTable.id }),
      );
      return claim.length > 0;
    },
    templateKeyFor: (kind) =>
      kind === "overdue" ? "filing_overdue" : "filing_due_soon",
    entityType: "filing_return",
    entityRef: (f) => pointerEntityRef("fil", f.id),
  });
}
