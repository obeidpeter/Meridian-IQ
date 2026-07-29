import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosTodaySql } from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS } from "./compliance-window";
import { RECEIVABLE_ORIENTATION } from "./receivables";

// Penalty exposure (round-18 idea #2). The public penalty calculator
// (artifacts/penalty-calculator/src/lib/penalty.ts) encodes MeridianIQ's
// published interpretation of the s.104 per-invoice administrative charge
// for failing to issue a compliant electronic invoice, scaled by turnover
// band. This module points that model at the client's OWN overdue paper:
// invoices past the statutory submission window and still unsubmitted are
// the platform-observable s.104 candidates.
//
// Honesty, pinned:
//  - the per-invoice charges MIRROR the calculator's published model and
//    must stay in sync with it (the calculator is a standalone artifact, so
//    the constants cannot be imported; the test pins the values);
//  - the platform does not hold the client's turnover, so the exposure is
//    reported for ALL THREE bands, and any single-number surface (the
//    digest) uses the SMALL band — the floor, never a scare figure;
//  - s.103 (access-denial days) is not platform-observable and is excluded;
//  - the overdue predicate is EXACTLY the digest/dashboard one (draft or
//    validated receivable paper past issue + window), so "overdue" has one
//    spelling; the note says estimate, not advice.

export type TurnoverBand = "small" | "medium" | "large";

// Mirrors penalty-calculator S104_PER_INVOICE — keep in sync.
export const S104_PER_INVOICE: Record<TurnoverBand, number> = {
  small: 25_000,
  medium: 50_000,
  large: 100_000,
};

export interface PenaltyExposure {
  asOf: string;
  overdueCount: number;
  // NGN, per band: overdueCount × the band's per-invoice charge.
  exposure: Record<TurnoverBand, string>;
  perInvoice: Record<TurnoverBand, string>;
  // Oldest first — the paper to clear first.
  sampleInvoices: {
    invoiceId: string;
    invoiceNumber: string;
    issueDate: string;
    daysOverdue: number;
  }[];
  note: string;
}

// Pure, exported for tests (and the one place the digest's floor figure is
// computed): overdue count → per-band exposure in whole naira strings.
export function bandExposure(overdueCount: number): Record<TurnoverBand, string> {
  const count = Math.max(0, Math.floor(overdueCount));
  return {
    small: String(count * S104_PER_INVOICE.small),
    medium: String(count * S104_PER_INVOICE.medium),
    large: String(count * S104_PER_INVOICE.large),
  };
}

const SAMPLE_LIMIT = 5;

export async function computePenaltyExposure(
  firmId: string,
  clientPartyId?: string,
): Promise<PenaltyExposure> {
  const today = lagosTodaySql();
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  // The digest/dashboard overdue predicate, verbatim: draft/validated
  // receivable paper whose statutory deadline has passed.
  const overdueCond = sql`
    i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND i.status IN ('draft', 'validated')
    AND ${RECEIVABLE_ORIENTATION}
    ${clientCond}
    AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${today}`;
  const [agg] = (
    await getDb().execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM invoices i WHERE ${overdueCond}
    `)
  ).rows;
  const overdueCount = Number(agg?.count ?? 0);
  const sample =
    overdueCount > 0
      ? (
          await getDb().execute<{
            id: string;
            invoice_number: string;
            issue_date: string;
            days_overdue: number;
          }>(sql`
            SELECT i.id, i.invoice_number, i.issue_date::text AS issue_date,
              (${today} - (i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int))::int AS days_overdue
            FROM invoices i
            WHERE ${overdueCond}
            ORDER BY i.issue_date ASC, i.id
            LIMIT ${SAMPLE_LIMIT}
          `)
        ).rows
      : [];
  const [todayRow] = (
    await getDb().execute<{ today: string }>(
      sql`SELECT ${today}::text AS today`,
    )
  ).rows;
  return {
    asOf: todayRow?.today ?? "",
    overdueCount,
    exposure: bandExposure(overdueCount),
    perInvoice: {
      small: String(S104_PER_INVOICE.small),
      medium: String(S104_PER_INVOICE.medium),
      large: String(S104_PER_INVOICE.large),
    },
    sampleInvoices: sample.map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      issueDate: r.issue_date,
      daysOverdue: Number(r.days_overdue),
    })),
    note:
      `Estimated s.104 exposure under MeridianIQ's published penalty model: each invoice past the ${SUBMISSION_WINDOW_DAYS}-day submission window and still unsubmitted, ` +
      `times the per-invoice administrative charge for the turnover band. The platform does not hold the business's turnover, so all three bands are shown — ` +
      `single-figure summaries use the small band (the floor). s.103 access-denial charges are not platform-observable and are excluded. An estimate, not legal or tax advice.`,
  };
}

// The digest's single number is NOT a second query: computeDigestFacts
// derives the small-band floor from the overdue count its own facts query
// already produced (bandExposure(count).small, null when clean) — two
// counts under the same predicate could straddle a Lagos midnight and
// let one digest contradict itself.
