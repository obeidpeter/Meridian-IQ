import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { lagosMonthStart, monthLabel } from "../clerk/client-statement";
import { computeVatPack } from "../clerk/vat-pack";
import { OUTSTANDING } from "../invoice/receivables";

// Quarterly review pack (round-13 idea #4). The platform already computes
// every number a partner wants for a quarterly client-book review — the VAT
// pack, rejection causes, receivables, Clerk throughput — but scattered
// across surfaces and mostly on monthly windows. This assembles ONE per-firm
// document for a CLOSED Lagos quarter, deterministic end to end, computed on
// demand, nothing stored. Where a monthly surface already owns a number, the
// pack calls the SAME computation (computeVatPack per month, the OUTSTANDING
// receivables fragment) so the quarterly view can never disagree with the
// monthly one. The receivables snapshot is as-of-generation (a balance has
// no quarter), split per currency so a foreign-currency book is never summed
// into naira.

export interface QuarterlyReviewMonth {
  monthStart: string;
  monthLabel: string;
  acceptedCount: number;
  acceptedVat: string;
  creditVat: string;
  netVat: string;
}

export interface QuarterlyRejectionRow {
  errorCode: string;
  category: string | null;
  count: number;
}

export interface QuarterlyReview {
  quarterStart: string;
  quarterLabel: string;
  // The closed Lagos quarters a review may be requested for (newest first) —
  // the picker's CLOSED option list; a quarter outside it is refused.
  quarters: string[];
  months: QuarterlyReviewMonth[];
  vatTotals: {
    acceptedCount: number;
    creditCount: number;
    acceptedVat: string;
    creditVat: string;
    netVat: string;
  };
  submissions: { accepted: number; rejected: number };
  // Top rejection codes in the quarter (capped); the total comes from the
  // SAME SQL pass so it stays honest beyond the cap.
  topRejections: QuarterlyRejectionRow[];
  rejectionTotal: number;
  receivables: {
    asOf: string;
    groups: { currency: string; outstandingTotal: string; invoiceCount: number }[];
  };
  clerk: { captures: number; approved: number; rejected: number };
  note: string;
}

const QUARTER_COUNT = 4;
const MAX_REJECTION_ROWS = 5;

// First month of each closed Lagos quarter on offer, newest first
// ("YYYY-MM-01"). A quarter is closed once all three of its months are.
export function closedLagosQuarters(
  count = QUARTER_COUNT,
  now: Date = new Date(),
): string[] {
  const [y, m] = lagosMonthStart(0, now).split("-").map(Number);
  const currentQuarterFirstMonth = m - ((m - 1) % 3);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, currentQuarterFirstMonth - 1 - 3 * (i + 1), 1));
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${d.getUTCFullYear()}-${mm}-01`;
  });
}

// The three month starts of a quarter, in order.
export function quarterMonths(quarterStart: string): string[] {
  const [y, m] = quarterStart.split("-").map(Number);
  return [0, 1, 2].map((i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${d.getUTCFullYear()}-${mm}-01`;
  });
}

// "2026-04-01" -> "Q2 2026 (April – June)".
export function quarterLabel(quarterStart: string): string {
  const [y, m] = quarterStart.split("-").map(Number);
  const months = quarterMonths(quarterStart);
  const first = monthLabel(months[0]).split(" ")[0];
  const last = monthLabel(months[2]).split(" ")[0];
  return `Q${Math.floor((m - 1) / 3) + 1} ${y} (${first} – ${last})`;
}

// Lagos-calendar quarter window on a timestamptz column aliased in scope.
function lagosQuarterWindow(column: ReturnType<typeof sql>, quarterStart: string) {
  return sql`${column} >= (${quarterStart}::timestamp AT TIME ZONE 'Africa/Lagos')
    AND ${column} < ((${quarterStart}::date + interval '3 months')::timestamp AT TIME ZONE 'Africa/Lagos')`;
}

const money = (n: number) => n.toFixed(2);

export async function computeQuarterlyReview(
  firmId: string,
  quarterStart: string,
): Promise<QuarterlyReview> {
  const db = getDb();
  const label = quarterLabel(quarterStart);

  // VAT per month: the SAME computation the monthly pack runs, so the two
  // surfaces cannot disagree; the quarter totals are the sum of its months.
  const months: QuarterlyReviewMonth[] = [];
  let creditCount = 0;
  for (const monthStart of quarterMonths(quarterStart)) {
    const pack = await computeVatPack(firmId, monthStart);
    creditCount += pack.totals.creditCount;
    months.push({
      monthStart,
      monthLabel: pack.monthLabel,
      acceptedCount: pack.totals.acceptedCount,
      acceptedVat: pack.totals.acceptedVat,
      creditVat: pack.totals.creditVat,
      netVat: pack.totals.netVat,
    });
  }
  const vatTotals = {
    acceptedCount: months.reduce((s, m) => s + m.acceptedCount, 0),
    creditCount,
    acceptedVat: money(months.reduce((s, m) => s + Number(m.acceptedVat), 0)),
    creditVat: money(months.reduce((s, m) => s + Number(m.creditVat), 0)),
    netVat: money(months.reduce((s, m) => s + Number(m.netVat), 0)),
  };

  // Submission outcomes inside the quarter (Lagos boundaries on attempt time).
  const [attemptRow] = (
    await db.execute<{ accepted: number; rejected: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE sa.status = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE sa.status = 'rejected')::int AS rejected
      FROM submission_attempts sa
      JOIN invoices i ON i.id = sa.invoice_id
      WHERE i.firm_id = ${firmId}
        AND ${lagosQuarterWindow(sql`sa.created_at`, quarterStart)}
    `)
  ).rows;

  // Top rejection codes — GROUPING SETS so the quarter total never deflates
  // when more codes exist than the row cap keeps (the vat-pack pattern).
  const rejectionRows = (
    await db.execute<{
      error_code: string | null;
      category: string | null;
      n: number;
      is_total: number;
    }>(sql`
      SELECT
        COALESCE(sa.error_code, 'UNMAPPED') AS error_code,
        MIN(ec.category) AS category,
        COUNT(*)::int AS n,
        GROUPING(COALESCE(sa.error_code, 'UNMAPPED'))::int AS is_total
      FROM submission_attempts sa
      JOIN invoices i ON i.id = sa.invoice_id
      LEFT JOIN error_catalogue ec ON ec.code = sa.error_code
      WHERE i.firm_id = ${firmId}
        AND sa.status = 'rejected'
        AND ${lagosQuarterWindow(sql`sa.created_at`, quarterStart)}
      GROUP BY GROUPING SETS ((COALESCE(sa.error_code, 'UNMAPPED')), ())
      ORDER BY GROUPING(COALESCE(sa.error_code, 'UNMAPPED')) DESC, n DESC
      LIMIT ${MAX_REJECTION_ROWS + 1}
    `)
  ).rows;
  const rejectionTotalRow = rejectionRows.find((r) => Number(r.is_total) === 1);
  const topRejections: QuarterlyRejectionRow[] = rejectionRows
    .filter((r) => Number(r.is_total) === 0 && r.error_code !== null)
    .map((r) => ({
      errorCode: r.error_code!,
      category: r.category,
      count: Number(r.n),
    }));

  // Receivables snapshot as of NOW (a balance has no quarter), per currency —
  // the receivables OUTSTANDING definition exactly.
  const receivableRows = (
    await db.execute<{ currency: string; n: number; total: string }>(sql`
      SELECT i.currency, COUNT(*)::int AS n,
        SUM(i.grand_total)::numeric(18,2)::text AS total
      FROM invoices i
      WHERE ${OUTSTANDING} AND i.firm_id = ${firmId}
      GROUP BY i.currency
      ORDER BY SUM(i.grand_total) DESC
    `)
  ).rows;

  // Clerk throughput: extraction cases OPENED in the quarter and how they
  // were decided (a case opened in the quarter and decided after still counts
  // as a capture of this quarter).
  const [clerkRow] = (
    await db.execute<{ captures: number; approved: number; rejected: number }>(sql`
      SELECT
        COUNT(*)::int AS captures,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
      FROM clerk_cases
      WHERE firm_id = ${firmId}
        AND kind = 'extraction'
        AND ${lagosQuarterWindow(sql`created_at`, quarterStart)}
    `)
  ).rows;

  return {
    quarterStart,
    quarterLabel: label,
    quarters: closedLagosQuarters(),
    months,
    vatTotals,
    submissions: {
      accepted: Number(attemptRow?.accepted ?? 0),
      rejected: Number(attemptRow?.rejected ?? 0),
    },
    topRejections,
    rejectionTotal: Number(rejectionTotalRow?.n ?? 0),
    receivables: {
      asOf: lagosDateString(),
      groups: receivableRows.map((r) => ({
        currency: r.currency,
        outstandingTotal: String(r.total),
        invoiceCount: Number(r.n),
      })),
    },
    clerk: {
      captures: Number(clerkRow?.captures ?? 0),
      approved: Number(clerkRow?.approved ?? 0),
      rejected: Number(clerkRow?.rejected ?? 0),
    },
    note:
      `Quarterly review for ${label}, Lagos calendar. VAT figures are the monthly VAT filing packs summed (issue-month basis, rails-accepted documents, credits netted, cancelled excluded — corrections are NOT netted). ` +
      `Submission and rejection counts cover attempts made in the quarter; the receivables snapshot is as of generation, per currency, not a quarter figure. ` +
      `This is a review aid, not a filing or an engagement report. Generated ${lagosDateString()}.`,
  };
}
