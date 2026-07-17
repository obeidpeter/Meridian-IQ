import { lagosDateString } from "../../lib/lagos-time";
import {
  acceptedSettlementRows,
  median,
  type SettlementEvidenceRow,
} from "./payment-behaviour";

// Projection accuracy report (round-14 idea #2). The cash-flow outlook
// projects when money will arrive (buyer rhythm > due date > default 30-day
// terms) — and nothing measured whether those projections come true. This
// replays the SAME three-tier rule against every OBSERVED settlement and
// reports the error: the forecast auditing itself, the same
// exhaust-audits-the-exhaust posture as exemplar hygiene. Zero model calls,
// computed on demand, nothing stored.
//
// Honesty notes, pinned:
//  - the rhythm tier is evaluated LEAVE-ONE-OUT: a settlement is predicted
//    from the buyer's OTHER settlements only (needing 3+ of them, the same
//    floor the live miner uses), so a payment never predicts itself;
//  - the rhythm is computed over today's trailing window, not the window as
//    it stood on the invoice's issue date — a mild hindsight approximation,
//    disclosed in the note rather than silently ignored;
//  - error is signed (positive = money arrived LATER than projected).

const MIN_RHYTHM_OTHERS = 3;
const DEFAULT_TERMS_DAYS = 30;
const WITHIN_DAYS = 7;
const MAX_BUYERS = 50;
const MIN_BUYER_SETTLEMENTS = 3;

export type ProjectionBasis = "rhythm" | "dueDate" | "defaultTerms";

export interface ProjectionAccuracyBuyer {
  buyerPartyId: string;
  buyerName: string;
  settlements: number;
  medianErrorDays: number;
  medianAbsErrorDays: number;
  withinShare: number;
}

export interface ProjectionAccuracy {
  asOf: string;
  withinDays: number;
  settlements: number;
  medianErrorDays: number | null;
  medianAbsErrorDays: number | null;
  withinShare: number | null;
  basisSplit: { rhythm: number; dueDate: number; defaultTerms: number };
  buyers: ProjectionAccuracyBuyer[];
  note: string;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

// Pure evaluation over the evidence rows, exported for tests. Mirrors the
// cashflow projection rule tier for tier.
export function summarizeProjectionAccuracy(
  rows: SettlementEvidenceRow[],
  asOf: string,
): ProjectionAccuracy {
  const byBuyer = new Map<string, SettlementEvidenceRow[]>();
  for (const row of rows) {
    if (row.daysToPay < 0) continue; // mis-match/advance — not latency evidence
    const list = byBuyer.get(row.buyerPartyId) ?? [];
    list.push(row);
    byBuyer.set(row.buyerPartyId, list);
  }

  const errors: number[] = [];
  const basisSplit = { rhythm: 0, dueDate: 0, defaultTerms: 0 };
  const buyerErrors = new Map<string, { name: string; errors: number[] }>();

  for (const [buyerPartyId, list] of byBuyer) {
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const others = list
        .filter((_, j) => j !== i)
        .map((r) => r.daysToPay);
      let predicted: number;
      let basis: ProjectionBasis;
      if (others.length >= MIN_RHYTHM_OTHERS) {
        predicted = Math.round(median(others));
        basis = "rhythm";
      } else if (row.dueDate) {
        predicted = Math.max(0, daysBetween(row.issueDate, row.dueDate));
        basis = "dueDate";
      } else {
        predicted = DEFAULT_TERMS_DAYS;
        basis = "defaultTerms";
      }
      const error = row.daysToPay - predicted;
      errors.push(error);
      basisSplit[basis]++;
      const entry = buyerErrors.get(buyerPartyId) ?? {
        name: row.buyerName,
        errors: [],
      };
      entry.errors.push(error);
      buyerErrors.set(buyerPartyId, entry);
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const share4 = (n: number, d: number) => Math.round((n / d) * 10000) / 10000;

  const buyers: ProjectionAccuracyBuyer[] = [];
  for (const [buyerPartyId, entry] of buyerErrors) {
    if (entry.errors.length < MIN_BUYER_SETTLEMENTS) continue;
    buyers.push({
      buyerPartyId,
      buyerName: entry.name,
      settlements: entry.errors.length,
      medianErrorDays: round1(median(entry.errors)),
      medianAbsErrorDays: round1(median(entry.errors.map(Math.abs))),
      withinShare: share4(
        entry.errors.filter((e) => Math.abs(e) <= WITHIN_DAYS).length,
        entry.errors.length,
      ),
    });
  }
  buyers.sort(
    (a, b) =>
      b.settlements - a.settlements ||
      a.buyerPartyId.localeCompare(b.buyerPartyId),
  );

  return {
    asOf,
    withinDays: WITHIN_DAYS,
    settlements: errors.length,
    medianErrorDays: errors.length > 0 ? round1(median(errors)) : null,
    medianAbsErrorDays:
      errors.length > 0 ? round1(median(errors.map(Math.abs))) : null,
    withinShare:
      errors.length > 0
        ? share4(
            errors.filter((e) => Math.abs(e) <= WITHIN_DAYS).length,
            errors.length,
          )
        : null,
    basisSplit,
    buyers: buyers.slice(0, MAX_BUYERS),
    note:
      `Every observed settlement replayed against the projection rule the cash-flow outlook uses (buyer rhythm, else due date, else ${DEFAULT_TERMS_DAYS}-day terms); rhythm predictions exclude the payment being predicted. ` +
      `Positive error means money arrived later than projected. Rhythms are measured over today's trailing year, so very old settlements are judged with mild hindsight.`,
  };
}

export async function computeProjectionAccuracy(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<ProjectionAccuracy> {
  const rows = await acceptedSettlementRows(firmId, clientPartyId, now);
  return summarizeProjectionAccuracy(rows, lagosDateString(now));
}
