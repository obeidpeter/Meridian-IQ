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
export const FILING_KINDS = [
  { taxType: "vat", dueDayOfFollowingMonth: 21 },
  { taxType: "paye", dueDayOfFollowingMonth: 10 },
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
