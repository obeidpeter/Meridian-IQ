import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";

// Receivables aging for the SME dashboard: who owes this client what, and how
// old is it. An invoice is an outstanding receivable once it has been issued
// to the buyer (submitted/stamped/confirmed) and stops being one when payment
// is observed (settled, via reconciliation) or it dies (cancelled/credited/
// failed). Age is measured against the due date where one exists, otherwise
// the issue date — "current" therefore includes not-yet-due invoices.
// Pure SQL aggregation; money stays as strings end to end.

export interface ReceivablesBucket {
  amount: string;
  count: number;
}

export interface ReceivablesSummary {
  asOf: string;
  groups: {
    currency: string;
    outstandingTotal: string;
    invoiceCount: number;
    buckets: {
      current: ReceivablesBucket;
      days31to60: ReceivablesBucket;
      days61to90: ReceivablesBucket;
      days90plus: ReceivablesBucket;
    };
  }[];
  topDebtors: {
    buyerPartyId: string;
    buyerName: string;
    currency: string;
    outstanding: string;
    invoiceCount: number;
    oldestDueDate: string | null;
  }[];
}

const OUTSTANDING = sql`i.kind = 'invoice'
  AND i.status IN ('submitted', 'stamped', 'confirmed')`;

// The single definition of a receivable's reference date: age is measured
// against the due date where one exists, otherwise the issue date.
const REF_DATE = sql`COALESCE(i.due_date, i.issue_date)`;

// Aging is a Lagos-calendar question: current_date would use the session
// (UTC) day, which lags local statutory time by an hour around midnight
// (see lib/lagos-time.ts).
const LAGOS_TODAY = sql`(now() AT TIME ZONE 'Africa/Lagos')::date`;

const ZERO: ReceivablesBucket = { amount: "0.00", count: 0 };

// Top debtors (who owes, worst first) — the query, row-type cast and
// snake-to-camel mapping shared by the client-level summary and the firm-level
// rollup. The SEC-03 scoping condition (supplier vs firm) is built at each
// call site and passed in, so scoping stays greppable where it is applied. The
// limit is inlined as a literal (not a bind parameter) to keep the query text
// identical to the pre-extraction queries.
async function queryTopDebtors(
  where: SQL,
  limit: number,
): Promise<ReceivablesSummary["topDebtors"]> {
  const rows = (
    await getDb().execute(sql`
      SELECT
        i.buyer_party_id,
        p.legal_name,
        i.currency,
        SUM(i.grand_total)::numeric(18,2)::text AS outstanding,
        COUNT(*)::int AS invoice_count,
        MIN(${REF_DATE})::text AS oldest_due
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE ${OUTSTANDING}
        ${where}
      GROUP BY i.buyer_party_id, p.legal_name, i.currency
      ORDER BY SUM(i.grand_total) DESC
      LIMIT ${sql.raw(String(limit))}
    `)
  ).rows as {
    buyer_party_id: string;
    legal_name: string;
    currency: string;
    outstanding: string;
    invoice_count: number;
    oldest_due: string | null;
  }[];
  return rows.map((d) => ({
    buyerPartyId: d.buyer_party_id,
    buyerName: d.legal_name,
    currency: d.currency,
    outstanding: d.outstanding,
    invoiceCount: d.invoice_count,
    oldestDueDate: d.oldest_due,
  }));
}

export async function getReceivablesSummary(
  clientPartyId: string,
  firmId: string | null,
): Promise<ReceivablesSummary> {
  const db = getDb();
  const firmCond = firmId ? sql`AND i.firm_id = ${firmId}` : sql``;

  const bucketRows = (
    await db.execute(sql`
      SELECT
        currency,
        bucket,
        SUM(grand_total)::numeric(18,2)::text AS amount,
        COUNT(*)::int AS count
      FROM (
        SELECT
          i.currency,
          i.grand_total,
          CASE
            WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 30
              THEN 'current'
            WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 60
              THEN 'days31to60'
            WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 90
              THEN 'days61to90'
            ELSE 'days90plus'
          END AS bucket
        FROM invoices i
        WHERE ${OUTSTANDING}
          AND i.supplier_party_id = ${clientPartyId}
          ${firmCond}
      ) aged
      GROUP BY currency, bucket
    `)
  ).rows as {
    currency: string;
    bucket: "current" | "days31to60" | "days61to90" | "days90plus";
    amount: string;
    count: number;
  }[];

  const byCurrency = new Map<
    string,
    ReceivablesSummary["groups"][number]["buckets"]
  >();
  for (const r of bucketRows) {
    const buckets = byCurrency.get(r.currency) ?? {
      current: ZERO,
      days31to60: ZERO,
      days61to90: ZERO,
      days90plus: ZERO,
    };
    buckets[r.bucket] = { amount: r.amount, count: r.count };
    byCurrency.set(r.currency, buckets);
  }
  const groups = [...byCurrency.entries()].map(([currency, buckets]) => {
    const total = (
      Number(buckets.current.amount) +
      Number(buckets.days31to60.amount) +
      Number(buckets.days61to90.amount) +
      Number(buckets.days90plus.amount)
    ).toFixed(2);
    return {
      currency,
      outstandingTotal: total,
      invoiceCount:
        buckets.current.count +
        buckets.days31to60.count +
        buckets.days61to90.count +
        buckets.days90plus.count,
      buckets,
    };
  });
  groups.sort((a, b) => Number(b.outstandingTotal) - Number(a.outstandingTotal));

  const topDebtors = await queryTopDebtors(
    sql`AND i.supplier_party_id = ${clientPartyId}
        ${firmCond}`,
    5,
  );

  return {
    asOf: lagosDateString(),
    groups,
    topDebtors,
  };
}

// Firm-level rollup for the console: the advisor chases on behalf of the
// whole book, so aggregate the same outstanding definition per CLIENT (who
// is owed) and per BUYER (who owes), worst first. One row per client/buyer
// per currency.
export interface FirmReceivablesClientRow {
  clientPartyId: string;
  clientName: string;
  currency: string;
  outstandingTotal: string;
  invoiceCount: number;
  overdue90Amount: string;
  oldestDueDate: string | null;
}

export interface FirmReceivables {
  asOf: string;
  clients: FirmReceivablesClientRow[];
  topDebtors: {
    buyerPartyId: string;
    buyerName: string;
    currency: string;
    outstanding: string;
    invoiceCount: number;
    oldestDueDate: string | null;
  }[];
}

export async function getFirmReceivables(
  firmId: string,
): Promise<FirmReceivables> {
  const db = getDb();
  const clientRows = (
    await db.execute(sql`
      SELECT
        i.supplier_party_id,
        p.legal_name,
        i.currency,
        SUM(i.grand_total)::numeric(18,2)::text AS outstanding,
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(i.grand_total) FILTER (
          WHERE ${LAGOS_TODAY} - ${REF_DATE} > 90
        ), 0)::numeric(18,2)::text AS overdue_90,
        MIN(${REF_DATE})::text AS oldest_due
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE ${OUTSTANDING} AND i.firm_id = ${firmId}
      GROUP BY i.supplier_party_id, p.legal_name, i.currency
      ORDER BY SUM(i.grand_total) DESC
      LIMIT 200
    `)
  ).rows as {
    supplier_party_id: string;
    legal_name: string;
    currency: string;
    outstanding: string;
    invoice_count: number;
    overdue_90: string;
    oldest_due: string | null;
  }[];

  const topDebtors = await queryTopDebtors(sql`AND i.firm_id = ${firmId}`, 10);

  return {
    asOf: lagosDateString(),
    clients: clientRows.map((r) => ({
      clientPartyId: r.supplier_party_id,
      clientName: r.legal_name,
      currency: r.currency,
      outstandingTotal: r.outstanding,
      invoiceCount: r.invoice_count,
      overdue90Amount: r.overdue_90,
      oldestDueDate: r.oldest_due,
    })),
    topDebtors,
  };
}

// Per-invoice detail behind the aging summary — the rows an accountant or
// collections call actually works from. Same outstanding definition, one row
// per invoice, oldest reference date first.
export interface ReceivableRow {
  invoiceNumber: string;
  buyerName: string;
  issueDate: string;
  dueDate: string | null;
  ageDays: number;
  bucket: string;
  currency: string;
  grandTotal: string;
  status: string;
}

export async function listOutstandingReceivables(
  clientPartyId: string,
  firmId: string | null,
): Promise<ReceivableRow[]> {
  const firmCond = firmId ? sql`AND i.firm_id = ${firmId}` : sql``;
  const rows = (
    await getDb().execute(sql`
      SELECT
        i.invoice_number,
        p.legal_name,
        i.issue_date::text AS issue_date,
        i.due_date::text AS due_date,
        (${LAGOS_TODAY} - ${REF_DATE})::int AS age_days,
        CASE
          WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 30
            THEN 'current'
          WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 60
            THEN '31-60'
          WHEN ${LAGOS_TODAY} - ${REF_DATE} <= 90
            THEN '61-90'
          ELSE '90+'
        END AS bucket,
        i.currency,
        i.grand_total::text AS grand_total,
        i.status
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE ${OUTSTANDING}
        AND i.supplier_party_id = ${clientPartyId}
        ${firmCond}
      ORDER BY ${REF_DATE} ASC
      LIMIT 50000
    `)
  ).rows as {
    invoice_number: string;
    legal_name: string;
    issue_date: string;
    due_date: string | null;
    age_days: number;
    bucket: string;
    currency: string;
    grand_total: string;
    status: string;
  }[];
  return rows.map((r) => ({
    invoiceNumber: r.invoice_number,
    buyerName: r.legal_name,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    ageDays: r.age_days,
    bucket: r.bucket,
    currency: r.currency,
    grandTotal: r.grand_total,
    status: r.status,
  }));
}
