import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { OUTSTANDING } from "./receivables";
import {
  listPaymentBehaviour,
  type BuyerPaymentBehaviour,
} from "./payment-behaviour";

// Cash-flow outlook + chase list (round-10 ideas #1 and #2). The
// payment-behaviour miner's two natural consumers, sharing one projection:
// each outstanding receivable's EXPECTED settlement date is the buyer's own
// observed rhythm (issue + median days-to-pay) where behaviour exists,
// otherwise the stated due date, otherwise issue + default terms.
//
//  - The OUTLOOK rolls the projections up into four consecutive week
//    buckets, with money already past its expected date in its own bucket
//    (late money is not future inflow).
//  - The CHASE LIST ranks the invoices past their expected date, most
//    beyond first — "late for THEM", not merely old — capped to a Monday
//    -morning list, each row linking to the invoice's chaser button.
//
// Posture: zero model calls, computed on demand, nothing stored. Same
// outstanding definition as receivables.ts (shared fragment), same
// firm + SEC-03 client tenancy as every miner (enforced by the route).

// Buyers with no behaviour and no due date are projected at standard terms.
const DEFAULT_TERMS_DAYS = 30;
const WEEK_COUNT = 4;
const MAX_CHASE_ROWS = 8;

export type ProjectionBasis = "rhythm" | "dueDate" | "terms";

export interface ReceivableProjection {
  invoiceId: string;
  invoiceNumber: string;
  buyerPartyId: string;
  buyerName: string;
  currency: string;
  grandTotal: string;
  issueDate: string;
  dueDate: string | null;
  expectedDate: string;
  basis: ProjectionBasis;
  // Positive = past the expected date by this many days.
  daysBeyondExpected: number;
}

export interface CashflowBucket {
  amount: string;
  count: number;
}

export interface CashflowOutlook {
  asOf: string;
  groups: {
    currency: string;
    // Money already past its expected date — late, not future inflow.
    overdueExpected: CashflowBucket;
    // Consecutive 7-day buckets starting today.
    weeks: { startDate: string; amount: string; count: number }[];
    // Expected beyond the last week bucket.
    later: CashflowBucket;
    total: CashflowBucket;
  }[];
}

export interface ChaseRow {
  invoiceId: string;
  invoiceNumber: string;
  buyerPartyId: string;
  buyerName: string;
  currency: string;
  grandTotal: string;
  dueDate: string | null;
  expectedDate: string;
  basis: ProjectionBasis;
  daysBeyondExpected: number;
}

function addDays(dateString: string, days: number): string {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

interface OutstandingRow {
  invoiceId: string;
  invoiceNumber: string;
  buyerPartyId: string;
  buyerName: string;
  currency: string;
  grandTotal: string;
  issueDate: string;
  dueDate: string | null;
}

// The shared pure projection, exported for tests.
export function projectReceivables(
  rows: OutstandingRow[],
  behaviourByBuyer: Map<string, BuyerPaymentBehaviour>,
  today: string,
): ReceivableProjection[] {
  return rows.map((r) => {
    const behaviour = behaviourByBuyer.get(r.buyerPartyId);
    let expectedDate: string;
    let basis: ProjectionBasis;
    if (behaviour) {
      expectedDate = addDays(r.issueDate, behaviour.medianDaysToPay);
      basis = "rhythm";
    } else if (r.dueDate) {
      expectedDate = r.dueDate;
      basis = "dueDate";
    } else {
      expectedDate = addDays(r.issueDate, DEFAULT_TERMS_DAYS);
      basis = "terms";
    }
    return {
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      buyerPartyId: r.buyerPartyId,
      buyerName: r.buyerName,
      currency: r.currency,
      grandTotal: r.grandTotal,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      expectedDate,
      basis,
      daysBeyondExpected: daysBetween(expectedDate, today),
    };
  });
}

// Pure roll-up, exported for tests.
export function bucketProjections(
  projections: ReceivableProjection[],
  today: string,
): CashflowOutlook["groups"] {
  const byCurrency = new Map<string, ReceivableProjection[]>();
  for (const p of projections) {
    const list = byCurrency.get(p.currency) ?? [];
    list.push(p);
    byCurrency.set(p.currency, list);
  }
  const groups: CashflowOutlook["groups"] = [];
  for (const [currency, list] of byCurrency) {
    const zero = () => ({ amount: 0, count: 0 });
    const overdue = zero();
    const later = zero();
    const total = zero();
    const weeks = Array.from({ length: WEEK_COUNT }, (_, i) => ({
      startDate: addDays(today, i * 7),
      ...zero(),
    }));
    for (const p of list) {
      const amount = Number(p.grandTotal);
      if (!Number.isFinite(amount)) continue;
      total.amount += amount;
      total.count += 1;
      if (p.daysBeyondExpected > 0) {
        overdue.amount += amount;
        overdue.count += 1;
      } else {
        const weekIndex = Math.floor(-p.daysBeyondExpected / 7);
        const target = weekIndex < WEEK_COUNT ? weeks[weekIndex] : later;
        target.amount += amount;
        target.count += 1;
      }
    }
    const money = (b: { amount: number; count: number }) => ({
      amount: b.amount.toFixed(2),
      count: b.count,
    });
    groups.push({
      currency,
      overdueExpected: money(overdue),
      weeks: weeks.map((w) => ({
        startDate: w.startDate,
        amount: w.amount.toFixed(2),
        count: w.count,
      })),
      later: money(later),
      total: money(total),
    });
  }
  groups.sort((a, b) => Number(b.total.amount) - Number(a.total.amount));
  return groups;
}

// Pure ranking, exported for tests: only invoices past their expected date
// AND past their stated due date where one exists — a buyer may habitually
// pay faster than the agreed terms, and telling a client to chase an invoice
// that is not yet contractually due is a relationship own-goal (the round-9
// chaser draft would also contradict the row by saying "falls due on ...").
// Ranking stays "late for THEM": most days beyond expectation first, amount
// as tie-break. Within the caller's primary currency only — raw magnitudes
// across currencies are not comparable.
export function rankChaseRows(
  projections: ReceivableProjection[],
  today: string,
): ChaseRow[] {
  return projections
    .filter(
      (p) =>
        p.daysBeyondExpected > 0 && (p.dueDate === null || p.dueDate < today),
    )
    .sort(
      (a, b) =>
        b.daysBeyondExpected - a.daysBeyondExpected ||
        Number(b.grandTotal) - Number(a.grandTotal),
    )
    .slice(0, MAX_CHASE_ROWS)
    .map((p) => ({
      invoiceId: p.invoiceId,
      invoiceNumber: p.invoiceNumber,
      buyerPartyId: p.buyerPartyId,
      buyerName: p.buyerName,
      currency: p.currency,
      grandTotal: p.grandTotal,
      dueDate: p.dueDate,
      expectedDate: p.expectedDate,
      basis: p.basis,
      daysBeyondExpected: p.daysBeyondExpected,
    }));
}

async function outstandingRows(
  firmId: string,
  clientPartyId: string,
): Promise<OutstandingRow[]> {
  const rows = (
    await getDb().execute<{
      invoice_id: string;
      invoice_number: string;
      buyer_party_id: string;
      buyer_name: string;
      currency: string;
      grand_total: string;
      issue_date: string;
      due_date: string | null;
    }>(sql`
      SELECT
        i.id AS invoice_id,
        i.invoice_number,
        i.buyer_party_id,
        p.legal_name AS buyer_name,
        i.currency,
        i.grand_total::text AS grand_total,
        i.issue_date::text AS issue_date,
        i.due_date::text AS due_date
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE ${OUTSTANDING}
        AND i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
      ORDER BY i.issue_date ASC
      LIMIT 50000
    `)
  ).rows;
  return rows.map((r) => ({
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    buyerPartyId: r.buyer_party_id,
    buyerName: r.buyer_name,
    currency: r.currency,
    grandTotal: r.grand_total,
    issueDate: r.issue_date,
    dueDate: r.due_date,
  }));
}

// One client's projected receivables — the shared input for the outlook, the
// chase list, the Ask Clerk money intents and the digest's firm summary.
export async function receivableProjections(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<ReceivableProjection[]> {
  const [rows, behaviour] = await Promise.all([
    outstandingRows(firmId, clientPartyId),
    listPaymentBehaviour(firmId, clientPartyId, now),
  ]);
  return projectReceivables(
    rows,
    new Map(behaviour.map((b) => [b.buyerPartyId, b])),
    lagosDateString(now),
  );
}

export async function computeCashflowOutlook(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<CashflowOutlook> {
  const today = lagosDateString(now);
  return {
    asOf: today,
    groups: bucketProjections(await receivableProjections(firmId, clientPartyId, now), today),
  };
}

export async function listChaseRows(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<ChaseRow[]> {
  const all = await receivableProjections(firmId, clientPartyId, now);
  // Primary currency = the biggest outstanding total, matching the outlook
  // card's first-group convention; cross-currency magnitudes don't rank.
  const totals = new Map<string, number>();
  for (const p of all) {
    const amount = Number(p.grandTotal);
    if (!Number.isFinite(amount)) continue;
    totals.set(p.currency, (totals.get(p.currency) ?? 0) + amount);
  }
  const primary = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return rankChaseRows(
    primary ? all.filter((p) => p.currency === primary) : all,
    lagosDateString(now),
  );
}

// ---------------------------------------------------------------------------
// Firm-level money summary (round-11): the same projections rolled up across
// every client with outstanding receivables — the digest's money facts and
// Ask Clerk's firm-wide money intents. Counts are currency-safe; the NGN
// total follows the data-intent convention (grand_total summed, NGN-first
// platform). Clients are capped by outstanding value, biggest books first;
// the cap is far above any SME firm's client count.
// ---------------------------------------------------------------------------

const MAX_SUMMARY_CLIENTS = 50;

export interface FirmChaseRow extends ChaseRow {
  clientName: string;
}

export interface FirmMoneySummary {
  // Projections due inside the next 7 days (not yet past expectation).
  expectedWeekCount: number;
  expectedWeekTotalNgn: string;
  // Past their expected date (whatever the basis) — late money.
  overdueExpectedCount: number;
  // Past BOTH expectation and due date — the chase-eligible set.
  chaseCount: number;
  // Top chase rows across clients, ranked by days beyond expectation (a
  // currency-free measure), for surfaces that name names.
  topChase: FirmChaseRow[];
}

export async function firmMoneySummary(
  firmId: string,
  now: Date = new Date(),
): Promise<FirmMoneySummary> {
  const today = lagosDateString(now);
  const clients = (
    await getDb().execute<{ supplier_party_id: string; client_name: string }>(
      sql`
        SELECT i.supplier_party_id, p.legal_name AS client_name
        FROM invoices i
        JOIN parties p ON p.id = i.supplier_party_id
        WHERE ${OUTSTANDING} AND i.firm_id = ${firmId}
        GROUP BY 1, 2
        ORDER BY SUM(i.grand_total) DESC
        LIMIT ${MAX_SUMMARY_CLIENTS}
      `,
    )
  ).rows;

  let expectedWeekCount = 0;
  let expectedWeekTotal = 0;
  let overdueExpectedCount = 0;
  let chaseCount = 0;
  const topChase: FirmChaseRow[] = [];
  for (const client of clients) {
    const projections = await receivableProjections(
      firmId,
      client.supplier_party_id,
      now,
    );
    for (const p of projections) {
      if (p.daysBeyondExpected > 0) {
        overdueExpectedCount += 1;
        // Chase-eligible mirrors rankChaseRows' filter exactly; counted here
        // because the ranker caps per client and a count must not.
        if (p.dueDate === null || p.dueDate < today) chaseCount += 1;
      } else if (p.daysBeyondExpected > -7) {
        expectedWeekCount += 1;
        const amount = Number(p.grandTotal);
        if (Number.isFinite(amount)) expectedWeekTotal += amount;
      }
    }
    for (const row of rankChaseRows(projections, today)) {
      topChase.push({ ...row, clientName: client.client_name });
    }
  }
  topChase.sort(
    (a, b) =>
      b.daysBeyondExpected - a.daysBeyondExpected ||
      Number(b.grandTotal) - Number(a.grandTotal),
  );
  return {
    expectedWeekCount,
    expectedWeekTotalNgn: expectedWeekTotal.toFixed(2),
    overdueExpectedCount,
    chaseCount,
    topChase: topChase.slice(0, MAX_CHASE_ROWS),
  };
}
