import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { lagosMonthStart, monthLabel } from "./client-statement";

// Monthly VAT filing pack (exhaust idea #2). The per-client statement
// machinery already computes exactly what a VAT return wants — output VAT per
// client per closed Lagos month, from rails-ACCEPTED invoices. This is the
// firm-level view of the same facts: one table (client × accepted count ×
// total × VAT) plus firm totals, computed ON DEMAND with the same predicates
// as the statements and the Ask Clerk data intents, so the pack can never
// disagree with either. Deliberately model-free end to end — a filing
// artifact should be deterministic, not paraphrased — and nothing is stored.

export interface VatPackRow {
  clientPartyId: string;
  clientName: string;
  acceptedCount: number;
  acceptedTotal: string;
  acceptedVat: string;
}

export interface VatPack {
  monthStart: string;
  monthLabel: string;
  // The closed Lagos months a pack may be requested for (newest first) — the
  // month picker's CLOSED option list; a month outside it is refused.
  months: string[];
  rows: VatPackRow[];
  totals: {
    acceptedCount: number;
    acceptedTotal: string;
    acceptedVat: string;
  };
  note: string;
}

export const VAT_PACK_MONTHS = 12;

// The closed Lagos months on offer, newest first ("YYYY-MM-01").
export function closedLagosMonths(
  count = VAT_PACK_MONTHS,
  now: Date = new Date(),
): string[] {
  return Array.from({ length: count }, (_, i) => lagosMonthStart(i + 1, now));
}

export async function computeVatPack(
  firmId: string,
  monthStart: string,
): Promise<VatPack> {
  const rows = (
    await getDb().execute<{
      client_party_id: string;
      client_name: string;
      n: number;
      total: string;
      vat: string;
    }>(sql`
      SELECT
        i.supplier_party_id AS client_party_id,
        p.legal_name AS client_name,
        COUNT(*)::int AS n,
        COALESCE(SUM(i.grand_total), 0)::text AS total,
        COALESCE(SUM(i.vat_total), 0)::text AS vat
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE i.kind = 'invoice'
        AND i.firm_id = ${firmId}
        -- Accepted by the rails DURING the month (Lagos calendar) — the same
        -- predicate as the per-client statements and data.submitted_this_month.
        AND EXISTS (
          SELECT 1 FROM submission_attempts sa
          WHERE sa.invoice_id = i.id
            AND sa.status = 'accepted'
            AND sa.created_at AT TIME ZONE 'Africa/Lagos' >= ${monthStart}::timestamp
            AND sa.created_at AT TIME ZONE 'Africa/Lagos' < ${monthStart}::timestamp + interval '1 month'
        )
      GROUP BY i.supplier_party_id, p.legal_name
      ORDER BY p.legal_name
    `)
  ).rows;

  const packRows: VatPackRow[] = rows.map((r) => ({
    clientPartyId: r.client_party_id,
    clientName: r.client_name,
    acceptedCount: Number(r.n),
    acceptedTotal: String(r.total),
    acceptedVat: String(r.vat),
  }));

  // Per-row figures are exact Postgres sums; the firm totals re-sum those
  // decimal strings via Number — display-only, and safe at invoice
  // magnitudes (well inside double precision).
  const totals = packRows.reduce(
    (acc, r) => ({
      acceptedCount: acc.acceptedCount + r.acceptedCount,
      acceptedTotal: acc.acceptedTotal + Number(r.acceptedTotal),
      acceptedVat: acc.acceptedVat + Number(r.acceptedVat),
    }),
    { acceptedCount: 0, acceptedTotal: 0, acceptedVat: 0 },
  );

  const label = monthLabel(monthStart);
  return {
    monthStart,
    monthLabel: label,
    months: closedLagosMonths(),
    rows: packRows,
    totals: {
      acceptedCount: totals.acceptedCount,
      acceptedTotal: totals.acceptedTotal.toFixed(2),
      acceptedVat: totals.acceptedVat.toFixed(2),
    },
    note: `Output VAT for ${label}, computed from invoices accepted by the e-invoicing rails during the month (Lagos calendar). Figures mirror the per-client monthly statements. Generated ${lagosDateString()}.`,
  };
}
