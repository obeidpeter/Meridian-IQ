import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { lagosMonthStart, monthLabel } from "../clerk/client-statement";
import { packMonthDocsSql } from "../clerk/vat-pack";
import { DomainError } from "../errors";
import { NEWEST_BILL_VERIFICATION } from "./payables";
import { BILL_ORIENTATION, LIVE_ENGAGEMENT } from "./receivables";

// Monthly VAT position (contract 0.45.0). The client's month in one number
// pair: output VAT from the documents it issued vs input VAT from the
// supplier bills it captured, with the VERIFIED-input split that makes the
// "defensible" net position honest. Deterministic SQL, zero model calls,
// nothing stored. The basis, stated once:
//  - OUTPUT side IS the VAT pack's own membership fragment (packMonthDocsSql,
//    vat-pack.ts — imported, not mirrored): issue-month bucketing, only
//    documents with an accepted submission attempt, credit notes netted,
//    cancelled documents excluded — so the position and the pack can never
//    disagree about what "accepted in the month" means;
//  - INPUT side is the captured supplier bills (BILL_ORIENTATION,
//    receivables.ts): bills stay status 'draft' forever and never touch the
//    stamping rails, so no accepted-attempt basis EXISTS for them — every
//    non-cancelled bill issued in the month counts, split by whether its
//    NEWEST stamp verification (bill_verifications) found the stamp valid on
//    the national record;
//  - FX: all amounts are NGN — non-NGN documents convert at their captured
//    fx_rate_to_ngn; a non-NGN document WITHOUT a rate is excluded from every
//    total and counted in excludedForFx (a rate of 1 is never assumed — see
//    invoices.fxRateToNgn).

export interface VatPosition {
  clientPartyId: string;
  monthStart: string;
  monthLabel: string;
  months: string[];
  outputVat: string;
  outputInvoiceCount: number;
  inputVat: string;
  inputVatVerified: string;
  inputVatUnverified: string;
  billCount: number;
  netVat: string;
  defensibleNetVat: string;
  excludedForFx: number;
  note: string;
}

export interface FirmVatPositionRow {
  clientPartyId: string;
  clientName: string;
  outputVat: string;
  inputVat: string;
  inputVatVerified: string;
  netVat: string;
  defensibleNetVat: string;
}

export interface FirmVatPositions {
  monthStart: string;
  monthLabel: string;
  months: string[];
  rows: FirmVatPositionRow[];
  totals: {
    outputVat: string;
    inputVat: string;
    inputVatVerified: string;
    netVat: string;
    defensibleNetVat: string;
  };
  note: string;
}

const VAT_POSITION_MONTHS = 12;

// The requestable Lagos months, newest first ("YYYY-MM-01"): the CURRENT
// month plus the eleven before it — the LIVE mirror of closedLagosMonths
// (vat-pack.ts) and lagosMonthOptions (clerk/data-intents/). Unlike the
// closed-month pack, a position is a running month-to-date number, so the
// current month is a valid — and the default — request.
export function vatPositionMonths(
  count = VAT_POSITION_MONTHS,
  now: Date = new Date(),
): string[] {
  return Array.from({ length: count }, (_, i) => lagosMonthStart(i, now));
}

// The live-month discipline, ONE resolver shared by the position routes AND
// the compliance-pack routes (routes/vat-position.ts, routes/
// compliance-pack.ts — the pack embeds the position, so the two surfaces
// accept exactly the same months by construction): the requested month, or
// the CURRENT Lagos month when omitted, must be on the position's own
// 12-month option list. The CLOSED-month resolver (resolveClosedPeriod,
// routes/invoices/packs.ts) is deliberately different and must stay separate.
export function resolveVatPositionMonth(raw: string | undefined): string {
  const months = vatPositionMonths();
  const month = raw ?? months[0];
  if (!months.includes(month)) {
    throw new DomainError(
      "BAD_MONTH",
      "month must be one of the last 12 Lagos months, current month included (YYYY-MM-01)",
      400,
    );
  }
  return month;
}

// FX posture fragments (alias `i`). A document is CONVERTIBLE when it has an
// NGN value at all; VAT_NGN is only meaningful under CONVERTIBLE — every
// consumer below pairs them, so an unrated non-NGN document can never reach a
// total.
const CONVERTIBLE = sql`(i.currency = 'NGN' OR i.fx_rate_to_ngn IS NOT NULL)`;
const VAT_NGN = sql`(CASE WHEN i.currency = 'NGN'
  THEN i.vat_total ELSE i.vat_total * i.fx_rate_to_ngn END)`;
// The document's SIGNED contribution to output VAT: credit notes are netted
// as offsets, the pack's treatment.
const SIGNED_VAT_NGN = sql`(CASE WHEN i.kind = 'credit_note'
  THEN -${VAT_NGN} ELSE ${VAT_NGN} END)`;

// The output-side month membership (alias `i`) is packMonthDocsSql
// (vat-pack.ts) — computeVatPack's own fragment, imported rather than
// mirrored, so the position and the pack agree by construction.

// The input-side month membership (alias `i`): captured supplier bills issued
// in the month. Bills are draft for life (payables.ts), so the only status
// with meaning is 'cancelled' — everything else counts, paid or not (input
// VAT hangs on the bill, not on payment evidence). Exported for the firm net
// position (clerk/vat-input.ts), whose bill basis must match this one.
export function monthBillsSql(firmId: string, monthStart: string): SQL {
  return sql`i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND ${BILL_ORIENTATION}
    AND i.status <> 'cancelled'
    AND i.issue_date >= ${monthStart}::date
    AND i.issue_date < (${monthStart}::date + interval '1 month')`;
}

// The newest verification per bill IS the bills ledger's own rule
// (NEWEST_BILL_VERIFICATION, payables.ts — imported, not mirrored), so the
// position's verified split can never disagree with what the ledger shows per
// bill. Only bv.valid is read here; the fragment's other columns are inert.

interface OutputAgg {
  outputVat: number;
  invoiceCount: number;
  excluded: number;
}

interface InputAgg {
  inputVat: number;
  inputVatVerified: number;
  billCount: number;
  excluded: number;
}

const ZERO_OUTPUT: OutputAgg = { outputVat: 0, invoiceCount: 0, excluded: 0 };
const ZERO_INPUT: InputAgg = {
  inputVat: 0,
  inputVatVerified: 0,
  billCount: 0,
  excluded: 0,
};

// One grouped pass per side, shared by the per-client position and the firm
// rollup so the two surfaces are the same query with a different client
// filter (single party vs the engaged-client set) and cannot drift. Counts
// follow the FX rule: an unconvertible document counts ONLY in `excluded`,
// never in the document counts its totals omit it from.
async function outputAggregates(
  firmId: string,
  monthStart: string,
  clientFilter: SQL,
): Promise<Map<string, OutputAgg>> {
  const rows = (
    await getDb().execute<{
      client_party_id: string;
      output_vat: string;
      invoice_count: number;
      excluded: number;
    }>(sql`
      SELECT
        i.supplier_party_id AS client_party_id,
        COALESCE(SUM(${SIGNED_VAT_NGN}) FILTER (WHERE ${CONVERTIBLE}), 0)
          ::numeric(18,2)::text AS output_vat,
        COUNT(*) FILTER (WHERE i.kind = 'invoice' AND ${CONVERTIBLE})::int AS invoice_count,
        COUNT(*) FILTER (WHERE NOT ${CONVERTIBLE})::int AS excluded
      FROM invoices i
      WHERE ${packMonthDocsSql(firmId, monthStart)}
        AND ${clientFilter}
      GROUP BY i.supplier_party_id
    `)
  ).rows;
  return new Map(
    rows.map((r) => [
      r.client_party_id,
      {
        outputVat: Number(r.output_vat),
        invoiceCount: Number(r.invoice_count),
        excluded: Number(r.excluded),
      },
    ]),
  );
}

async function inputAggregates(
  firmId: string,
  monthStart: string,
  clientFilter: SQL,
): Promise<Map<string, InputAgg>> {
  const rows = (
    await getDb().execute<{
      client_party_id: string;
      input_vat: string;
      input_verified: string;
      bill_count: number;
      excluded: number;
    }>(sql`
      SELECT
        i.buyer_party_id AS client_party_id,
        COALESCE(SUM(${VAT_NGN}) FILTER (WHERE ${CONVERTIBLE}), 0)
          ::numeric(18,2)::text AS input_vat,
        COALESCE(SUM(${VAT_NGN}) FILTER (WHERE ${CONVERTIBLE} AND bv.valid IS TRUE), 0)
          ::numeric(18,2)::text AS input_verified,
        COUNT(*) FILTER (WHERE ${CONVERTIBLE})::int AS bill_count,
        COUNT(*) FILTER (WHERE NOT ${CONVERTIBLE})::int AS excluded
      FROM invoices i
      ${NEWEST_BILL_VERIFICATION}
      WHERE ${monthBillsSql(firmId, monthStart)}
        AND ${clientFilter}
      GROUP BY i.buyer_party_id
    `)
  ).rows;
  return new Map(
    rows.map((r) => [
      r.client_party_id,
      {
        inputVat: Number(r.input_vat),
        inputVatVerified: Number(r.input_verified),
        billCount: Number(r.bill_count),
        excluded: Number(r.excluded),
      },
    ]),
  );
}

// The disclosure every position surface carries — one paragraph, the whole
// basis, no soft-pedalling.
function positionNote(label: string, scopeLine: string): string {
  return (
    `VAT position for ${label} by issue date (Lagos calendar), month to date${scopeLine}. ` +
    `Output VAT: invoices and credit notes issued in the month that cleared the e-invoicing rails (an accepted submission attempt, whenever it happened), net of credits, cancelled documents excluded — the VAT pack's basis. ` +
    `Input VAT: captured supplier bills issued in the month, paid or not (bills never enter the stamping lifecycle, so no rails basis exists for them); "verified" means the bill's NEWEST stamp verification found the stamp valid on the national record, and the defensible net deducts verified input only. ` +
    `All amounts are NGN: non-NGN documents convert at their captured FX rate; a non-NGN document WITHOUT a captured rate is excluded from every total and every count except excludedForFx — a rate of 1 is never assumed. ` +
    `A preparation aid, not a return — reconcile before filing. Generated ${lagosDateString()}.`
  );
}

export async function computeVatPosition(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
): Promise<VatPosition> {
  const out =
    (
      await outputAggregates(
        firmId,
        monthStart,
        sql`i.supplier_party_id = ${clientPartyId}`,
      )
    ).get(clientPartyId) ?? ZERO_OUTPUT;
  const inp =
    (
      await inputAggregates(
        firmId,
        monthStart,
        sql`i.buyer_party_id = ${clientPartyId}`,
      )
    ).get(clientPartyId) ?? ZERO_INPUT;
  return {
    clientPartyId,
    monthStart,
    monthLabel: monthLabel(monthStart),
    months: vatPositionMonths(),
    outputVat: out.outputVat.toFixed(2),
    outputInvoiceCount: out.invoiceCount,
    inputVat: inp.inputVat.toFixed(2),
    inputVatVerified: inp.inputVatVerified.toFixed(2),
    inputVatUnverified: (inp.inputVat - inp.inputVatVerified).toFixed(2),
    billCount: inp.billCount,
    netVat: (out.outputVat - inp.inputVat).toFixed(2),
    defensibleNetVat: (out.outputVat - inp.inputVatVerified).toFixed(2),
    excludedForFx: out.excluded + inp.excluded,
    note: positionNote(monthLabel(monthStart), ""),
  };
}

export async function computeFirmVatPositions(
  firmId: string,
  monthStart: string,
): Promise<FirmVatPositions> {
  // One row per client the firm ACTIVELY serves — live engagements only
  // (LIVE_ENGAGEMENT, receivables.ts — the client-statement sweep's
  // enumeration) — so archived clients drop off the rollup.
  // selectDistinct because a client can hold several engagements.
  const clients = (
    await getDb().execute<{ id: string; legal_name: string }>(sql`
      SELECT DISTINCT e.client_party_id AS id, p.legal_name
      FROM engagements e
      JOIN parties p ON p.id = e.client_party_id
      WHERE e.firm_id = ${firmId} AND ${LIVE_ENGAGEMENT}
      ORDER BY p.legal_name, e.client_party_id
    `)
  ).rows;
  const engaged = sql`(
    SELECT e.client_party_id FROM engagements e
    WHERE e.firm_id = ${firmId} AND ${LIVE_ENGAGEMENT}
  )`;
  const outBy = await outputAggregates(
    firmId,
    monthStart,
    sql`i.supplier_party_id IN ${engaged}`,
  );
  const inBy = await inputAggregates(
    firmId,
    monthStart,
    sql`i.buyer_party_id IN ${engaged}`,
  );

  const rows: FirmVatPositionRow[] = clients.map((c) => {
    const out = outBy.get(c.id) ?? ZERO_OUTPUT;
    const inp = inBy.get(c.id) ?? ZERO_INPUT;
    return {
      clientPartyId: c.id,
      clientName: c.legal_name,
      outputVat: out.outputVat.toFixed(2),
      inputVat: inp.inputVat.toFixed(2),
      inputVatVerified: inp.inputVatVerified.toFixed(2),
      netVat: (out.outputVat - inp.inputVat).toFixed(2),
      defensibleNetVat: (out.outputVat - inp.inputVatVerified).toFixed(2),
    };
  });
  // Totals summed FROM the rows themselves, so the TOTAL line can never
  // disagree with its column by even a kobo (the vat-pack GROUPING SETS
  // guarantee, achieved arithmetically).
  const total = (pick: (r: FirmVatPositionRow) => string) =>
    rows.reduce((sum, r) => sum + Number(pick(r)), 0).toFixed(2);
  return {
    monthStart,
    monthLabel: monthLabel(monthStart),
    months: vatPositionMonths(),
    rows,
    totals: {
      outputVat: total((r) => r.outputVat),
      inputVat: total((r) => r.inputVat),
      inputVatVerified: total((r) => r.inputVatVerified),
      netVat: total((r) => r.netVat),
      defensibleNetVat: total((r) => r.defensibleNetVat),
    },
    note: positionNote(
      monthLabel(monthStart),
      ", one row per client with an open or in-progress engagement",
    ),
  };
}

// The per-document detail behind the position — the CSV export's rows. Same
// two bases as the aggregates above (same fragments, so they cannot drift);
// vatNgn is the document's SIGNED contribution to its side's total (credit
// notes negative), blank when the document is FX-excluded — so summing the
// column per side reproduces the position exactly. `verified` is the bill's
// newest-verification posture; null (blank) on output documents, where the
// concept does not apply.
export interface VatPositionDocRow {
  docType: "invoice" | "credit_note" | "bill";
  invoiceNumber: string;
  counterparty: string;
  currency: string;
  fxRateToNgn: string | null;
  vatOriginal: string;
  vatNgn: string | null;
  verified: boolean | null;
}

export async function listVatPositionDocuments(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
): Promise<VatPositionDocRow[]> {
  const outputDocs = (
    await getDb().execute<{
      doc_type: "invoice" | "credit_note";
      invoice_number: string;
      counterparty: string;
      currency: string;
      fx_rate: string | null;
      vat_original: string;
      vat_ngn: string | null;
    }>(sql`
      SELECT
        i.kind::text AS doc_type,
        i.invoice_number,
        p.legal_name AS counterparty,
        i.currency,
        i.fx_rate_to_ngn::text AS fx_rate,
        i.vat_total::text AS vat_original,
        CASE WHEN ${CONVERTIBLE}
          THEN ${SIGNED_VAT_NGN}::numeric(18,2)::text END AS vat_ngn
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE ${packMonthDocsSql(firmId, monthStart)}
        AND i.supplier_party_id = ${clientPartyId}
      ORDER BY i.issue_date, i.invoice_number
      LIMIT 50000
    `)
  ).rows;
  const billDocs = (
    await getDb().execute<{
      invoice_number: string;
      counterparty: string;
      currency: string;
      fx_rate: string | null;
      vat_original: string;
      vat_ngn: string | null;
      verified: boolean;
    }>(sql`
      SELECT
        i.invoice_number,
        p.legal_name AS counterparty,
        i.currency,
        i.fx_rate_to_ngn::text AS fx_rate,
        i.vat_total::text AS vat_original,
        CASE WHEN ${CONVERTIBLE}
          THEN ${VAT_NGN}::numeric(18,2)::text END AS vat_ngn,
        COALESCE(bv.valid, false) AS verified
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      ${NEWEST_BILL_VERIFICATION}
      WHERE ${monthBillsSql(firmId, monthStart)}
        AND i.buyer_party_id = ${clientPartyId}
      ORDER BY i.issue_date, i.invoice_number
      LIMIT 50000
    `)
  ).rows;
  return [
    ...outputDocs.map(
      (r): VatPositionDocRow => ({
        docType: r.doc_type,
        invoiceNumber: r.invoice_number,
        counterparty: r.counterparty,
        currency: r.currency,
        fxRateToNgn: r.fx_rate,
        vatOriginal: r.vat_original,
        vatNgn: r.vat_ngn,
        verified: null,
      }),
    ),
    ...billDocs.map(
      (r): VatPositionDocRow => ({
        docType: "bill",
        invoiceNumber: r.invoice_number,
        counterparty: r.counterparty,
        currency: r.currency,
        fxRateToNgn: r.fx_rate,
        vatOriginal: r.vat_original,
        vatNgn: r.vat_ngn,
        verified: r.verified,
      }),
    ),
  ];
}
