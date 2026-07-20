import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { lagosMonthStart, monthLabel } from "./client-statement";

// Monthly VAT filing pack (exhaust idea #2). A filing PREPARATION aid: output
// VAT per client for a closed Lagos month, computed on demand with zero model
// involvement and nothing stored. The basis is deliberately chosen for
// filing, not narrative:
//  - documents are bucketed by ISSUE month (output VAT belongs to the supply
//    month, not to whenever the rails happened to accept a retry);
//  - only documents that cleared the rails (an accepted submission attempt,
//    whenever it happened) count — unsubmitted paper is not evidence;
//  - credit notes issued in the month are NETTED as offsets, and cancelled
//    documents are excluded entirely;
//  - corrections (kind='correction') are NOT netted against their originals —
//    the note says so, because silently guessing replacement semantics in a
//    filing artifact is worse than disclosure.
// Totals come from the SAME SQL pass (GROUPING SETS), so the TOTAL row can
// never disagree with its column by even a kobo.

export interface VatPackRow {
  clientPartyId: string;
  clientName: string;
  acceptedCount: number;
  acceptedTotal: string;
  acceptedVat: string;
  creditCount: number;
  creditVat: string;
  netVat: string;
}

export interface VatPackTotals {
  acceptedCount: number;
  acceptedTotal: string;
  acceptedVat: string;
  creditCount: number;
  creditVat: string;
  netVat: string;
}

export interface VatPack {
  monthStart: string;
  monthLabel: string;
  // The closed Lagos months a pack may be requested for (newest first) — the
  // month picker's CLOSED option list; a month outside it is refused.
  months: string[];
  rows: VatPackRow[];
  totals: VatPackTotals;
  note: string;
}

const VAT_PACK_MONTHS = 12;

// The closed Lagos months on offer, newest first ("YYYY-MM-01").
export function closedLagosMonths(
  count = VAT_PACK_MONTHS,
  now: Date = new Date(),
): string[] {
  return Array.from({ length: count }, (_, i) => lagosMonthStart(i + 1, now));
}

const ZERO_TOTALS: VatPackTotals = {
  acceptedCount: 0,
  acceptedTotal: "0",
  acceptedVat: "0",
  creditCount: 0,
  creditVat: "0",
  netVat: "0",
};

export async function computeVatPack(
  firmId: string,
  monthStart: string,
): Promise<VatPack> {
  const rows = (
    await getDb().execute<{
      client_party_id: string | null;
      client_name: string | null;
      n: number;
      total: string;
      vat: string;
      credit_n: number;
      credit_vat: string;
      net_vat: string;
      is_total: number;
    }>(sql`
      SELECT
        i.supplier_party_id AS client_party_id,
        MIN(p.legal_name) AS client_name,
        COUNT(*) FILTER (WHERE i.kind = 'invoice')::int AS n,
        COALESCE(SUM(i.grand_total) FILTER (WHERE i.kind = 'invoice'), 0)::text AS total,
        COALESCE(SUM(i.vat_total) FILTER (WHERE i.kind = 'invoice'), 0)::text AS vat,
        COUNT(*) FILTER (WHERE i.kind = 'credit_note')::int AS credit_n,
        COALESCE(SUM(i.vat_total) FILTER (WHERE i.kind = 'credit_note'), 0)::text AS credit_vat,
        (COALESCE(SUM(i.vat_total) FILTER (WHERE i.kind = 'invoice'), 0)
          - COALESCE(SUM(i.vat_total) FILTER (WHERE i.kind = 'credit_note'), 0))::text AS net_vat,
        GROUPING(i.supplier_party_id)::int AS is_total
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE i.firm_id = ${firmId}
        AND i.kind IN ('invoice', 'credit_note')
        -- A cancelled document is void whatever the rails once said.
        AND i.status <> 'cancelled'
        -- Issue-month basis: output VAT belongs to the supply month.
        AND i.issue_date >= ${monthStart}::date
        AND i.issue_date < (${monthStart}::date + interval '1 month')
        -- ...but only documents that actually cleared the rails count.
        AND EXISTS (
          SELECT 1 FROM submission_attempts sa
          WHERE sa.invoice_id = i.id AND sa.status = 'accepted'
        )
      GROUP BY GROUPING SETS ((i.supplier_party_id), ())
      ORDER BY GROUPING(i.supplier_party_id), MIN(p.legal_name)
    `)
  ).rows;

  const packRows: VatPackRow[] = rows
    .filter((r) => Number(r.is_total) === 0 && r.client_party_id !== null)
    .map((r) => ({
      clientPartyId: r.client_party_id!,
      clientName: r.client_name ?? "",
      acceptedCount: Number(r.n),
      acceptedTotal: String(r.total),
      acceptedVat: String(r.vat),
      creditCount: Number(r.credit_n),
      creditVat: String(r.credit_vat),
      netVat: String(r.net_vat),
    }));
  const totalRow = rows.find((r) => Number(r.is_total) === 1);
  const totals: VatPackTotals = totalRow
    ? {
        acceptedCount: Number(totalRow.n),
        acceptedTotal: String(totalRow.total),
        acceptedVat: String(totalRow.vat),
        creditCount: Number(totalRow.credit_n),
        creditVat: String(totalRow.credit_vat),
        netVat: String(totalRow.net_vat),
      }
    : ZERO_TOTALS;

  const label = monthLabel(monthStart);
  return {
    monthStart,
    monthLabel: label,
    months: closedLagosMonths(),
    rows: packRows,
    totals,
    note:
      `Output VAT for ${label} by issue date (Lagos calendar): invoices and credit notes issued in the month that cleared the e-invoicing rails, net of credits; cancelled documents excluded. ` +
      `Corrections (re-issued documents) are NOT netted against their originals. This is a preparation aid, not a return — reconcile before filing. Generated ${lagosDateString()}.`,
  };
}
