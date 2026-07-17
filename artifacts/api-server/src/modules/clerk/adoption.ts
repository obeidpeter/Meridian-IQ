import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Adoption & impact report (round-10 idea #3). The unit-economics page
// answers "what does Clerk cost the platform"; this answers the firm-side
// question a partner takes into a renewal conversation: which clients
// actually USE Clerk intake, how much of what it reads is kept unchanged,
// and how fast documents clear review. Pure SQL over the firm's own cases —
// zero model calls, computed on demand, nothing stored.
//
// Attribution: a case is credited to the client whose APPROVED invoice it
// created (created_invoice_id → supplier party) — the only join that is
// deterministic for every capture path (client uploads, staff captures,
// batch segments alike). Cases that never reached approval count in the
// firm totals, not against a client.

export const ADOPTION_DEFAULT_WINDOW_DAYS = 90;

export interface AdoptionClientRow {
  clientPartyId: string;
  clientName: string;
  approvedCases: number;
  fieldsCompared: number;
  fieldsKept: number;
  keptRate: number;
  avgReviewMinutes: number | null;
  lastApprovedAt: string;
}

export interface AdoptionReport {
  windowDays: number;
  totals: {
    extractionCases: number;
    approvedCases: number;
    approvedShare: number;
    keptRate: number;
  };
  clients: AdoptionClientRow[];
}

const rate = (num: number, den: number): number =>
  den === 0 ? 0 : Number((num / den).toFixed(4));

export async function computeAdoptionReport(
  firmId: string,
  windowDays: number = ADOPTION_DEFAULT_WINDOW_DAYS,
): Promise<AdoptionReport> {
  const db = getDb();
  const totalsRows = (
    await db.execute<{
      extraction_cases: number;
      approved_cases: number;
    }>(sql`
      SELECT
        COUNT(*)::int AS extraction_cases,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_cases
      FROM clerk_cases
      WHERE kind = 'extraction'
        AND firm_id = ${firmId}
        AND created_at >= now() - make_interval(days => ${windowDays})
    `)
  ).rows;

  const clientRows = (
    await db.execute<{
      client_party_id: string;
      client_name: string;
      approved_cases: number;
      fields: number;
      kept: number;
      avg_minutes: string | null;
      last_approved: string;
    }>(sql`
      SELECT
        i.supplier_party_id AS client_party_id,
        p.legal_name AS client_name,
        COUNT(*)::int AS approved_cases,
        COALESCE(SUM(jsonb_array_length(c.corrections)) FILTER (
          WHERE c.corrections IS NOT NULL
        ), 0)::int AS fields,
        COALESCE(SUM((
          SELECT COUNT(*) FROM jsonb_array_elements(c.corrections) x
          WHERE NOT (x->>'changed')::boolean
        )) FILTER (WHERE c.corrections IS NOT NULL), 0)::int AS kept,
        -- Same turnaround expression as metrics.avgDecisionMinutes:
        -- updated_at is the decision write on a decided case.
        AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) / 60.0)
          AS avg_minutes,
        MAX(c.updated_at)::text AS last_approved
      FROM clerk_cases c
      JOIN invoices i ON i.id = c.created_invoice_id
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE c.kind = 'extraction'
        AND c.status = 'approved'
        AND c.firm_id = ${firmId}
        AND c.created_at >= now() - make_interval(days => ${windowDays})
      GROUP BY 1, 2
      ORDER BY approved_cases DESC, client_name ASC
      LIMIT 200
    `)
  ).rows;

  const extractionCases = Number(totalsRows[0]?.extraction_cases ?? 0);
  const approvedCases = Number(totalsRows[0]?.approved_cases ?? 0);
  const totalFields = clientRows.reduce((s, r) => s + Number(r.fields), 0);
  const totalKept = clientRows.reduce((s, r) => s + Number(r.kept), 0);

  return {
    windowDays,
    totals: {
      extractionCases,
      approvedCases,
      approvedShare: rate(approvedCases, extractionCases),
      keptRate: rate(totalKept, totalFields),
    },
    clients: clientRows.map((r) => ({
      clientPartyId: r.client_party_id,
      clientName: r.client_name,
      approvedCases: Number(r.approved_cases),
      fieldsCompared: Number(r.fields),
      fieldsKept: Number(r.kept),
      keptRate: rate(Number(r.kept), Number(r.fields)),
      avgReviewMinutes:
        r.avg_minutes != null
          ? Number(Number(r.avg_minutes).toFixed(1))
          : null,
      lastApprovedAt: r.last_approved,
    })),
  };
}
