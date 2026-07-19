import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Draft-time rejection risk: the firm's own recent rejected submission
// attempts joined to THIS draft's supplier and buyer parties (plus the firm's
// remaining top codes), grounded in the error catalogue — the aggregate
// history the rejection-pattern report shows the partner, replayed at the
// moment it can still change the outcome: before submission. Deterministic,
// pure SQL, zero model calls, nothing stored, computed on demand. Signals
// name HISTORY ("this supplier hit TIN-01 three times in 90 days"), never
// predictions. The invoice's own attempts deliberately count — history is
// history, and a resubmission after two rejections should say so.

const WINDOW_DAYS = 90;
const TOP_PER_SCOPE = 5;

export type RejectionRiskScope = "supplier" | "buyer" | "firm";

export interface RejectionRiskSignal {
  errorCode: string;
  scope: RejectionRiskScope;
  // Rejected attempts inside the window, within the scope's predicate.
  count: number;
  // Max created_at inside the scope's predicate, ISO.
  lastSeen: string;
  // Catalogue grounding; null when the code is unmapped (COALESCEd to
  // 'UNMAPPED' like the rejection-pattern report — the catalogue-drafting
  // queue's feedstock).
  category: string | null;
  cause: string | null;
  fix: string | null;
  retriable: boolean | null;
}

export interface RejectionRiskReport {
  windowDays: number;
  // Firm-wide rejected attempts in the window, independent of the per-scope
  // caps below.
  totalRejections: number;
  // Ordered supplier → buyer → firm, count desc within each scope. The firm
  // scope excludes codes already surfaced by the supplier/buyer scopes;
  // supplier and buyer may both surface the same code (different counts).
  signals: RejectionRiskSignal[];
}

// Type literal (not an interface) so it satisfies execute()'s
// Record<string, unknown> constraint via the implicit index signature.
type RiskRow = {
  error_code: string;
  category: string | null;
  cause: string | null;
  fix: string | null;
  retriable: boolean | null;
  firm_n: number;
  supplier_n: number;
  buyer_n: number;
  last_seen: string | null;
  supplier_last_seen: string | null;
  buyer_last_seen: string | null;
};

function toIso(t: string | null): string {
  return t ? new Date(t).toISOString() : "";
}

export async function computeRejectionRisk(invoice: {
  id: string;
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
}): Promise<RejectionRiskReport> {
  // One pass over the firm's window: per-code firm-wide counts with FILTERed
  // supplier/buyer sub-counts (and per-scope last-seen), so the three scopes
  // can never disagree about what happened. Catalogue join + UNMAPPED fold
  // follow the rejection-pattern report exactly.
  const rows = (
    await getDb().execute<RiskRow>(sql`
      SELECT
        COALESCE(sa.error_code, 'UNMAPPED') AS error_code,
        MIN(ec.category) AS category,
        MIN(ec.cause) AS cause,
        MIN(ec.fix) AS fix,
        bool_or(ec.retriable) AS retriable,
        COUNT(*)::int AS firm_n,
        COUNT(*) FILTER (
          WHERE i.supplier_party_id = ${invoice.supplierPartyId}
        )::int AS supplier_n,
        COUNT(*) FILTER (
          WHERE i.buyer_party_id = ${invoice.buyerPartyId}
        )::int AS buyer_n,
        MAX(sa.created_at)::text AS last_seen,
        MAX(sa.created_at) FILTER (
          WHERE i.supplier_party_id = ${invoice.supplierPartyId}
        )::text AS supplier_last_seen,
        MAX(sa.created_at) FILTER (
          WHERE i.buyer_party_id = ${invoice.buyerPartyId}
        )::text AS buyer_last_seen
      FROM submission_attempts sa
      JOIN invoices i ON i.id = sa.invoice_id
      LEFT JOIN error_catalogue ec ON ec.code = sa.error_code
      WHERE i.firm_id = ${invoice.firmId}
        AND sa.status = 'rejected'
        AND sa.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
      GROUP BY COALESCE(sa.error_code, 'UNMAPPED')
    `)
  ).rows;

  const signal = (
    r: RiskRow,
    scope: RejectionRiskScope,
    count: number,
    lastSeen: string | null,
  ): RejectionRiskSignal => ({
    errorCode: r.error_code,
    scope,
    count,
    lastSeen: toIso(lastSeen),
    category: r.category,
    cause: r.cause,
    fix: r.fix,
    retriable: r.retriable,
  });

  // Count desc within a scope; code asc keeps ties deterministic.
  const byCount = (count: (r: RiskRow) => number) => (a: RiskRow, b: RiskRow) =>
    count(b) - count(a) || a.error_code.localeCompare(b.error_code);

  const supplier = rows
    .filter((r) => Number(r.supplier_n) > 0)
    .sort(byCount((r) => Number(r.supplier_n)))
    .slice(0, TOP_PER_SCOPE)
    .map((r) => signal(r, "supplier", Number(r.supplier_n), r.supplier_last_seen));
  const buyer = rows
    .filter((r) => Number(r.buyer_n) > 0)
    .sort(byCount((r) => Number(r.buyer_n)))
    .slice(0, TOP_PER_SCOPE)
    .map((r) => signal(r, "buyer", Number(r.buyer_n), r.buyer_last_seen));
  // Firm scope is the residue: firm-wide top codes NOT already surfaced above
  // — the same code repeated per scope would read as three separate problems.
  const surfaced = new Set([...supplier, ...buyer].map((s) => s.errorCode));
  const firm = rows
    .filter((r) => !surfaced.has(r.error_code))
    .sort(byCount((r) => Number(r.firm_n)))
    .slice(0, TOP_PER_SCOPE)
    .map((r) => signal(r, "firm", Number(r.firm_n), r.last_seen));

  return {
    windowDays: WINDOW_DAYS,
    totalRejections: rows.reduce((acc, r) => acc + Number(r.firm_n), 0),
    signals: [...supplier, ...buyer, ...firm],
  };
}
