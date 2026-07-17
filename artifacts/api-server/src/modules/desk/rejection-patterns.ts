import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Rejection-pattern report (round-4 idea #3). The desk sees rejections one
// case at a time; nobody sees that one firm hit the same rail code eleven
// times this month across four clients. This aggregates the firm's OWN
// rejected submission attempts into recurring causes — pure SQL, zero model
// calls, nothing stored, computed on demand. The catalogue supplies the
// cause/fix text (the same playbook the operator queue shows), and a prior
// window of equal length rides along so the card can show a trend without a
// second request.

const WINDOW_DAYS = 30;
const MAX_ROWS = 20;

export interface RejectionPatternRow {
  errorCode: string;
  // Catalogue grounding; null when the code is unmapped (which is itself
  // useful — it's the catalogue-drafting queue's feedstock).
  category: string | null;
  cause: string | null;
  fix: string | null;
  retriable: boolean | null;
  // Rejected attempts in the current window.
  count: number;
  invoiceCount: number;
  clientCount: number;
  // Rejected attempts in the equal-length window before it (trend basis).
  previousCount: number;
  lastSeen: string;
}

export interface RejectionPatternReport {
  windowDays: number;
  totalRejections: number;
  previousTotal: number;
  rows: RejectionPatternRow[];
}

export async function computeRejectionPatterns(
  firmId: string,
): Promise<RejectionPatternReport> {
  const rows = (
    await getDb().execute<{
      error_code: string;
      category: string | null;
      cause: string | null;
      fix: string | null;
      retriable: boolean | null;
      n: number;
      invoice_n: number;
      client_n: number;
      prev_n: number;
      last_seen: string;
    }>(sql`
      SELECT
        COALESCE(sa.error_code, 'UNMAPPED') AS error_code,
        MIN(ec.category) AS category,
        MIN(ec.cause) AS cause,
        MIN(ec.fix) AS fix,
        bool_or(ec.retriable) AS retriable,
        COUNT(*) FILTER (
          WHERE sa.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
        )::int AS n,
        COUNT(DISTINCT sa.invoice_id) FILTER (
          WHERE sa.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
        )::int AS invoice_n,
        COUNT(DISTINCT i.supplier_party_id) FILTER (
          WHERE sa.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
        )::int AS client_n,
        COUNT(*) FILTER (
          WHERE sa.created_at < now() - make_interval(days => ${WINDOW_DAYS})
        )::int AS prev_n,
        MAX(sa.created_at)::text AS last_seen
      FROM submission_attempts sa
      JOIN invoices i ON i.id = sa.invoice_id
      LEFT JOIN error_catalogue ec ON ec.code = sa.error_code
      WHERE i.firm_id = ${firmId}
        AND sa.status = 'rejected'
        AND sa.created_at >= now() - make_interval(days => ${WINDOW_DAYS * 2})
      GROUP BY COALESCE(sa.error_code, 'UNMAPPED')
      ORDER BY n DESC, prev_n DESC
      LIMIT ${MAX_ROWS}
    `)
  ).rows;

  const mapped: RejectionPatternRow[] = rows
    .map((r) => ({
      errorCode: r.error_code,
      category: r.category,
      cause: r.cause,
      fix: r.fix,
      retriable: r.retriable,
      count: Number(r.n),
      invoiceCount: Number(r.invoice_n),
      clientCount: Number(r.client_n),
      previousCount: Number(r.prev_n),
      lastSeen: r.last_seen,
    }))
    // A code seen only in the PRIOR window still matters (it shows a fixed
    // problem), but only when something remains to compare against; rows with
    // zero in both windows cannot exist by the WHERE above.
    .filter((r) => r.count > 0 || r.previousCount > 0);

  return {
    windowDays: WINDOW_DAYS,
    totalRejections: mapped.reduce((sum, r) => sum + r.count, 0),
    previousTotal: mapped.reduce((sum, r) => sum + r.previousCount, 0),
    rows: mapped,
  };
}
