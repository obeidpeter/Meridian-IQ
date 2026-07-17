import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";

// Buyer payment-behaviour memory (round-9 idea #1). Reconciliation matches
// record when money ACTUALLY arrived: an accepted match ties an invoice to a
// bank-statement credit with a value date. Mining the client's own settled
// invoices per buyer gives the number the receivables card can't show — not
// "how old is this invoice" but "is this buyer late FOR THEM". 40 days
// outstanding means nothing for a buyer who always pays at 45, and
// everything for one who pays at 12.
//
// Posture, stated once: zero model calls, computed on demand, nothing
// stored. Evidence only from ACCEPTED proposals over CREDIT lines with a
// value date — the human-confirmed exhaust, never the matcher's guesses.
// Tenancy is the caller's (route layer): firm + SEC-03 client party, the
// same resolution as the recurring/line-item/unbilled miners.

// Fewer than three observed settlements is an anecdote, not behaviour.
const MIN_SETTLEMENTS = 3;
// Same trailing year as the other history miners.
const LOOKBACK_DAYS = 365;
// A credit dated before its invoice is a mis-match or an advance payment —
// either way not evidence of payment latency; small negatives are clock
// noise between bank posting and issue timestamps.
const MIN_DAYS = 0;
const MAX_BUYERS = 100;

export interface BuyerPaymentBehaviour {
  buyerPartyId: string;
  buyerName: string;
  settledCount: number;
  medianDaysToPay: number;
  lastSettledDate: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure aggregation over observed (buyer, daysToPay, valueDate) rows,
// exported for tests.
export function summarizeBehaviour(
  rows: {
    buyerPartyId: string;
    buyerName: string;
    daysToPay: number;
    valueDate: string;
  }[],
): BuyerPaymentBehaviour[] {
  const byBuyer = new Map<
    string,
    { name: string; days: number[]; last: string }
  >();
  for (const row of rows) {
    if (row.daysToPay < MIN_DAYS) continue;
    const entry = byBuyer.get(row.buyerPartyId) ?? {
      name: row.buyerName,
      days: [],
      last: row.valueDate,
    };
    entry.days.push(row.daysToPay);
    if (row.valueDate > entry.last) entry.last = row.valueDate;
    byBuyer.set(row.buyerPartyId, entry);
  }
  const out: BuyerPaymentBehaviour[] = [];
  for (const [buyerPartyId, entry] of byBuyer) {
    if (entry.days.length < MIN_SETTLEMENTS) continue;
    out.push({
      buyerPartyId,
      buyerName: entry.name,
      settledCount: entry.days.length,
      medianDaysToPay: Math.round(median(entry.days)),
      lastSettledDate: entry.last,
    });
  }
  // Best-evidenced buyers first (id tie-break keeps equal counts stable
  // across calls); cap keeps the payload a hint, not a dump.
  out.sort(
    (a, b) =>
      b.settledCount - a.settledCount ||
      a.buyerPartyId.localeCompare(b.buyerPartyId),
  );
  return out.slice(0, MAX_BUYERS);
}

// One client's per-buyer payment behaviour from its own accepted matches.
export async function listPaymentBehaviour(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<BuyerPaymentBehaviour[]> {
  const since = lagosDateString(
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
  );
  const rows = (
    await getDb().execute<{
      buyer_party_id: string;
      buyer_name: string;
      days_to_pay: number;
      value_date: string;
    }>(sql`
      SELECT
        i.buyer_party_id,
        p.legal_name AS buyer_name,
        (l.value_date - i.issue_date)::int AS days_to_pay,
        l.value_date::text AS value_date
      FROM match_proposals m
      JOIN bank_statement_lines l ON l.id = m.statement_line_id
      JOIN invoices i ON i.id = m.invoice_id
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE m.status = 'accepted'
        AND m.firm_id = ${firmId}
        AND i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND i.kind = 'invoice'
        AND l.direction = 'credit'
        AND l.value_date IS NOT NULL
        AND l.value_date >= ${since}
    `)
  ).rows;
  return summarizeBehaviour(
    rows.map((r) => ({
      buyerPartyId: r.buyer_party_id,
      buyerName: r.buyer_name,
      daysToPay: Number(r.days_to_pay),
      valueDate: r.value_date,
    })),
  );
}

// One buyer's behaviour, for surfaces anchored to a single invoice (the
// payment-chaser draft): same query scope, filtered after the fact — the
// per-client list is small and this keeps one code path.
export async function buyerPaymentBehaviour(
  firmId: string,
  clientPartyId: string,
  buyerPartyId: string,
): Promise<BuyerPaymentBehaviour | null> {
  const all = await listPaymentBehaviour(firmId, clientPartyId);
  return all.find((b) => b.buyerPartyId === buyerPartyId) ?? null;
}
