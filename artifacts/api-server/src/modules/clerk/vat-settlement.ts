import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { closedLagosMonths, packMonthInvoicesSql } from "./vat-pack";
import { monthLabel } from "./client-statement";
import { OUTSTANDING } from "../invoice/receivables";

// VAT settlement cross-check (round-13 idea #6). The VAT pack answers "what
// output VAT did the month's accepted invoices carry"; this answers the
// partner's next question — "and how much of that money has actually been
// SEEN arriving?" Semantics pinned deliberately:
//  - the population is EXACTLY the pack month's accepted invoices (same
//    predicate as computeVatPack, kind='invoice' only — credit notes are
//    offsets, not receivables), so the two surfaces can never disagree
//    about what the month contains;
//  - "settled" means the platform OBSERVED settlement (reconciliation
//    match, buyer paid-flag) and the invoice reached the settled status;
//  - an unsettled invoice is UNOBSERVED, not unpaid — payment may have
//    happened outside the platform's sight. This is an assurance view for
//    the filing conversation, never an accusation to wave at a buyer;
//  - an accepted invoice later credit-noted sits in its own bucket, and the
//    outstanding bucket is the receivables OUTSTANDING definition exactly.
// Deterministic end to end, computed on demand, nothing stored.

const MAX_UNSETTLED_ROWS = 30;

export interface UnsettledInvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  buyerName: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  grandTotal: string;
  status: string;
}

export interface VatSettlementCheck {
  monthStart: string;
  monthLabel: string;
  months: string[];
  acceptedCount: number;
  acceptedTotal: string;
  settledCount: number;
  settledTotal: string;
  outstandingCount: number;
  outstandingTotal: string;
  creditedCount: number;
  creditedTotal: string;
  // The partition's runtime guard (round-13 review M2): accepted invoices in
  // a status OUTSIDE the three buckets (unreachable through normal flows,
  // but an unconditional pipeline write or a manual fix can produce it) —
  // surfaced instead of silently corrupting the share's denominator.
  otherCount: number;
  otherTotal: string;
  // settledTotal / acceptedTotal (4dp); null when the month had no value OR
  // the month mixes currencies (a share of unlike units is not a number).
  settledShare: number | null;
  // Largest unobserved money first (capped; truncation is declared).
  unsettled: UnsettledInvoiceRow[];
  unsettledTruncated: boolean;
  note: string;
}

// The pack-month membership predicate — computeVatPack's WHERE clause for
// kind='invoice' — is the SHARED packMonthInvoicesSql fragment (vat-pack.ts),
// so this check and the pack stay identical by construction.

export async function computeVatSettlementCheck(
  firmId: string,
  monthStart: string,
): Promise<VatSettlementCheck> {
  const db = getDb();

  const [agg] = (
    await db.execute<{
      n: number;
      total: string;
      settled_n: number;
      settled_total: string;
      outstanding_n: number;
      outstanding_total: string;
      credited_n: number;
      credited_total: string;
      other_n: number;
      other_total: string;
      currency_n: number;
    }>(sql`
      SELECT
        COUNT(*)::int AS n,
        COALESCE(SUM(i.grand_total), 0)::numeric(18,2)::text AS total,
        COUNT(*) FILTER (WHERE i.status = 'settled')::int AS settled_n,
        COALESCE(SUM(i.grand_total) FILTER (WHERE i.status = 'settled'), 0)::numeric(18,2)::text AS settled_total,
        COUNT(*) FILTER (WHERE ${OUTSTANDING})::int AS outstanding_n,
        COALESCE(SUM(i.grand_total) FILTER (WHERE ${OUTSTANDING}), 0)::numeric(18,2)::text AS outstanding_total,
        COUNT(*) FILTER (WHERE i.status = 'credited')::int AS credited_n,
        COALESCE(SUM(i.grand_total) FILTER (WHERE i.status = 'credited'), 0)::numeric(18,2)::text AS credited_total,
        COUNT(*) FILTER (
          WHERE i.status NOT IN ('settled', 'submitted', 'stamped', 'confirmed', 'credited')
        )::int AS other_n,
        COALESCE(SUM(i.grand_total) FILTER (
          WHERE i.status NOT IN ('settled', 'submitted', 'stamped', 'confirmed', 'credited')
        ), 0)::numeric(18,2)::text AS other_total,
        COUNT(DISTINCT i.currency)::int AS currency_n
      FROM invoices i
      WHERE ${packMonthInvoicesSql(firmId, monthStart)}
    `)
  ).rows;

  // The follow-up list: still-outstanding invoices, largest money first.
  const unsettledRows = (
    await db.execute<{
      id: string;
      invoice_number: string;
      client_name: string;
      buyer_name: string;
      issue_date: string;
      due_date: string | null;
      currency: string;
      grand_total: string;
      status: string;
    }>(sql`
      SELECT
        i.id,
        i.invoice_number,
        ps.legal_name AS client_name,
        pb.legal_name AS buyer_name,
        i.issue_date::text AS issue_date,
        i.due_date::text AS due_date,
        i.currency,
        i.grand_total::text AS grand_total,
        i.status
      FROM invoices i
      JOIN parties ps ON ps.id = i.supplier_party_id
      JOIN parties pb ON pb.id = i.buyer_party_id
      WHERE ${packMonthInvoicesSql(firmId, monthStart)}
        AND ${OUTSTANDING}
      ORDER BY i.grand_total DESC, i.issue_date ASC
      LIMIT ${MAX_UNSETTLED_ROWS + 1}
    `)
  ).rows;
  const unsettledTruncated = unsettledRows.length > MAX_UNSETTLED_ROWS;

  const acceptedTotal = String(agg?.total ?? "0.00");
  const settledTotal = String(agg?.settled_total ?? "0.00");
  const otherCount = Number(agg?.other_n ?? 0);
  const mixedCurrencies = Number(agg?.currency_n ?? 0) > 1;
  const label = monthLabel(monthStart);
  return {
    monthStart,
    monthLabel: label,
    months: closedLagosMonths(),
    acceptedCount: Number(agg?.n ?? 0),
    acceptedTotal,
    settledCount: Number(agg?.settled_n ?? 0),
    settledTotal,
    outstandingCount: Number(agg?.outstanding_n ?? 0),
    outstandingTotal: String(agg?.outstanding_total ?? "0.00"),
    creditedCount: Number(agg?.credited_n ?? 0),
    creditedTotal: String(agg?.credited_total ?? "0.00"),
    otherCount,
    otherTotal: String(agg?.other_total ?? "0.00"),
    settledShare:
      Number(acceptedTotal) > 0 && !mixedCurrencies
        ? Math.round((Number(settledTotal) / Number(acceptedTotal)) * 10000) / 10000
        : null,
    unsettled: unsettledRows.slice(0, MAX_UNSETTLED_ROWS).map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      clientName: r.client_name,
      buyerName: r.buyer_name,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      currency: r.currency,
      grandTotal: r.grand_total,
      status: r.status,
    })),
    unsettledTruncated,
    note:
      `Settlement view of ${label}'s accepted invoices (the VAT pack's population, invoices only). ` +
      `"Settled" means the platform observed payment via reconciliation or a buyer flag — an unsettled invoice is UNOBSERVED, not necessarily unpaid, and payment terms may not even have elapsed. ` +
      `This is an assurance aid for the filing conversation, not a demand list. Totals follow the pack's basis and are not split by currency` +
      (mixedCurrencies
        ? ` — this month mixes currencies, so no settled share is computed`
        : "") +
      (otherCount > 0
        ? `. ${otherCount} accepted invoice(s) sit in an unexpected lifecycle state and are counted under "other" — review them directly`
        : "") +
      `. Generated ${lagosDateString()}.`,
  };
}
