import { lagosDateString } from "../../lib/lagos-time";
import { addDays } from "./date-math";
import { WEEK_COUNT, bucketProjections, receivableProjections } from "./cashflow";
import { payablesSummary, type PayablesSummary } from "./payables";
import type { CashflowOutlook } from "./cashflow";

// Net cash position (round-15 idea #2). The cash-flow outlook projects what
// should ARRIVE; the payables summary buckets what must GO OUT — and the
// question every owner actually has is the difference. This merges the two
// EXISTING computations per currency and week: inflows from the receivable
// projection engine (rhythm > due date > terms), outflows from the unpaid
// bills' due dates. Nothing is recomputed here — both sides call the same
// functions their own cards call (identical WEEK geometry: consecutive
// 7-day buckets from the Lagos today), so this view can never disagree with
// either of them. Zero model calls, computed on demand, nothing stored.
//
// Honesty notes, pinned:
//  - inflows are PROJECTIONS (when money usually arrives), outflows are
//    OBLIGATIONS (when bills fall due) — the note says so;
//  - already-late money on both sides stays OUT of the weekly nets
//    (overdue inflow may never arrive; overdue outflow should have been
//    paid already) and is reported separately;
//  - a week where committed outflows exceed projected inflows is flagged a
//    SQUEEZE week — a prompt to look, not a prediction of failure.

export interface NetPositionWeek {
  startDate: string;
  inflow: string;
  inflowCount: number;
  outflow: string;
  outflowCount: number;
  net: string;
  squeeze: boolean;
}

export interface NetCashPosition {
  asOf: string;
  groups: {
    currency: string;
    overdueInflow: { amount: string; count: number };
    overdueOutflow: { amount: string; count: number };
    weeks: NetPositionWeek[];
    // Bills with no due date / money expected beyond the window — outside
    // the weekly nets, disclosed so the totals stay explicable.
    laterInflow: { amount: string; count: number };
    laterOutflow: { amount: string; count: number };
    squeezeWeeks: number;
  }[];
  note: string;
}

// Pure merge over the two sides' bucketed groups, exported for tests. Weeks
// align by index — both engines build them as addDays(today, i * 7).
export function mergePosition(
  inflowGroups: CashflowOutlook["groups"],
  outflowGroups: PayablesSummary["groups"],
  today: string,
  weekCount = WEEK_COUNT,
): NetCashPosition["groups"] {
  const currencies = new Set([
    ...inflowGroups.map((g) => g.currency),
    ...outflowGroups.map((g) => g.currency),
  ]);
  const zero = { amount: "0.00", count: 0 };
  const groups: NetCashPosition["groups"] = [];
  for (const currency of currencies) {
    const inflow = inflowGroups.find((g) => g.currency === currency);
    const outflow = outflowGroups.find((g) => g.currency === currency);
    const weeks: NetPositionWeek[] = Array.from(
      { length: weekCount },
      (_, i) => {
        const inWeek = inflow?.weeks[i] ?? { ...zero, startDate: "" };
        const outWeek = outflow?.dueWeeks[i] ?? { ...zero, startDate: "" };
        const inAmount = Number(inWeek.amount);
        const outAmount = Number(outWeek.amount);
        return {
          startDate: addDays(today, i * 7),
          inflow: inAmount.toFixed(2),
          inflowCount: inWeek.count,
          outflow: outAmount.toFixed(2),
          outflowCount: outWeek.count,
          net: (inAmount - outAmount).toFixed(2),
          squeeze: outAmount > inAmount,
        };
      },
    );
    groups.push({
      currency,
      overdueInflow: inflow?.overdueExpected ?? zero,
      overdueOutflow: outflow?.overdue ?? zero,
      weeks,
      laterInflow: inflow?.later ?? zero,
      laterOutflow: outflow?.later ?? zero,
      squeezeWeeks: weeks.filter((w) => w.squeeze).length,
    });
  }
  // Biggest movement first: total absolute flow across the window.
  groups.sort((a, b) => {
    const flow = (g: NetCashPosition["groups"][number]) =>
      g.weeks.reduce((s, w) => s + Number(w.inflow) + Number(w.outflow), 0);
    return flow(b) - flow(a);
  });
  return groups;
}

export async function computeNetPosition(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<NetCashPosition> {
  const today = lagosDateString(now);
  const projections = await receivableProjections(firmId, clientPartyId, now);
  const inflowGroups = bucketProjections(projections, today);
  // Same `now` on both sides so a request straddling Lagos midnight cannot
  // misalign the paired week buckets (round-15 review L2).
  const outflows = await payablesSummary(firmId, clientPartyId, now);
  return {
    asOf: today,
    groups: mergePosition(inflowGroups, outflows.groups, today),
    note:
      "Inflows are projections (when your customers usually pay — rhythm, else due date, else 30-day terms); outflows are obligations (when your unpaid bills fall due). " +
      "Money already late on either side sits outside the weekly nets. A squeeze week means committed bills exceed projected receipts that week — worth a look, not a verdict.",
  };
}
