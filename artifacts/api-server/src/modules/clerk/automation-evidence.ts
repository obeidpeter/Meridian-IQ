import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { bandExposure } from "../invoice/penalty-exposure";
import { RECEIVABLE_ORIENTATION } from "../invoice/receivables";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
import {
  addDays,
  daysBetween,
  LOOKBACK_DAYS,
  median,
} from "../invoice/date-math";
import {
  MAX_OVERDUE_DAYS,
  patternAlertFor,
  type HistoryRow,
} from "../invoice/recurring-suggest";
import { lagosDateString } from "../../lib/lagos-time";
import { isFeatureEnabled } from "../flags/flags";
import { ACTIONS_FLAG_KEY, AUTO_RETRY_ATTEMPT_CAP } from "./actions";
import {
  AUTO_RECONCILE_CAP,
  AUTO_RECONCILE_FLAG_KEY,
  AUTO_RECONCILE_THRESHOLD,
  MACHINE_DRAFT_PREFIX,
} from "./plan-steps";

// Prove with Clerk Phase 1 (round 36): the backtest evidence behind the dark
// automation flags. Every powerful switch ships dark (clerk_actions,
// clerk_action_policies, clerk_auto_reconcile), so the decision to light one
// is currently taken on faith; this module computes, from ledgers the
// platform already holds, how often each automation kind WOULD have agreed
// with what humans later did — and what it would act on right now.
//
// Doctrine (the refined design): recorded ledgers first, replay second.
//  - reconcile_matches reads the durable match_proposals ledger verbatim —
//    confidence, status and the human's accept/reject are all recorded, so
//    agreement is a historical fact, not a reconstruction.
//  - submit_overdue / retry_failed re-derive the counterfactual from durable
//    facts only (issue dates, the append-only lifecycle ledger) — proposals
//    for these kinds are never stored, but the facts that assembled them are.
//  - draft_recurring replays the miner's PURE functions at past Lagos
//    month-ends; the one approximation (rows filtered by today's status, so
//    later-cancelled paper drops out retroactively) is named in the note.
// Provenance discipline throughout: a machine's own writes must never count
// as human agreement — decisions with policy_id/plan_run_id set (the
// automation-rollup "auto" predicate) and plan-step reconciliations (the
// clerk.plan_step.reconciled audit) are excluded from every "a human later
// did it" cohort. Pure ledger SQL + pure replay; zero model calls; nothing
// stored.

export const EVIDENCE_WINDOW_MONTHS = 6;

export type EvidenceKindKey =
  | "reconcile_matches"
  | "submit_overdue"
  | "retry_failed"
  | "draft_recurring";

export interface AutomationEvidenceKind {
  kind: EvidenceKindKey;
  // Decided historical cases in the window: agreed + disagreed. Pending is
  // excluded — it is the kind's act-now cohort, not evidence either way.
  sample: number;
  agreed: number;
  disagreed: number;
  pending: number;
  agreementRate: number | null;
  medianLeadDays: number | null;
  // s.104 small-band floor (whole-naira string) — submit_overdue only.
  exposureFloorNgn: string | null;
  note: string;
}

export interface AutomationEvidence {
  windowMonths: number;
  asOf: string;
  kinds: AutomationEvidenceKind[];
}

// The consent-surface caveats (honest-copy doctrine): each names what the
// number is NOT, in one line the card can render verbatim. Thresholds and
// caps interpolate the live constants so the copy cannot drift from the
// autopilot it describes.
const NOTES: Record<EvidenceKindKey, string> = {
  reconcile_matches: `Recorded ≥${AUTO_RECONCILE_THRESHOLD.toFixed(2)} receipt matches your team decided by hand; machine acceptances excluded. Live runs cap at ${AUTO_RECONCILE_CAP} per run.`,
  submit_overdue:
    "Replayed from issue dates and the submission ledger; machine-submitted batches excluded. Exposure is the s.104 small-band floor the late cohort risked — a would-have estimate, not a charge.",
  retry_failed: `Replayed from the lifecycle ledger; the act-now count respects the ${AUTO_RETRY_ATTEMPT_CAP}-attempt retry cap.`,
  draft_recurring:
    "Miner replayed at past month-ends over invoices as they stand today — later-cancelled paper drops out.",
};

function rate(agreed: number, disagreed: number): number | null {
  const decided = agreed + disagreed;
  if (decided === 0) return null;
  return Math.round((agreed / decided) * 1000) / 1000;
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// The last `count` CLOSED Lagos months' final calendar days, most recent
// first — the replay instants for draft_recurring. Pure over the asOf
// string (no clock reads), exported for unit tests.
export function closedLagosMonthEnds(asOf: string, count: number): string[] {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const out: string[] = [];
  for (let k = 1; k <= count; k++) {
    const idx = year * 12 + (month - 1) - k;
    const py = Math.floor(idx / 12);
    const pm = idx % 12;
    const lastDay = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
    out.push(
      `${py}-${String(pm + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    );
  }
  return out;
}

// A machine's own submission of this invoice (alias `i` in the enclosing
// query): any policy- or plan-minted decision whose targets record the
// invoice as submitted. The uuid comparison rides text — targets store the
// id as text, and a hand-written row degrades to no match, never a 22P02.
const MACHINE_SUBMITTED = sql`EXISTS (
  SELECT 1 FROM clerk_action_decisions d
  CROSS JOIN LATERAL jsonb_array_elements(d.targets) AS t(el)
  WHERE d.firm_id = i.firm_id
    AND (d.policy_id IS NOT NULL OR d.plan_run_id IS NOT NULL)
    AND t.el ->> 'invoiceId' = i.id::text
    AND t.el ->> 'outcome' = 'submitted'
)`;

// ---------------------------------------------------------------------------
// Act-now cohorts, extracted (Phase 3): the digest's weekly shadow line needs
// ONLY these counts, per firm, twenty firms per sweep pass — never the full
// backtest with its month-end replay. Each is the corresponding kind's exact
// act-now predicate.
// ---------------------------------------------------------------------------

// Distinct credit lines carrying a live ≥threshold proposal on a
// still-settleable invoice — the reconcileCandidates universe, uncapped
// (the per-run cap is a pacing device, not a ceiling on the backlog).
export async function pendingReconcileMatches(
  firmId: string,
  clientPartyId?: string,
): Promise<number> {
  const clientCond = clientPartyId
    ? sql`AND st.client_party_id = ${clientPartyId}`
    : sql``;
  const [row] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(DISTINCT mp.statement_line_id)::int AS n
      FROM match_proposals mp
      JOIN bank_statement_lines l ON l.id = mp.statement_line_id
      JOIN bank_statements st ON st.id = l.statement_id
      JOIN invoices i ON i.id = mp.invoice_id
      WHERE mp.firm_id = ${firmId}
        AND l.direction = 'credit'
        ${clientCond}
        AND mp.status = 'proposed'
        AND mp.confidence >= ${AUTO_RECONCILE_THRESHOLD}
        AND i.status NOT IN ('settled', 'cancelled', 'credited')
    `)
  ).rows;
  return num(row?.n);
}

// Today's overdue unsubmitted receivables — the submit_overdue assembly
// predicate, firm- or client-wide (the penalty-exposure spelling plus the
// machine-draft wall).
export async function pendingSubmitOverdue(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<number> {
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  const [row] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND i.status IN ('draft', 'validated')
        AND ${RECEIVABLE_ORIENTATION}
        ${clientCond}
        AND i.invoice_number NOT LIKE ${MACHINE_DRAFT_PREFIX + "%"}
        AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${asOf}::date
    `)
  ).rows;
  return num(row?.n);
}

// Currently-failed receivables still under the attempt cap — the exact
// universe the autopilot's retry_failed pass would touch.
export async function pendingRetryFailed(
  firmId: string,
  clientPartyId?: string,
): Promise<number> {
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  const [row] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND i.status = 'failed'
        AND ${RECEIVABLE_ORIENTATION}
        ${clientCond}
        AND (
          SELECT COUNT(*) FROM submission_attempts sa
          WHERE sa.invoice_id = i.id
        ) < ${AUTO_RETRY_ATTEMPT_CAP}
    `)
  ).rows;
  return num(row?.n);
}

// Optional client narrowing (Phase 2): the per-client evidence read rides
// the action-effectiveness posture, and every predicate here filters by
// BOTH firm and (when given) the client — the resolver's stated safety
// contract. Reconcile scopes by the statement's client; the invoice lanes
// scope by supplier (receivable orientation makes the supplier the client).
async function reconcileEvidence(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<AutomationEvidenceKind> {
  const db = getDb();
  const clientCond = clientPartyId
    ? sql`AND st.client_party_id = ${clientPartyId}`
    : sql``;
  // Human accept/reject verdicts on ≥threshold RECEIPT proposals (credit
  // lines only — the debit lane stays human and is not evidence for it).
  // Two precision guards: machine acceptances are excluded via the
  // plan-step audit's proposal pointer, and a verdict only counts when the
  // proposal was its line's TOP live candidate — accepting or rejecting a
  // lower sibling says nothing about the pick the autopilot (best per
  // line) would have made. A rejected higher sibling does not disqualify:
  // once a human kills the stronger candidate, this one IS the machine's
  // next pick. Lead time = how long the click the machine would have made
  // instantly took to arrive.
  const [decided] = (
    await db.execute<{
      agreed: number;
      disagreed: number;
      median_lead: number | null;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE mp.status = 'accepted')::int AS agreed,
        COUNT(*) FILTER (WHERE mp.status = 'rejected')::int AS disagreed,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (mp.decided_at - mp.created_at)) / 86400.0
        ) FILTER (WHERE mp.status = 'accepted') AS median_lead
      FROM match_proposals mp
      JOIN bank_statement_lines l ON l.id = mp.statement_line_id
      JOIN bank_statements st ON st.id = l.statement_id
      WHERE mp.firm_id = ${firmId}
        AND l.direction = 'credit'
        ${clientCond}
        AND mp.confidence >= ${AUTO_RECONCILE_THRESHOLD}
        AND mp.status IN ('accepted', 'rejected')
        AND mp.decided_at >= (${asOf}::date - interval '6 months')
        AND mp.decided_at < (${asOf}::date + interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM match_proposals s
          WHERE s.statement_line_id = mp.statement_line_id
            AND s.id <> mp.id
            AND s.confidence > mp.confidence
            AND s.status <> 'rejected'
        )
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.action = 'clerk.plan_step.reconciled'
            AND a.after ->> 'proposalId' = mp.id::text
        )
    `)
  ).rows;
  // A superseded ≥threshold proposal outranked by NOTHING — the human
  // accepted a lower-confidence sibling on the same line — is a genuine
  // disagreement with the pick the autopilot would have made. A superseded
  // twin of a stronger accepted sibling is not (the autopilot would have
  // picked the same winner), so the confidence comparison is strict.
  const [outranked] = (
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM match_proposals mp
      JOIN bank_statement_lines l ON l.id = mp.statement_line_id
      JOIN match_proposals acc
        ON acc.statement_line_id = mp.statement_line_id
       AND acc.status = 'accepted'
       AND acc.id <> mp.id
       AND acc.confidence < mp.confidence
      JOIN bank_statements st ON st.id = l.statement_id
      WHERE mp.firm_id = ${firmId}
        AND l.direction = 'credit'
        ${clientCond}
        AND mp.confidence >= ${AUTO_RECONCILE_THRESHOLD}
        AND mp.status = 'superseded'
        AND acc.decided_at >= (${asOf}::date - interval '6 months')
        AND acc.decided_at < (${asOf}::date + interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.action = 'clerk.plan_step.reconciled'
            AND a.after ->> 'proposalId' = acc.id::text
        )
    `)
  ).rows;
  const pending = await pendingReconcileMatches(firmId, clientPartyId);
  const agreed = num(decided?.agreed);
  const disagreed = num(decided?.disagreed) + num(outranked?.n);
  return {
    kind: "reconcile_matches",
    sample: agreed + disagreed,
    agreed,
    disagreed,
    pending,
    agreementRate: rate(agreed, disagreed),
    medianLeadDays: nullableNum(decided?.median_lead),
    exposureFloorNgn: null,
    note: NOTES.reconcile_matches,
  };
}

async function submitOverdueEvidence(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<AutomationEvidenceKind> {
  const db = getDb();
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  // Receivable invoices whose submit-by deadline fell inside the window,
  // machine drafts excluded (the DRAFT-% wall). Agreed = a human eventually
  // submitted it late (first submitted-transition after the deadline, not a
  // machine batch) — the autopilot would have done the same thing at the
  // deadline, medianLeadDays earlier. Disagreed = crossed the deadline and
  // was cancelled instead: the human decided that paper should never ride.
  const [row] = (
    await db.execute<{
      agreed: number;
      disagreed: number;
      median_late: number | null;
    }>(sql`
      WITH first_submit AS (
        SELECT invoice_id, MIN(created_at) AS at
        FROM invoice_lifecycle_events
        WHERE firm_id = ${firmId} AND to_status = 'submitted'
        GROUP BY invoice_id
      )
      SELECT
        COUNT(*) FILTER (
          WHERE fs.at IS NOT NULL
            AND (fs.at AT TIME ZONE 'Africa/Lagos')::date
                > i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
            AND NOT ${MACHINE_SUBMITTED}
        )::int AS agreed,
        COUNT(*) FILTER (
          WHERE fs.at IS NULL AND i.status = 'cancelled'
        )::int AS disagreed,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY (
            (fs.at AT TIME ZONE 'Africa/Lagos')::date
              - (i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int)
          )::float
        ) FILTER (
          WHERE fs.at IS NOT NULL
            AND (fs.at AT TIME ZONE 'Africa/Lagos')::date
                > i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
            AND NOT ${MACHINE_SUBMITTED}
        ) AS median_late
      FROM invoices i
      LEFT JOIN first_submit fs ON fs.invoice_id = i.id
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND ${RECEIVABLE_ORIENTATION}
        ${clientCond}
        AND i.invoice_number NOT LIKE ${MACHINE_DRAFT_PREFIX + "%"}
        AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int < ${asOf}::date
        AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
            >= (${asOf}::date - interval '6 months')::date
    `)
  ).rows;
  const pending = await pendingSubmitOverdue(firmId, asOf, clientPartyId);
  const agreed = num(row?.agreed);
  const disagreed = num(row?.disagreed);
  return {
    kind: "submit_overdue",
    sample: agreed + disagreed,
    agreed,
    disagreed,
    pending,
    agreementRate: rate(agreed, disagreed),
    medianLeadDays: nullableNum(row?.median_late),
    exposureFloorNgn: bandExposure(agreed).small,
    note: NOTES.submit_overdue,
  };
}

async function retryFailedEvidence(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<AutomationEvidenceKind> {
  const db = getDb();
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  // Invoices that ENTERED failed inside the window (first failed-transition
  // in the window is the clock start). Agreed = a human later resubmitted
  // (a failed → submitted re-transition after that entry, not a machine
  // batch); disagreed = cancelled instead; lead time = days the invoice sat
  // failed before the human retried — the retry the autopilot fires on its
  // next daily pass.
  const [row] = (
    await db.execute<{
      agreed: number;
      disagreed: number;
      median_lead: number | null;
    }>(sql`
      WITH failed_entry AS (
        SELECT e.invoice_id, MIN(e.created_at) AS at
        FROM invoice_lifecycle_events e
        WHERE e.firm_id = ${firmId} AND e.to_status = 'failed'
          AND e.created_at >= (${asOf}::date - interval '6 months')
          AND e.created_at < (${asOf}::date + interval '1 day')
        GROUP BY e.invoice_id
      ),
      resubmit AS (
        SELECT f.invoice_id, MIN(e.created_at) AS at
        FROM failed_entry f
        JOIN invoice_lifecycle_events e
          ON e.invoice_id = f.invoice_id
         AND e.to_status = 'submitted'
         AND e.created_at > f.at
        GROUP BY f.invoice_id
      )
      SELECT
        COUNT(*) FILTER (
          WHERE r.at IS NOT NULL AND NOT ${MACHINE_SUBMITTED}
        )::int AS agreed,
        COUNT(*) FILTER (
          WHERE r.at IS NULL AND i.status = 'cancelled'
        )::int AS disagreed,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.at - f.at)) / 86400.0
        ) FILTER (
          WHERE r.at IS NOT NULL AND NOT ${MACHINE_SUBMITTED}
        ) AS median_lead
      FROM failed_entry f
      JOIN invoices i ON i.id = f.invoice_id
      LEFT JOIN resubmit r ON r.invoice_id = f.invoice_id
      WHERE i.kind = 'invoice' AND ${RECEIVABLE_ORIENTATION} ${clientCond}
    `)
  ).rows;
  const pending = await pendingRetryFailed(firmId, clientPartyId);
  const agreed = num(row?.agreed);
  const disagreed = num(row?.disagreed);
  return {
    kind: "retry_failed",
    sample: agreed + disagreed,
    agreed,
    disagreed,
    pending,
    agreementRate: rate(agreed, disagreed),
    medianLeadDays: nullableNum(row?.median_lead),
    exposureFloorNgn: null,
    note: NOTES.retry_failed,
  };
}

interface EvidenceInvoiceRow extends Record<string, unknown> {
  id: string;
  supplier_party_id: string;
  buyer_party_id: string;
  currency: string;
  issue_date: string;
  grand_total: string;
}

interface RecurringReplayData {
  groups: Map<string, EvidenceInvoiceRow[]>;
  templateBirth: Map<string, string>;
}

// One fetch of the firm's (or one client's) receivable history wide enough
// for every replay instant, grouped for the miner's pure functions — shared
// by the full backtest and the act-now count.
async function loadRecurringGroups(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<RecurringReplayData> {
  const db = getDb();
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  const tplClientCond = clientPartyId
    ? sql`AND supplier_party_id = ${clientPartyId}`
    : sql``;
  // Window + the miner's own lookback; the miner's PURE functions run per
  // (supplier, buyer, currency) group at each replay instant. Deliberately
  // does NOT call buyerBillingHistories — that function anchors its
  // lookback to the wall clock; the replay must anchor per instant.
  const rows = (
    await db.execute<EvidenceInvoiceRow>(sql`
      SELECT i.id, i.supplier_party_id, i.buyer_party_id, i.currency,
             i.issue_date::text AS issue_date, i.grand_total::text AS grand_total
      FROM invoices i
      JOIN parties b ON b.id = i.buyer_party_id
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND i.status NOT IN ('cancelled', 'credited')
        AND i.grand_total IS NOT NULL
        AND b.merged_into_id IS NULL
        AND b.type = 'buyer'
        AND ${RECEIVABLE_ORIENTATION}
        ${clientCond}
        AND i.issue_date >=
          (${asOf}::date - interval '6 months')::date - ${LOOKBACK_DAYS}::int
      ORDER BY i.issue_date ASC
    `)
  ).rows;
  // Template coverage as it stood at each replay instant: coverage is per
  // (supplier, buyer) regardless of currency or active state (the miner's
  // own rule), reconstructed by created_at — the templates table keeps no
  // deletion history, so a later-created template must not censor an
  // earlier month's replay.
  const templates = (
    await db.execute<
      Record<string, unknown> & {
        supplier_party_id: string;
        buyer_party_id: string;
        created_day: string;
      }
    >(sql`
      SELECT supplier_party_id, buyer_party_id,
             (created_at AT TIME ZONE 'Africa/Lagos')::date::text AS created_day
      FROM recurring_invoice_templates
      WHERE firm_id = ${firmId}
        ${tplClientCond}
    `)
  ).rows;
  const templateBirth = new Map<string, string>();
  for (const t of templates) {
    const key = `${t.supplier_party_id}:${t.buyer_party_id}`;
    const prev = templateBirth.get(key);
    if (!prev || t.created_day < prev) templateBirth.set(key, t.created_day);
  }

  const groups = new Map<string, EvidenceInvoiceRow[]>();
  for (const r of rows) {
    const key = `${r.supplier_party_id}:${r.buyer_party_id}:${r.currency}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return { groups, templateBirth };
}

// Patterns alerting TODAY under the replay — the draft step's act-now count.
export async function pendingDraftRecurring(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
  data?: RecurringReplayData,
): Promise<number> {
  const { groups, templateBirth } =
    data ?? (await loadRecurringGroups(firmId, asOf, clientPartyId));
  let pendingNow = 0;
  for (const [groupKey, list] of groups) {
    const coveredKey = groupKey.slice(0, groupKey.lastIndexOf(":"));
    const birth = templateBirth.get(coveredKey);
    if (birth && birth <= asOf) continue;
    const lookbackStart = addDays(asOf, -LOOKBACK_DAYS);
    const history: HistoryRow[] = list
      .filter((r) => r.issue_date <= asOf && r.issue_date >= lookbackStart)
      .map((r) => ({
        id: r.id,
        issueDate: r.issue_date,
        grandTotal: Number(r.grand_total),
      }));
    if (patternAlertFor(history, asOf)) pendingNow += 1;
  }
  return pendingNow;
}

async function draftRecurringEvidence(
  firmId: string,
  asOf: string,
  clientPartyId?: string,
): Promise<AutomationEvidenceKind> {
  const data = await loadRecurringGroups(firmId, asOf, clientPartyId);
  const { groups, templateBirth } = data;

  // Replay at each closed month-end; the same expected cycle can alert at
  // two consecutive month-ends, so events dedupe on (group, expectedBy).
  const monthEnds = closedLagosMonthEnds(asOf, EVIDENCE_WINDOW_MONTHS);
  const events = new Map<
    string,
    { groupKey: string; expectedBy: string; lastIssueDate: string }
  >();
  for (const [groupKey, list] of groups) {
    const coveredKey = groupKey.slice(0, groupKey.lastIndexOf(":"));
    const birth = templateBirth.get(coveredKey);
    for (const monthEnd of monthEnds) {
      if (birth && birth <= monthEnd) continue;
      const lookbackStart = addDays(monthEnd, -LOOKBACK_DAYS);
      const history: HistoryRow[] = list
        .filter(
          (r) => r.issue_date <= monthEnd && r.issue_date >= lookbackStart,
        )
        .map((r) => ({
          id: r.id,
          issueDate: r.issue_date,
          grandTotal: Number(r.grand_total),
        }));
      const alert = patternAlertFor(history, monthEnd);
      if (!alert) continue;
      const eventKey = `${groupKey}@${alert.expectedByDate}`;
      if (!events.has(eventKey)) {
        events.set(eventKey, {
          groupKey,
          expectedBy: alert.expectedByDate,
          lastIssueDate: alert.lastIssueDate,
        });
      }
    }
  }

  let agreed = 0;
  let disagreed = 0;
  let pendingHistorical = 0;
  const leadDays: number[] = [];
  for (const ev of events.values()) {
    const list = groups.get(ev.groupKey) ?? [];
    const closeBy = addDays(ev.expectedBy, MAX_OVERDUE_DAYS);
    const raised = list.find(
      (r) => r.issue_date > ev.lastIssueDate && r.issue_date <= closeBy,
    );
    if (raised) {
      agreed += 1;
      leadDays.push(daysBetween(ev.expectedBy, raised.issue_date));
    } else if (asOf > closeBy) {
      disagreed += 1;
    } else {
      // The cycle's window is still open as of today — not evidence yet.
      pendingHistorical += 1;
    }
  }

  // Act-now: patterns alerting TODAY under the same replay (a superset of
  // the still-open historical cycles when a cycle first alerts this month).
  const pendingNow = await pendingDraftRecurring(firmId, asOf, clientPartyId, data);

  return {
    kind: "draft_recurring",
    sample: agreed + disagreed,
    agreed,
    disagreed,
    pending: Math.max(pendingNow, pendingHistorical),
    agreementRate: rate(agreed, disagreed),
    medianLeadDays: leadDays.length
      ? Math.round(median(leadDays) * 10) / 10
      : null,
    exposureFloorNgn: null,
    note: NOTES.draft_recurring,
  };
}

// `now` is injectable (the computeComplianceCalendar precedent) so tests
// replay against a frozen instant; production callers take the default.
// `clientPartyId` narrows every cohort to one client (Phase 2 — the grant
// dialogs); omitted, the report is firm-wide (the portfolio card).
export async function computeAutomationEvidence(
  firmId: string,
  now: Date = new Date(),
  clientPartyId?: string,
): Promise<AutomationEvidence> {
  const asOf = lagosDateString(now);
  const kinds = [
    await reconcileEvidence(firmId, asOf, clientPartyId),
    await submitOverdueEvidence(firmId, asOf, clientPartyId),
    await retryFailedEvidence(firmId, asOf, clientPartyId),
    await draftRecurringEvidence(firmId, asOf, clientPartyId),
  ];
  return { windowMonths: EVIDENCE_WINDOW_MONTHS, asOf, kinds };
}

// The digest's weekly shadow number (Phase 3): what the DARK automation
// kinds would act on today, and nothing else — no backtest, no month-end
// replay beyond the one act-now pass. Null when every governing switch is
// lit (there is no shadow to report — the rollup and effectiveness surfaces
// own the lit story). The flag pairs mirror the executors exactly:
// clerk_actions governs the act catalogue; reconciliation AND
// clerk_auto_reconcile govern the settle step (plan-steps' own rule).
export async function computeAutomationShadowPending(
  firmId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const asOf = lagosDateString(now);
  const actionsLit = await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId);
  const reconcileLit =
    (await isFeatureEnabled("reconciliation", firmId)) &&
    (await isFeatureEnabled(AUTO_RECONCILE_FLAG_KEY, firmId));
  if (actionsLit && reconcileLit) return null;
  let total = 0;
  if (!actionsLit) {
    total += await pendingSubmitOverdue(firmId, asOf);
    total += await pendingRetryFailed(firmId);
    total += await pendingDraftRecurring(firmId, asOf);
  }
  if (!reconcileLit) {
    total += await pendingReconcileMatches(firmId);
  }
  return total;
}
