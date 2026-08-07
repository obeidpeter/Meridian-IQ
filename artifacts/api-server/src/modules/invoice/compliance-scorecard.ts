import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString, lagosTodaySql } from "../../lib/lagos-time";
import {
  SUBMISSION_WINDOW_DAYS,
  UNSUBMITTED_STATE,
  pastSubmissionDeadline,
} from "./compliance-window";
import {
  RECEIVABLE_ORIENTATION,
  BILL_ORIENTATION,
  LIVE_ENGAGEMENT,
} from "./receivables";

// Client compliance scorecard (round-19 idea #3). Firms see per-client
// detail everywhere but have no cross-client view of where their attention
// is needed. This is that view: one deterministic league table over the
// firm's ENGAGED clients, trailing-window posture only — pure SQL, nothing
// stored, no model anywhere near it. Framed as posture, not blame: rates
// honour a sample floor (a client with two invoices has no meaningful
// rate), and the note pins that a low score is a to-do list, not a verdict.

const WINDOW_DAYS = 90;
// Below this many observations a rate is null, never a scary 0% — the
// 3-sample floor every other report uses.
const MIN_RATE_SAMPLE = 3;
const MAX_ROWS = 200;

export interface ScorecardRow {
  clientPartyId: string;
  clientName: string;
  issuedCount: number;
  acceptedCount: number;
  // Share of rail-accepted invoices whose FIRST acceptance landed inside
  // the statutory submission window (0..1). Null under the sample floor.
  withinWindowRate: number | null;
  // Share of invoices with any submission attempt that saw a rejection or
  // error (0..1). Null under the sample floor.
  failureRate: number | null;
  // The same two rates over the window BEFORE (issue dates in
  // [today-2w, today-w)), same floors — the trend's baseline. Null means
  // "no meaningful prior sample", not "was perfect".
  prevWithinWindowRate: number | null;
  prevFailureRate: number | null;
  // Median days from issue to first rail acceptance. Null when nothing was
  // accepted in the window.
  medianDaysToStamp: number | null;
  // Overdue right now (the digest predicate) — not windowed: overdue paper
  // from any month is today's problem.
  overdueNow: number;
  // Bills captured in the window with no stamp verification recorded — the
  // input-VAT posture gap.
  unverifiedBills: number;
}

export interface ComplianceScorecard {
  asOf: string;
  windowDays: number;
  rows: ScorecardRow[];
  note: string;
}

export async function computeComplianceScorecard(
  firmId: string,
  now: Date = new Date(),
): Promise<ComplianceScorecard> {
  const db = getDb();
  const today = lagosTodaySql();

  // Receivable posture per client over the window: issued volume, first
  // rail acceptance (and whether it landed inside the statutory window),
  // failure share, and the current overdue count — plus the SAME rate
  // metrics over the window BEFORE (round-20 trend: direction turns the
  // league table from "who's bad" into "who's slipping"). One pass: the
  // invoice scan covers 2× the window with a `recent` flag and every
  // current aggregate FILTERs on it.
  const receivableRows = (
    await db.execute<{
      client_party_id: string;
      client_name: string;
      issued: number;
      accepted: number;
      within_window: number;
      attempted: number;
      failed: number;
      prev_accepted: number;
      prev_within: number;
      prev_attempted: number;
      prev_failed: number;
      median_days: string | null;
      overdue_now: number;
    }>(sql`
      WITH engaged AS (
        SELECT DISTINCT e.client_party_id
        FROM engagements e
        WHERE e.firm_id = ${firmId} AND ${LIVE_ENGAGEMENT}
      ),
      window_invoices AS (
        SELECT i.id, i.supplier_party_id, i.issue_date,
          (i.issue_date >= ${today} - ${WINDOW_DAYS}::int) AS recent
        FROM invoices i
        WHERE i.firm_id = ${firmId}
          AND i.kind = 'invoice'
          AND ${RECEIVABLE_ORIENTATION}
          AND i.supplier_party_id IN (SELECT client_party_id FROM engaged)
          AND i.issue_date >= ${today} - ${2 * WINDOW_DAYS}::int
      ),
      first_accepted AS (
        SELECT sa.invoice_id,
          MIN((sa.created_at AT TIME ZONE 'Africa/Lagos')::date) AS accepted_date
        FROM submission_attempts sa
        WHERE sa.invoice_id IN (SELECT id FROM window_invoices)
          AND sa.status = 'accepted'
        GROUP BY 1
      ),
      attempt_posture AS (
        SELECT sa.invoice_id,
          BOOL_OR(sa.status IN ('rejected', 'error')) AS saw_failure
        FROM submission_attempts sa
        WHERE sa.invoice_id IN (SELECT id FROM window_invoices)
        GROUP BY 1
      ),
      overdue_now AS (
        SELECT i.supplier_party_id, COUNT(*)::int AS n
        FROM invoices i
        WHERE i.firm_id = ${firmId}
          AND i.kind = 'invoice'
          AND ${UNSUBMITTED_STATE}
          AND ${RECEIVABLE_ORIENTATION}
          AND ${pastSubmissionDeadline(today)}
        GROUP BY 1
      )
      SELECT
        eng.client_party_id,
        p.legal_name AS client_name,
        COUNT(wi.id) FILTER (WHERE wi.recent)::int AS issued,
        COUNT(fa.invoice_id) FILTER (WHERE wi.recent)::int AS accepted,
        -- Strict <: the canonical deadline (compliance-window.ts) is Lagos
        -- MIDNIGHT AT THE START of day issue+window, and the overdue
        -- predicate below flips overdue when issue + window <= today — an
        -- acceptance ON day 7 is late, and the two columns of one row must
        -- never disagree about the same invoice.
        COUNT(fa.invoice_id) FILTER (
          WHERE wi.recent
            AND fa.accepted_date < wi.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
        )::int AS within_window,
        COUNT(ap.invoice_id) FILTER (WHERE wi.recent)::int AS attempted,
        COUNT(ap.invoice_id) FILTER (WHERE wi.recent AND ap.saw_failure)::int AS failed,
        COUNT(fa.invoice_id) FILTER (WHERE NOT wi.recent)::int AS prev_accepted,
        COUNT(fa.invoice_id) FILTER (
          WHERE NOT wi.recent
            AND fa.accepted_date < wi.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
        )::int AS prev_within,
        COUNT(ap.invoice_id) FILTER (WHERE NOT wi.recent)::int AS prev_attempted,
        COUNT(ap.invoice_id) FILTER (WHERE NOT wi.recent AND ap.saw_failure)::int AS prev_failed,
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY (fa.accepted_date - wi.issue_date)
        ) FILTER (WHERE wi.recent))::text AS median_days,
        COALESCE(MAX(od.n), 0)::int AS overdue_now
      FROM engaged eng
      JOIN parties p ON p.id = eng.client_party_id
      LEFT JOIN window_invoices wi ON wi.supplier_party_id = eng.client_party_id
      LEFT JOIN first_accepted fa ON fa.invoice_id = wi.id
      LEFT JOIN attempt_posture ap ON ap.invoice_id = wi.id
      LEFT JOIN overdue_now od ON od.supplier_party_id = eng.client_party_id
      WHERE p.merged_into_id IS NULL
      GROUP BY 1, 2
      -- Attention-first INSIDE the query, so a book past MAX_ROWS drops its
      -- calmest tail — never an arbitrary plan-dependent subset that could
      -- silently omit the very clients the table exists to surface. The JS
      -- sort below re-applies the same keys to the retained set, including
      -- the sample floor mirrored in the CASE (a sub-floor rate is "no
      -- rate", sorted last, exactly like the null the row will carry).
      ORDER BY COALESCE(MAX(od.n), 0) DESC,
        CASE
          WHEN COUNT(fa.invoice_id) FILTER (WHERE wi.recent) >= ${MIN_RATE_SAMPLE} THEN
            (COUNT(fa.invoice_id) FILTER (
              WHERE wi.recent
                AND fa.accepted_date < wi.issue_date + ${SUBMISSION_WINDOW_DAYS}::int
            ))::float / (COUNT(fa.invoice_id) FILTER (WHERE wi.recent))
          ELSE 2
        END ASC,
        p.legal_name
      LIMIT ${MAX_ROWS}
    `)
  ).rows;

  // Payables posture per client: captured bills in the window without a
  // stamp verification — the client is the BUYER here (bill orientation).
  const billRows = (
    await db.execute<{ buyer_party_id: string; unverified: number }>(sql`
      SELECT i.buyer_party_id, COUNT(*)::int AS unverified
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND ${BILL_ORIENTATION}
        -- The one bill status with meaning (vat-position.ts): a cancelled
        -- mis-capture is not a posture gap.
        AND i.status <> 'cancelled'
        AND i.issue_date >= ${today} - ${WINDOW_DAYS}::int
        AND NOT EXISTS (
          SELECT 1 FROM bill_verifications bv WHERE bv.invoice_id = i.id
        )
      GROUP BY 1
    `)
  ).rows;
  const unverifiedByClient = new Map(
    billRows.map((r) => [r.buyer_party_id, Number(r.unverified)]),
  );

  const rows: ScorecardRow[] = receivableRows.map((r) => {
    const accepted = Number(r.accepted);
    const attempted = Number(r.attempted);
    const prevAccepted = Number(r.prev_accepted);
    const prevAttempted = Number(r.prev_attempted);
    return {
      clientPartyId: r.client_party_id,
      clientName: r.client_name,
      issuedCount: Number(r.issued),
      acceptedCount: accepted,
      withinWindowRate:
        accepted >= MIN_RATE_SAMPLE
          ? Number(r.within_window) / accepted
          : null,
      failureRate:
        attempted >= MIN_RATE_SAMPLE ? Number(r.failed) / attempted : null,
      prevWithinWindowRate:
        prevAccepted >= MIN_RATE_SAMPLE
          ? Number(r.prev_within) / prevAccepted
          : null,
      prevFailureRate:
        prevAttempted >= MIN_RATE_SAMPLE
          ? Number(r.prev_failed) / prevAttempted
          : null,
      medianDaysToStamp:
        r.median_days !== null ? Number(r.median_days) : null,
      overdueNow: Number(r.overdue_now),
      unverifiedBills: unverifiedByClient.get(r.client_party_id) ?? 0,
    };
  });

  // Attention first: current overdue paper, then the weakest window rate
  // (nulls last — no sample is not a bad sample), then name for stability.
  rows.sort((a, b) => {
    if (b.overdueNow !== a.overdueNow) return b.overdueNow - a.overdueNow;
    const ar = a.withinWindowRate ?? 2;
    const br = b.withinWindowRate ?? 2;
    if (ar !== br) return ar - br;
    return a.clientName.localeCompare(b.clientName);
  });

  return {
    asOf: lagosDateString(now),
    windowDays: WINDOW_DAYS,
    rows,
    note:
      `Posture over the trailing ${WINDOW_DAYS} days for clients with a live engagement — a prioritization aid, not a verdict. ` +
      `Rates need ${MIN_RATE_SAMPLE}+ observations (fewer shows as no rate); "overdue now" counts all overdue paper regardless of age; ` +
      `trend arrows compare against the ${WINDOW_DAYS} days before, under the same floors. ` +
      `A low score is a to-do list: submit the overdue paper, retry the failures, verify the captured bills.`,
  };
}
