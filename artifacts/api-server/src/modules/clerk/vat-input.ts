import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { NEWEST_BILL_VERIFICATION } from "../invoice/payables";
import { monthBillsSql } from "../invoice/vat-position";
import { closedLagosMonths, computeVatPack } from "./vat-pack";
import { monthLabel } from "./client-statement";

// Net VAT position (round-15 idea #1). The VAT pack computes OUTPUT VAT
// (what the firm's clients charged); the bills ledger now holds the INPUT
// side (what their suppliers charged them), with per-bill stamp
// verification. This joins the two into the number the firm actually files:
// net position = output VAT (the pack's EXACT computation) minus VERIFIED
// input VAT. Deterministic end to end, computed on demand, nothing stored.
//
// Semantics, pinned:
//  - bills are bucketed by ISSUE month, the same basis as the output pack,
//    so both sides of the position answer for the same supply month;
//  - input VAT only counts toward the position when the bill's NEWEST stamp
//    verification says the stamp is VALID — an unverified vendor invoice is
//    a recovery OPPORTUNITY, not a filing number (FIRS will not credit
//    input VAT on an unstamped invoice), which is why the unverified list
//    is the card's CTA;
//  - eligibility (the rail's own lifecycle check) rides along when known;
//    a valid-but-ineligible verification still counts as verified here —
//    the note says the pack is a preparation aid, not a return.

const MAX_UNVERIFIED_ROWS = 20;

export interface UnverifiedBillRow {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  supplierName: string;
  issueDate: string;
  currency: string;
  vatTotal: string;
}

export interface VatPosition {
  monthStart: string;
  monthLabel: string;
  months: string[];
  // Output side — computeVatPack's totals verbatim.
  outputVat: string;
  outputNetVat: string;
  // Input side — the firm's bills issued in the month.
  billCount: number;
  billVat: string;
  verifiedCount: number;
  verifiedVat: string;
  unverifiedCount: number;
  unverifiedVat: string;
  // The filing number: output net VAT minus VERIFIED input VAT.
  netPosition: string;
  // The CTA: largest unverified input VAT first (capped; truncation flagged).
  unverified: UnverifiedBillRow[];
  unverifiedTruncated: boolean;
  note: string;
}

// The month's bills with their newest verification verdict — the VAT
// position's own fragments (monthBillsSql, invoice/vat-position.ts;
// NEWEST_BILL_VERIFICATION, invoice/payables.ts — imported, not mirrored),
// shared by the aggregate and the row list so no two surfaces can disagree.
// A bill is VERIFIED when its newest bill_verifications row says valid:
// COALESCE(bv.valid, false) against the fragment's `bv` alias.

export async function computeVatPosition(
  firmId: string,
  monthStart: string,
): Promise<VatPosition> {
  const db = getDb();
  // Output side: the monthly pack's own computation, never re-derived.
  const pack = await computeVatPack(firmId, monthStart);

  const [agg] = (
    await db.execute<{
      n: number;
      vat: string;
      verified_n: number;
      verified_vat: string;
    }>(sql`
      SELECT
        COUNT(*)::int AS n,
        COALESCE(SUM(i.vat_total), 0)::numeric(18,2)::text AS vat,
        COUNT(*) FILTER (WHERE COALESCE(bv.valid, false))::int AS verified_n,
        COALESCE(SUM(i.vat_total) FILTER (WHERE COALESCE(bv.valid, false)), 0)::numeric(18,2)::text AS verified_vat
      FROM invoices i
      ${NEWEST_BILL_VERIFICATION}
      WHERE ${monthBillsSql(firmId, monthStart)}
    `)
  ).rows;

  const unverifiedRows = (
    await db.execute<{
      id: string;
      invoice_number: string;
      client_name: string;
      supplier_name: string;
      issue_date: string;
      currency: string;
      vat_total: string;
    }>(sql`
      SELECT i.id, i.invoice_number,
        pc.legal_name AS client_name,
        ps.legal_name AS supplier_name,
        i.issue_date::text AS issue_date,
        i.currency,
        i.vat_total::text AS vat_total
      FROM invoices i
      JOIN parties pc ON pc.id = i.buyer_party_id
      JOIN parties ps ON ps.id = i.supplier_party_id
      ${NEWEST_BILL_VERIFICATION}
      WHERE ${monthBillsSql(firmId, monthStart)}
        AND NOT COALESCE(bv.valid, false)
        AND i.vat_total > 0
      ORDER BY i.vat_total DESC, i.issue_date ASC, i.id
      LIMIT ${MAX_UNVERIFIED_ROWS + 1}
    `)
  ).rows;

  const billVat = String(agg?.vat ?? "0.00");
  const verifiedVat = String(agg?.verified_vat ?? "0.00");
  const billCount = Number(agg?.n ?? 0);
  const verifiedCount = Number(agg?.verified_n ?? 0);
  const label = monthLabel(monthStart);
  return {
    monthStart,
    monthLabel: label,
    months: closedLagosMonths(),
    outputVat: pack.totals.acceptedVat,
    outputNetVat: pack.totals.netVat,
    billCount,
    billVat,
    verifiedCount,
    verifiedVat,
    unverifiedCount: billCount - verifiedCount,
    unverifiedVat: (Number(billVat) - Number(verifiedVat)).toFixed(2),
    netPosition: (Number(pack.totals.netVat) - Number(verifiedVat)).toFixed(2),
    unverified: unverifiedRows.slice(0, MAX_UNVERIFIED_ROWS).map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      clientName: r.client_name,
      supplierName: r.supplier_name,
      issueDate: r.issue_date,
      currency: r.currency,
      vatTotal: r.vat_total,
    })),
    unverifiedTruncated: unverifiedRows.length > MAX_UNVERIFIED_ROWS,
    note:
      `VAT position for ${label}: output VAT from the monthly filing pack (issue-month basis, rails-accepted, credits netted) minus input VAT on the firm's captured supplier bills issued in the month whose STAMP VERIFICATION says valid. ` +
      `Unverified bills are a recovery opportunity, not a filing number — verify their IRN/CSID on the bills page to move them into the position. ` +
      `Totals follow the pack's basis and are not split by currency. This is a preparation aid, not a return — reconcile before filing. Generated ${lagosDateString()}.`,
  };
}
