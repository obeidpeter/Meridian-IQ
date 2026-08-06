// WHT Desk: the period's withholding remittance schedule — the BUYER side of
// withholding. The client's bills (invoices where the client is the buyer —
// the BILL_OF_CLIENT orientation, payables.ts) that carry a WHT category and
// were issued inside the period, each with the SQL-computed amount the client
// must deduct and remit to FIRS by the 21st of the following month.
//
// BASIS NOTE: the regulations say deduct at the EARLIER of payment or credit
// to the supplier's account. The schedule uses the invoice-recognition
// (issue-date) basis deliberately: a bill's payStatus is DERIVED evidence
// (settlement events — payables.ts), not a stored payment date, so an
// issue-date window is the only deterministic, replayable period assignment
// the platform can make. Evidence-only posture: the platform computes what a
// remittance period looks like; the client (or firm) remits — MeridianIQ
// never remits or claims anything itself.
import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { DomainError } from "../errors";
import { BILL_OF_CLIENT } from "../invoice/payables";
import { monthLabel } from "../clerk/client-statement";
import {
  filingDueDate,
  periodMonthBounds,
  previousLagosPeriod,
} from "../filings/statutory-calendar";
import { whtExpectedSql } from "./rates";

export interface WhtRemittanceRow {
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  category: string;
  baseAmount: string;
  whtAmount: string;
  issueDate: string;
}

export interface WhtRemittance {
  period: string;
  periodLabel: string;
  dueDate: string;
  rows: WhtRemittanceRow[];
  totals: { bills: number; whtAmount: string };
}

const PERIOD_SHAPE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function computeWhtRemittance(
  firmId: string,
  clientPartyId: string,
  period?: string,
): Promise<WhtRemittance> {
  // Default: the last CLOSED Lagos month — the period a client is remitting
  // for right now (the filings register's clock).
  const resolved = period ?? previousLagosPeriod();
  // The route regex admits "2026-13"; a real month is this module's guard.
  if (!PERIOD_SHAPE.test(resolved)) {
    throw new DomainError(
      "WHT_BAD_PERIOD",
      `period must be a real calendar month in YYYY-MM form, got "${resolved}"`,
      400,
    );
  }
  const { start, end } = periodMonthBounds(resolved);

  const rows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      vendor_name: string;
      category: string;
      base_amount: string;
      wht_amount: string;
      issue_date: string;
    }>(sql`
      SELECT
        i.id,
        i.invoice_number,
        p.legal_name AS vendor_name,
        i.wht_category AS category,
        i.subtotal::text AS base_amount,
        COALESCE(${whtExpectedSql(sql`i.subtotal`, sql`i.wht_category`)}, 0.00)::text AS wht_amount,
        i.issue_date::text AS issue_date
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        AND i.wht_category IS NOT NULL
        AND i.status <> 'cancelled'
        AND i.issue_date >= ${start}::date
        AND i.issue_date < ${end}::date
      ORDER BY i.issue_date, i.invoice_number, i.id
    `)
  ).rows;

  const mapped: WhtRemittanceRow[] = rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    vendorName: r.vendor_name,
    category: r.category,
    baseAmount: r.base_amount,
    whtAmount: r.wht_amount,
    issueDate: r.issue_date,
  }));

  return {
    period: resolved,
    periodLabel: monthLabel(`${resolved}-01`),
    // The statutory remit-by date from the shared calendar (the ONE home of
    // the 21st rule for wht — statutory-calendar.ts).
    dueDate: filingDueDate(resolved, "wht"),
    rows: mapped,
    // Totals summed FROM the rows the client sees, so table and footer can
    // never disagree.
    totals: {
      bills: mapped.length,
      whtAmount: mapped
        .reduce((acc, r) => acc + Number(r.whtAmount), 0)
        .toFixed(2),
    },
  };
}
