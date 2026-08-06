// Filing Desk statutory calendar: the ONE home for "which return covers which
// period and when is it due". The VAT 21st rule is today also open-coded in
// routes/sme.ts (client deadlines), modules/invoice/compliance-calendar.ts and
// modules/invoice/compliance-pack.ts — those predate this module and are left
// untouched for now; a follow-up folds them onto FILING_KINDS so the number 21
// exists in exactly one place. Everything here is pure calendar arithmetic on
// the LAGOS calendar (lib/lagos-time.ts): statutory clocks are local-day
// questions, and WAT's fixed +01:00 makes the conversion plain offset math.
import { lagosParts } from "../../lib/lagos-time";

// The closed set of return kinds the register mints (Phase 1). Due days:
//  - VAT: the 21st of the month after the period covered (FIRS — the same
//    rule the compliance calendar/pack already speak).
//  - PAYE: the 10th of the month after the period (PITA / the PAYE
//    Regulations). This date exists NOWHERE else in the codebase — this
//    module introduces it, so any future surface must import it from here.
//  - WHT (WHT Desk): withholding deducted at source must be remitted to FIRS
//    by the 21st of the following month (the Deduction at Source
//    regulations). Same 21 as VAT by statute, spelled separately because the
//    rules are independent — one moving must not move the other. NOTE:
//    mintFilingsForFirm mints wht rows CONDITIONALLY (only for clients with
//    withholding-categorised bills in the period), unlike vat/paye.
export const FILING_KINDS = [
  { taxType: "vat", dueDayOfFollowingMonth: 21 },
  { taxType: "paye", dueDayOfFollowingMonth: 10 },
  { taxType: "wht", dueDayOfFollowingMonth: 21 },
] as const;

export type FilingTaxType = (typeof FILING_KINDS)[number]["taxType"];

// "YYYY-MM" of the last CLOSED Lagos month — the period a firm is filing for
// right now (in August you file July's returns). Date.UTC's month arithmetic
// carries the year, so January hands back December of the previous year.
export function previousLagosPeriod(now = new Date()): string {
  const { year, monthIndex } = lagosParts(now);
  const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${prev.getUTCFullYear()}-${mm}`;
}

// The Lagos date string (YYYY-MM-DD) a return for `period` falls due: the
// kind's due day in the month AFTER the period. Pure calendar construction —
// Date.UTC's month-overflow carry turns a December period into January of the
// next year.
export function filingDueDate(period: string, taxType: FilingTaxType): string {
  const kind = FILING_KINDS.find((k) => k.taxType === taxType);
  if (!kind) {
    // Unreachable through typed callers; guards a raw string sneaking in.
    throw new Error(`Unknown filing taxType: ${taxType}`);
  }
  const [year, month] = period.split("-").map(Number);
  // `month` is 1-based, so as a 0-based month index it already points one
  // month past the period — exactly the following month.
  return new Date(Date.UTC(year, month, kind.dueDayOfFollowingMonth))
    .toISOString()
    .slice(0, 10);
}

// The half-open date window a "YYYY-MM" period covers: [first day, first day
// of the next month). Pure Date.UTC construction with the month-overflow
// year carry — December's end is January 1 of the next year. Shared by the
// wht mint predicate (filings.ts) and the remittance schedule
// (modules/wht/remittance.ts) so "issued in the period" has one spelling.
export function periodMonthBounds(period: string): {
  start: string;
  end: string;
} {
  const [year, month] = period.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { start, end };
}

// ---------------------------------------------------------------------------
// The ANNUAL layer (Compliance Profile round). These kinds deliberately live
// BESIDE FILING_KINDS, never inside it: FILING_KINDS is the monthly
// month-after shape the matrix and the WHT remittance schedule rely on, and
// an annual kind has no dueDayOfFollowingMonth. Annual rows are minted ONLY
// for clients whose compliance profile asserts the duty exists (evidence-only:
// a human at the firm speaks first — see modules/filings/profile.ts).
// Periods stay "YYYY-MM" (the register's one period shape): the month that
// closes the year the return covers.
export const ANNUAL_KINDS = ["cit", "cac_annual", "paye_annual"] as const;

export type AnnualFilingKind = (typeof ANNUAL_KINDS)[number];

// Everything the register can hold — the monthly kinds plus the annual layer
// (the listFilings taxType filter's closed vocabulary, matching the
// contract's enum).
export type RegisterTaxType = FilingTaxType | AnnualFilingKind;

export interface AnnualPeriodAndDue {
  // "YYYY-MM" — the closing month of the year the return covers.
  period: string;
  // "YYYY-MM-DD" — the statutory filing date.
  dueDate: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// CIT annual return (CITA s.55): due within six months of the end of the
// accounting year. The latest CLOSED financial year is the most recent
// (year, fyeMonth) strictly before the current Lagos month — a year still
// running has nothing to file. Period = the FYE month itself; due = the last
// day of the sixth month after the FYE (Date.UTC's day-0 trick hands back
// the previous month's last day, with the year carry automatic — FYE
// December is due June 30 of the next year; FYE August is due the end of
// February, leap-aware).
export function citPeriodAndDue(
  fyeMonth: number,
  now = new Date(),
): AnnualPeriodAndDue {
  const { year, monthIndex } = lagosParts(now);
  // fyeMonth is 1-based; monthIndex 0-based. The FYE month of the current
  // Lagos year has closed only when it lies STRICTLY before this month.
  const fyeYear = fyeMonth - 1 < monthIndex ? year : year - 1;
  const dueDate = new Date(Date.UTC(fyeYear, fyeMonth + 6, 0))
    .toISOString()
    .slice(0, 10);
  return { period: `${fyeYear}-${pad2(fyeMonth)}`, dueDate };
}

// CAC annual return (CAMA): a company files an annual return each calendar
// year — except the year it was incorporated (no return is owed until the
// first full calendar year begins). Simplification for the small private
// companies this register serves: one return per calendar year, due June 30
// (period "Y-06") — CAMA's actual anniversary-linked timing varies per
// company, so the register pins the conservative mid-year date. Returns null
// when no return is owed for the current Lagos year.
export function cacAnnualPeriodAndDue(
  incorporationDate: string,
  now = new Date(),
): AnnualPeriodAndDue | null {
  const { year } = lagosParts(now);
  // Owed only when the company existed before January 1 of the current
  // Lagos year (ISO date strings compare lexicographically).
  if (incorporationDate >= `${year}-01-01`) return null;
  return { period: `${year}-06`, dueDate: `${year}-06-30` };
}

// PAYE employer annual return (PITA s.81): every employer files a return of
// all emoluments paid in the PRECEDING year by January 31. Period = December
// of that preceding Lagos year; due = January 31 of the current one.
export function payeAnnualPeriodAndDue(now = new Date()): AnnualPeriodAndDue {
  const { year } = lagosParts(now);
  const prevYear = year - 1;
  return { period: `${prevYear}-12`, dueDate: `${prevYear + 1}-01-31` };
}
