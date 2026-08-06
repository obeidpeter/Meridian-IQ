// Late-filing EXPOSURE for the annual return kinds — what continued
// non-filing could cost, derived deterministically from overdue register
// rows. Wording covenant: this is "exposure", never "penalty owed" — the
// platform computes what the statutes prescribe for the lateness it can see;
// only an authority assesses an actual penalty.
//
// The constants are the ONE home of these figures (closed set, documented
// approximations of the statutory schedules — flat naira amounts only, no
// turnover-linked or discretionary components):
//  - CIT (CITA s.55): ₦25,000 for the first month of failure plus ₦5,000 for
//    each further month.
//  - CAC annual return (private-company simplification of the CAMA default
//    fee schedule): ₦5,000 per year in default.
//  - PAYE employer annual return (PITA s.81, body corporate): ₦500,000 flat.
//
// Facts in SQL / deterministic TS: the overdue set comes from the register's
// own fragments (FILING_UNFILED + due_date < today, Lagos calendar), the
// arithmetic below is pure. No model is ever consulted.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, filingReturnsTable } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { FILING_UNFILED } from "./filings";
import { ANNUAL_KINDS, type AnnualFilingKind } from "./statutory-calendar";

export const CIT_FIRST_MONTH_NGN = 25_000;
export const CIT_FURTHER_MONTH_NGN = 5_000;
export const CAC_ANNUAL_YEAR_NGN = 5_000;
export const PAYE_ANNUAL_FLAT_NGN = 500_000;

export interface FilingPenaltyExposureRow {
  taxType: string;
  period: string;
  dueDate: string;
  monthsLate: number;
  // Naira as a decimal string ("25000.00") — the platform's money spelling.
  exposureNgn: string;
}

export interface FilingPenaltyExposure {
  rows: FilingPenaltyExposureRow[];
  totalNgn: string;
}

// Months late = whole calendar months elapsed since the due date, PLUS ONE:
// a row even one day past its due date is in its FIRST month of lateness
// (the statutes' "first month of failure" starts the moment the deadline
// passes, not a month later). Pure calendar-part arithmetic on the two
// YYYY-MM-DD strings — day-of-month underflow means the current month is not
// yet whole.
export function monthsLate(dueDate: string, today: string): number {
  const [dy, dm, dd] = dueDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let whole = (ty - dy) * 12 + (tm - dm);
  if (td < dd) whole -= 1;
  return Math.max(0, whole) + 1;
}

// The statutory schedule per annual kind, applied to a months-late figure.
function exposureFor(taxType: AnnualFilingKind, months: number): number {
  switch (taxType) {
    case "cit":
      return CIT_FIRST_MONTH_NGN + CIT_FURTHER_MONTH_NGN * (months - 1);
    case "cac_annual":
      // ₦5,000 per year (or part-year) in default.
      return CAC_ANNUAL_YEAR_NGN * Math.max(1, Math.ceil(months / 12));
    case "paye_annual":
      return PAYE_ANNUAL_FLAT_NGN;
  }
}

// Overdue ANNUAL register rows (the register's own boundary: unfiled AND
// due_date strictly before Lagos today — on the due day itself nothing is
// late yet), soonest-due first, exposure per row and the total summed FROM
// those rows so the two can never disagree. Monthly kinds (vat/paye/wht) are
// deliberately outside this lane — their late-remittance economics are
// interest-bearing and assessment-driven, not a flat schedule.
export async function computeFilingPenaltyExposure(
  firmId: string,
  clientPartyId?: string,
  today = lagosDateString(),
): Promise<FilingPenaltyExposure> {
  const conditions = [
    eq(filingReturnsTable.firmId, firmId),
    inArray(filingReturnsTable.taxType, [...ANNUAL_KINDS]),
    FILING_UNFILED,
    sql`${filingReturnsTable.dueDate} < ${today}::date`,
  ];
  if (clientPartyId) {
    conditions.push(eq(filingReturnsTable.clientPartyId, clientPartyId));
  }
  const overdue = await getDb()
    .select({
      taxType: filingReturnsTable.taxType,
      period: filingReturnsTable.period,
      dueDate: filingReturnsTable.dueDate,
    })
    .from(filingReturnsTable)
    .where(and(...conditions))
    .orderBy(asc(filingReturnsTable.dueDate), asc(filingReturnsTable.id));
  let total = 0;
  const rows: FilingPenaltyExposureRow[] = overdue.map((r) => {
    const months = monthsLate(r.dueDate, today);
    const exposure = exposureFor(r.taxType as AnnualFilingKind, months);
    total += exposure;
    return {
      taxType: r.taxType,
      period: r.period,
      dueDate: r.dueDate,
      monthsLate: months,
      exposureNgn: exposure.toFixed(2),
    };
  });
  return { rows, totalNgn: total.toFixed(2) };
}
