import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString, lagosTodaySql } from "../../lib/lagos-time";
import { addDays, daysBetween } from "./date-math";
import { BILL_ORIENTATION, RECEIVABLE_ORIENTATION } from "./receivables";

// Supplier payables (contract 0.44.0). A BILL is an invoice row where the
// firm's CLIENT is the BUYER party — a captured vendor invoice. Bills stay
// status 'draft' forever (they must never enter the stamping lifecycle);
// their payment state is DERIVED from settlement evidence only:
//   paid       any settlement event with payment_status 'paid' or source
//              'statement_match';
//   scheduled  the latest payer_flag event is 'scheduled';
//   open       otherwise.
// Orientation comes from the shared fragments in receivables.ts (alias `i`),
// so a bill can never be double-counted as a receivable.

// The "no payment evidence yet" predicate, alias `i` — shared by the summary
// buckets, the reconciliation debit-lane candidates, the digest fact and the
// Ask Clerk payables intents so "unpaid" has exactly one spelling.
export const BILL_UNPAID = sql`NOT EXISTS (
  SELECT 1 FROM settlement_events se
  WHERE se.invoice_id = i.id
    AND (se.payment_status = 'paid' OR se.source = 'statement_match')
)`;

// The three orientation-defining conditions of a bill in one fragment: the
// row is an invoice-kind document whose buyer is the named client, oriented
// as a bill. Callers add firm scoping and any payment-state predicate.
const BILL_OF_CLIENT = (firmId: string, clientPartyId: string) => sql`
  i.firm_id = ${firmId}
  AND i.buyer_party_id = ${clientPartyId}
  AND i.kind = 'invoice'
  AND ${BILL_ORIENTATION}`;

// Classify one invoice's orientation without re-spelling the fragments: the
// row's three keys are projected into a derived table aliased `i`, so the
// receivables.ts fragments evaluate verbatim. Used by the submit guard
// (service.ts) and the bills routes' scope wall.
export async function invoiceOrientation(invoice: {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
}): Promise<"receivable" | "bill" | "none"> {
  const rows = (
    await getDb().execute<{ recv: boolean; bill: boolean }>(sql`
      SELECT (${RECEIVABLE_ORIENTATION}) AS recv, (${BILL_ORIENTATION}) AS bill
      FROM (
        SELECT ${invoice.firmId}::uuid AS firm_id,
               ${invoice.supplierPartyId}::uuid AS supplier_party_id,
               ${invoice.buyerPartyId}::uuid AS buyer_party_id
      ) i
    `)
  ).rows;
  const r = rows[0];
  if (r?.recv) return "receivable";
  if (r?.bill) return "bill";
  return "none";
}

export interface BillSummaryRow {
  invoiceId: string;
  invoiceNumber: string;
  supplierPartyId: string;
  supplierName: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  grandTotal: string;
  payStatus: "open" | "scheduled" | "paid";
  lastVerification: {
    valid: boolean;
    eligible: boolean | null;
    checkedAt: string;
  } | null;
}

function isoString(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// The client's bills ledger, newest first, with the derived payment status
// (ONE grouped settlement-events pass — precedence paid > scheduled > open)
// and the newest stamp verification per bill. Parse-ready for BillSummary.
export async function listBills(
  firmId: string,
  clientPartyId: string,
): Promise<BillSummaryRow[]> {
  const rows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      supplier_party_id: string;
      supplier_name: string;
      issue_date: string;
      due_date: string | null;
      currency: string;
      grand_total: string;
      pay_status: "open" | "scheduled" | "paid";
      v_valid: boolean | null;
      v_eligible: boolean | null;
      v_checked_at: Date | string | null;
    }>(sql`
      SELECT
        i.id,
        i.invoice_number,
        i.supplier_party_id,
        p.legal_name AS supplier_name,
        i.issue_date::text AS issue_date,
        i.due_date::text AS due_date,
        i.currency,
        i.grand_total::text AS grand_total,
        CASE
          WHEN COALESCE(se.paid, false) THEN 'paid'
          WHEN se.latest_flag = 'scheduled' THEN 'scheduled'
          ELSE 'open'
        END AS pay_status,
        bv.valid AS v_valid,
        bv.eligible AS v_eligible,
        bv.checked_at AS v_checked_at
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      LEFT JOIN (
        SELECT
          invoice_id,
          BOOL_OR(payment_status = 'paid' OR source = 'statement_match') AS paid,
          (ARRAY_AGG(payment_status ORDER BY occurred_at DESC, created_at DESC)
             FILTER (WHERE source = 'payer_flag'))[1] AS latest_flag
        FROM settlement_events
        GROUP BY invoice_id
      ) se ON se.invoice_id = i.id
      LEFT JOIN LATERAL (
        SELECT v.valid, v.eligible, v.checked_at
        FROM bill_verifications v
        WHERE v.invoice_id = i.id
        ORDER BY v.checked_at DESC, v.created_at DESC
        LIMIT 1
      ) bv ON true
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
      ORDER BY i.created_at DESC
      LIMIT 5000
    `)
  ).rows;
  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    supplierPartyId: r.supplier_party_id,
    supplierName: r.supplier_name,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    currency: r.currency,
    grandTotal: r.grand_total,
    payStatus: r.pay_status,
    lastVerification:
      r.v_valid === null || r.v_valid === undefined
        ? null
        : {
            valid: r.v_valid,
            eligible: r.v_eligible ?? null,
            checkedAt: isoString(r.v_checked_at),
          },
  }));
}

export interface PayablesBucket {
  amount: string;
  count: number;
}

export interface PayablesSummary {
  clientPartyId: string;
  groups: {
    currency: string;
    overdue: PayablesBucket;
    dueWeeks: { startDate: string; amount: string; count: number }[];
    later: PayablesBucket;
    total: PayablesBucket;
  }[];
  topSuppliers: {
    supplierPartyId: string;
    supplierName: string;
    amount: string;
    count: number;
  }[];
}

const WEEK_COUNT = 4;

// Committed outflows: the client's UNPAID bills (no payment evidence),
// bucketed by DUE DATE into overdue / four consecutive 7-day due weeks /
// later, per currency — the cashflow outlook's bucket shapes pointed at the
// payables side. A bill without a due date cannot be "due" on any week, so
// it lands in `later`. Due today is week 0, not overdue (mirrors
// bucketProjections: money is late only once its date has passed).
export async function payablesSummary(
  firmId: string,
  clientPartyId: string,
): Promise<PayablesSummary> {
  const today = lagosDateString();
  const bills = (
    await getDb().execute<{
      currency: string;
      grand_total: string;
      due_date: string | null;
    }>(sql`
      SELECT i.currency, i.grand_total::text AS grand_total, i.due_date::text AS due_date
      FROM invoices i
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        AND ${BILL_UNPAID}
      LIMIT 50000
    `)
  ).rows;

  const byCurrency = new Map<string, typeof bills>();
  for (const b of bills) {
    const list = byCurrency.get(b.currency) ?? [];
    list.push(b);
    byCurrency.set(b.currency, list);
  }
  const groups: PayablesSummary["groups"] = [];
  for (const [currency, list] of byCurrency) {
    const zero = () => ({ amount: 0, count: 0 });
    const overdue = zero();
    const later = zero();
    const total = zero();
    const weeks = Array.from({ length: WEEK_COUNT }, (_, i) => ({
      startDate: addDays(today, i * 7),
      ...zero(),
    }));
    for (const b of list) {
      const amount = Number(b.grand_total);
      if (!Number.isFinite(amount)) continue;
      total.amount += amount;
      total.count += 1;
      if (b.due_date === null) {
        later.amount += amount;
        later.count += 1;
        continue;
      }
      const daysPast = daysBetween(b.due_date, today);
      if (daysPast > 0) {
        overdue.amount += amount;
        overdue.count += 1;
      } else {
        const weekIndex = Math.floor(-daysPast / 7);
        const target = weekIndex < WEEK_COUNT ? weeks[weekIndex] : later;
        target.amount += amount;
        target.count += 1;
      }
    }
    const money = (b: { amount: number; count: number }) => ({
      amount: b.amount.toFixed(2),
      count: b.count,
    });
    groups.push({
      currency,
      overdue: money(overdue),
      dueWeeks: weeks.map((w) => ({
        startDate: w.startDate,
        amount: w.amount.toFixed(2),
        count: w.count,
      })),
      later: money(later),
      total: money(total),
    });
  }
  groups.sort((a, b) => Number(b.total.amount) - Number(a.total.amount));

  const topSuppliers = (
    await getDb().execute<{
      supplier_party_id: string;
      legal_name: string;
      amount: string;
      count: number;
    }>(sql`
      SELECT
        i.supplier_party_id,
        p.legal_name,
        SUM(i.grand_total)::numeric(18,2)::text AS amount,
        COUNT(*)::int AS count
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        AND ${BILL_UNPAID}
      GROUP BY i.supplier_party_id, p.legal_name
      ORDER BY SUM(i.grand_total) DESC
      LIMIT 5
    `)
  ).rows;

  return {
    clientPartyId,
    groups,
    topSuppliers: topSuppliers.map((s) => ({
      supplierPartyId: s.supplier_party_id,
      supplierName: s.legal_name,
      amount: s.amount,
      count: s.count,
    })),
  };
}

export interface BillDeadlineRow {
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  dueDate: string;
}

// Due-date-bearing unpaid bills for the SME deadline surfaces (routes/sme.ts
// computeDeadlines kind=bill_due). Tenant scoping mirrors loadClientInvoices:
// cross-tenant staff pass a null firm and see the party's whole book.
export async function listBillDeadlines(
  clientPartyId: string,
  firmId: string | null,
): Promise<BillDeadlineRow[]> {
  const firmCond = firmId ? sql`AND i.firm_id = ${firmId}` : sql``;
  const rows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      supplier_name: string;
      due_date: string;
    }>(sql`
      SELECT i.id, i.invoice_number, p.legal_name AS supplier_name,
        i.due_date::text AS due_date
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE i.buyer_party_id = ${clientPartyId}
        AND i.kind = 'invoice'
        AND ${BILL_ORIENTATION}
        AND ${BILL_UNPAID}
        AND i.due_date IS NOT NULL
        ${firmCond}
      ORDER BY i.due_date ASC
      LIMIT 500
    `)
  ).rows;
  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    supplierName: r.supplier_name,
    dueDate: r.due_date,
  }));
}

// Firm-wide payables pressure for the weekly digest: unpaid bills due within
// the next 7 days or already overdue. Same helper-call shape as
// countFirmUnbilled / countFirmUnmatchedCredits.
export async function countFirmPayablesDue(firmId: string): Promise<number> {
  const rows = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND ${BILL_ORIENTATION}
        AND ${BILL_UNPAID}
        AND i.due_date IS NOT NULL
        AND i.due_date <= ${lagosTodaySql()} + 7
    `)
  ).rows;
  return Number(rows[0]?.n ?? 0);
}
