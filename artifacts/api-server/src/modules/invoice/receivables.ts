import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

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

const ZERO: ReceivablesBucket = { amount: "0.00", count: 0 };

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
            WHEN current_date - COALESCE(i.due_date, i.issue_date) <= 30
              THEN 'current'
            WHEN current_date - COALESCE(i.due_date, i.issue_date) <= 60
              THEN 'days31to60'
            WHEN current_date - COALESCE(i.due_date, i.issue_date) <= 90
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

  const debtorRows = (
    await db.execute(sql`
      SELECT
        i.buyer_party_id,
        p.legal_name,
        i.currency,
        SUM(i.grand_total)::numeric(18,2)::text AS outstanding,
        COUNT(*)::int AS invoice_count,
        MIN(COALESCE(i.due_date, i.issue_date))::text AS oldest_due
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE ${OUTSTANDING}
        AND i.supplier_party_id = ${clientPartyId}
        ${firmCond}
      GROUP BY i.buyer_party_id, p.legal_name, i.currency
      ORDER BY SUM(i.grand_total) DESC
      LIMIT 5
    `)
  ).rows as {
    buyer_party_id: string;
    legal_name: string;
    currency: string;
    outstanding: string;
    invoice_count: number;
    oldest_due: string | null;
  }[];

  return {
    asOf: new Date().toISOString().slice(0, 10),
    groups,
    topDebtors: debtorRows.map((d) => ({
      buyerPartyId: d.buyer_party_id,
      buyerName: d.legal_name,
      currency: d.currency,
      outstanding: d.outstanding,
      invoiceCount: d.invoice_count,
      oldestDueDate: d.oldest_due,
    })),
  };
}
