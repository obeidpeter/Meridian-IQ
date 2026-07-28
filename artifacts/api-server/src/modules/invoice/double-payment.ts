import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { BILL_OF_CLIENT, BILL_UNPAID } from "./payables";

// Double-payment guard (round-16 idea #3). Two deterministic detectors over
// the client's bills, both advisory — nothing is blocked, filed, or written:
//  - a bill carrying TWO OR MORE independent payment evidences (a paid flag
//    AND a statement match, or two statement matches) — the money may have
//    left twice;
//  - two UNPAID bills from the same supplier for the same grand total with
//    issue dates within 14 days of each other — a likely re-captured or
//    re-sent vendor invoice that would become a double payment if both are
//    paid.
// Same posture as the projection-accuracy report: pure SQL, evidence the
// platform already holds, a human decides what to do.

const NEAR_DUP_DAYS = 14;
const DETECTOR_CAP = 20;

export interface MultiPaidBill {
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  currency: string;
  grandTotal: string;
  evidenceCount: number;
  firstPaidAt: string;
  lastPaidAt: string;
}

export interface DuplicateBillPair {
  supplierName: string;
  currency: string;
  grandTotal: string;
  first: { invoiceId: string; invoiceNumber: string; issueDate: string };
  second: { invoiceId: string; invoiceNumber: string; issueDate: string };
  daysApart: number;
}

export interface DoublePaymentCheck {
  multiPaid: MultiPaidBill[];
  duplicateCandidates: DuplicateBillPair[];
  note: string;
}

export async function computeDoublePaymentCheck(
  firmId: string,
  clientPartyId: string,
): Promise<DoublePaymentCheck> {
  // Detector 1: bills with 2+ payment evidences. The evidence predicate is
  // the exact complement of BILL_UNPAID's inner condition — one spelling of
  // "this event is payment evidence".
  const multiPaidRows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      supplier_name: string;
      currency: string;
      grand_total: string;
      evidence_count: number;
      first_paid_at: string;
      last_paid_at: string;
    }>(sql`
      SELECT
        i.id,
        i.invoice_number,
        p.legal_name AS supplier_name,
        i.currency,
        i.grand_total::text AS grand_total,
        ev.n AS evidence_count,
        ev.first_at::text AS first_paid_at,
        ev.last_at::text AS last_paid_at
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               MIN(se.occurred_at) AS first_at,
               MAX(se.occurred_at) AS last_at
        FROM settlement_events se
        WHERE se.invoice_id = i.id
          AND (se.payment_status = 'paid' OR se.source = 'statement_match')
      ) ev ON ev.n >= 2
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
      ORDER BY ev.n DESC, i.created_at DESC
      LIMIT ${DETECTOR_CAP}
    `)
  ).rows;

  // Detector 2: unpaid near-duplicate pairs — same supplier, same currency,
  // same grand total, issue dates within NEAR_DUP_DAYS. The CTE materializes
  // the client's unpaid bills through the canonical fragments (one spelling
  // of "unpaid bill"), then a pairwise self-join ordered a.id < b.id shows
  // each pair once.
  const dupRows = (
    await getDb().execute<{
      supplier_name: string;
      currency: string;
      grand_total: string;
      a_id: string;
      a_number: string;
      a_issue: string;
      b_id: string;
      b_number: string;
      b_issue: string;
      days_apart: number;
    }>(sql`
      WITH unpaid_bills AS (
        SELECT i.id, i.supplier_party_id, i.currency, i.grand_total,
               i.invoice_number, i.issue_date
        FROM invoices i
        WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
          AND ${BILL_UNPAID}
        LIMIT 50000
      )
      SELECT
        p.legal_name AS supplier_name,
        a.currency,
        a.grand_total::text AS grand_total,
        a.id AS a_id, a.invoice_number AS a_number, a.issue_date::text AS a_issue,
        b.id AS b_id, b.invoice_number AS b_number, b.issue_date::text AS b_issue,
        ABS(a.issue_date - b.issue_date)::int AS days_apart
      FROM unpaid_bills a
      JOIN unpaid_bills b
        ON b.supplier_party_id = a.supplier_party_id
        AND b.currency = a.currency
        AND b.grand_total = a.grand_total
        AND ABS(a.issue_date - b.issue_date) <= ${NEAR_DUP_DAYS}
        AND a.id < b.id
      JOIN parties p ON p.id = a.supplier_party_id
      ORDER BY a.issue_date DESC, a.id
      LIMIT ${DETECTOR_CAP}
    `)
  ).rows;

  return {
    multiPaid: multiPaidRows.map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      supplierName: r.supplier_name,
      currency: r.currency,
      grandTotal: r.grand_total,
      evidenceCount: Number(r.evidence_count),
      firstPaidAt: new Date(r.first_paid_at).toISOString(),
      lastPaidAt: new Date(r.last_paid_at).toISOString(),
    })),
    duplicateCandidates: dupRows.map((r) => ({
      supplierName: r.supplier_name,
      currency: r.currency,
      grandTotal: r.grand_total,
      first: {
        invoiceId: r.a_id,
        invoiceNumber: r.a_number,
        issueDate: r.a_issue,
      },
      second: {
        invoiceId: r.b_id,
        invoiceNumber: r.b_number,
        issueDate: r.b_issue,
      },
      daysApart: Number(r.days_apart),
    })),
    note:
      `Advisory only. "Paid twice" flags bills carrying two or more independent payment evidences; ` +
      `"possible duplicates" flags unpaid bills from the same supplier for the same amount issued within ${NEAR_DUP_DAYS} days of each other. ` +
      `A repeated standing charge (e.g. monthly rent) can legitimately match — review before acting.`,
  };
}
