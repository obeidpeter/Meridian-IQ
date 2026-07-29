import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { BILL_OF_CLIENT, BILL_UNPAID } from "./payables";

// Double-payment guard (round-16 idea #3). Two deterministic detectors over
// the client's bills, both advisory — nothing is blocked, filed, or written:
//  - a bill whose bank evidence shows the money leaving TWICE: two or more
//    DISTINCT statement-line matches whose amounts sum to MORE than the
//    bill. Payer flags are attestation, not money movement, and a flag
//    followed by its confirming statement match is the ordinary lifecycle —
//    neither counts toward "paid twice". Partial payments that sum to the
//    total are installments, not a double payment.
//  - near-duplicate bills from the same supplier for the same grand total
//    with issue dates within 14 days of each other, where at least one side
//    is still UNPAID — including the riskiest shape, a paid original next to
//    its unpaid re-captured copy (the pair becomes a double payment the
//    moment the copy is paid). Two already-paid bills are history, not a
//    warning.
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
  // Distinct bank-statement debits matched to this bill.
  evidenceCount: number;
  firstPaidAt: string;
  lastPaidAt: string;
}

export interface DuplicateBillPair {
  supplierName: string;
  currency: string;
  grandTotal: string;
  // "paid_original": `first` is already paid, `second` is the unpaid copy.
  // "both_unpaid": neither has payment evidence yet.
  pairKind: "both_unpaid" | "paid_original";
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
  // Detector 1: money observed leaving twice. Only bank evidence counts:
  // distinct statement lines (COALESCE guards a hypothetical line-less
  // match — each such event is then its own debit), and the matched total
  // must EXCEED the bill so installments never flag.
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
        SELECT COUNT(DISTINCT COALESCE(se.statement_line_id, se.id))::int AS n,
               SUM(se.amount) AS matched_total,
               MIN(se.occurred_at) AS first_at,
               MAX(se.occurred_at) AS last_at
        FROM settlement_events se
        WHERE se.invoice_id = i.id
          AND se.source = 'statement_match'
      ) ev ON ev.n >= 2 AND ev.matched_total > i.grand_total
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
      ORDER BY ev.n DESC, i.created_at DESC, i.id
      LIMIT ${DETECTOR_CAP}
    `)
  ).rows;

  // Detector 2: near-duplicate pairs — same supplier, same currency, same
  // grand total, issue dates within NEAR_DUP_DAYS. The CTE materializes the
  // client's bills through the canonical fragments with their derived paid
  // flag (the exact complement of BILL_UNPAID — one spelling of "payment
  // evidence"); the self-join keeps pairs whose SECOND side is unpaid.
  // Dedup: unpaid×unpaid pairs appear once via a.id < b.id; a paid bill
  // always takes the `a` (first) seat, and its mirror is excluded because
  // the b side must be unpaid.
  const dupRows = (
    await getDb().execute<{
      supplier_name: string;
      currency: string;
      grand_total: string;
      a_paid: boolean;
      a_id: string;
      a_number: string;
      a_issue: string;
      b_id: string;
      b_number: string;
      b_issue: string;
      days_apart: number;
    }>(sql`
      WITH client_bills AS (
        SELECT i.id, i.supplier_party_id, i.currency, i.grand_total,
               i.invoice_number, i.issue_date,
               (NOT (${BILL_UNPAID})) AS is_paid
        FROM invoices i
        WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        ORDER BY i.id
        LIMIT 50000
      )
      SELECT
        p.legal_name AS supplier_name,
        a.currency,
        a.grand_total::text AS grand_total,
        a.is_paid AS a_paid,
        a.id AS a_id, a.invoice_number AS a_number, a.issue_date::text AS a_issue,
        b.id AS b_id, b.invoice_number AS b_number, b.issue_date::text AS b_issue,
        ABS(a.issue_date - b.issue_date)::int AS days_apart
      FROM client_bills a
      JOIN client_bills b
        ON b.supplier_party_id = a.supplier_party_id
        AND b.currency = a.currency
        AND b.grand_total = a.grand_total
        AND ABS(a.issue_date - b.issue_date) <= ${NEAR_DUP_DAYS}
        AND b.is_paid = false
        AND a.id <> b.id
        AND (a.is_paid OR a.id < b.id)
      JOIN parties p ON p.id = a.supplier_party_id
      ORDER BY a.issue_date DESC, a.id, b.id
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
      pairKind: r.a_paid ? ("paid_original" as const) : ("both_unpaid" as const),
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
      `Advisory only. "Paid twice" flags bills matched to two or more distinct bank-statement debits totalling more than the bill; ` +
      `"possible duplicates" flags same-supplier same-amount bills issued within ${NEAR_DUP_DAYS} days of each other where one is still unpaid — including a paid original next to an unpaid copy. ` +
      `A repeated standing charge (e.g. monthly rent) can legitimately match — review before acting.`,
  };
}
