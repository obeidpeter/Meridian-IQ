import { and, eq, gte, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  getDb,
  engagementsTable,
  invoicesTable,
  partiesTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import {
  buyerBillingHistories,
  LOOKBACK_DAYS,
  MAX_PATTERN_ALERTS,
  patternAlertFor,
  type HistoryRow,
} from "./recurring-suggest";
import { ngnRankFor } from "./missing-bills";

// Unbilled-income detection (round-8 idea #1). The flip side of the recurring
// suggestions: the same deterministic miner that spots "this client bills that
// buyer every month" can spot the month the invoice DIDN'T go out. Computed on
// demand — zero model calls, nothing stored — from the client's own invoice
// history, under the SAME pattern thresholds and template exclusions as the
// recurring suggestions (buyerBillingHistories), so the two cards can never
// disagree about what counts as a habit.
//
// An alert fires only inside the bounded window [expected + grace,
// expected + max] (both ends inclusive):
//  - GRACE_DAYS of slack first — cadences wobble, and nagging on day one of
//    a slipped cycle teaches the client to ignore the card;
//  - silence past MAX_OVERDUE_DAYS means the arrangement probably ENDED — a
//    lapsed retainer is not "unbilled income", and a card that nags forever
//    about a customer the client lost is worse than no card. (If billing
//    resumes, the pattern's lastIssueDate moves and the check re-arms.)
export interface UnbilledIncomeAlert {
  buyerPartyId: string;
  buyerName: string;
  currency: string;
  count: number;
  medianAmount: string;
  medianGapDays: number;
  lastIssueDate: string;
  expectedByDate: string;
  overdueDays: number;
}

// Pure projection over one buyer's mined pattern, exported for tests — the
// shared alert-window core (recurring-suggest.ts patternAlertFor) pointed
// at the income side; signature and returned shape unchanged.
export function unbilledAlertFor(
  invoices: HistoryRow[],
  todayLagos: string,
): Omit<UnbilledIncomeAlert, "buyerPartyId" | "buyerName" | "currency"> | null {
  return patternAlertFor(invoices, todayLagos);
}

// Most recent captured non-null fx_rate_to_ngn per foreign (buyer, currency)
// group of one client's invoice history, keyed `${buyerPartyId}:${currency}`.
// buyerBillingHistories (recurring-suggest.ts — shared with the suggestions
// card, which ranks by COUNT and needs no rates) does not carry fx rates, so
// the ranking rate is a second pass over the same mined year: same firm,
// client, kind and cancelled/credited exclusions, so the rate can only come
// from paper the miner itself would see.
async function latestForeignFxRates(
  firmId: string,
  clientPartyId: string,
  since: string,
): Promise<Map<string, number>> {
  const rows = (
    await getDb().execute<{
      buyer_party_id: string;
      currency: string;
      fx_rate: string;
    }>(sql`
      SELECT DISTINCT ON (i.buyer_party_id, i.currency)
        i.buyer_party_id, i.currency, i.fx_rate_to_ngn::text AS fx_rate
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND i.kind = 'invoice'
        AND i.status NOT IN ('cancelled', 'credited')
        AND i.currency <> 'NGN'
        AND i.fx_rate_to_ngn IS NOT NULL
        AND i.issue_date >= ${since}
      ORDER BY i.buyer_party_id, i.currency, i.issue_date DESC, i.id DESC
    `)
  ).rows;
  const rates = new Map<string, number>();
  for (const r of rows) {
    const rate = Number(r.fx_rate);
    if (Number.isFinite(rate) && rate > 0) {
      rates.set(`${r.buyer_party_id}:${r.currency}`, rate);
    }
  }
  return rates;
}

// One client's expected-but-absent invoices, biggest money (in naira
// equivalent) first: the top-N cut orders by ngnRankFor (missing-bills.ts —
// the shared rule: NGN at face value, foreign at the group's most recent
// captured rate, unconvertible foreign at face value), never by raw face
// value — a USD retainer must not lose its slot to a smaller NGN one.
// Displayed amounts stay in the original currency. The caller (route layer)
// owns tenancy + SEC-03 party scoping, same as the recurring suggestions
// this mirrors.
export async function listUnbilledIncome(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<UnbilledIncomeAlert[]> {
  const byBuyer = await buyerBillingHistories(firmId, clientPartyId);
  const today = lagosDateString(now);
  const alerts: UnbilledIncomeAlert[] = [];
  for (const entry of byBuyer.values()) {
    const alert = unbilledAlertFor(entry.invoices, today);
    if (alert) {
      alerts.push({
        buyerPartyId: entry.buyerPartyId,
        buyerName: entry.name,
        currency: entry.currency,
        ...alert,
      });
    }
  }
  // Rates are only fetched when a foreign-currency alert actually needs one
  // — the all-NGN common case stays a single query.
  const rates = alerts.some((a) => a.currency !== "NGN")
    ? await latestForeignFxRates(
        firmId,
        clientPartyId,
        lagosDateString(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)),
      )
    : new Map<string, number>();
  const rankOf = (a: UnbilledIncomeAlert): number =>
    ngnRankFor(
      a.medianAmount,
      a.currency,
      rates.get(`${a.buyerPartyId}:${a.currency}`) ?? null,
    );
  alerts.sort((a, b) => rankOf(b) - rankOf(a));
  return alerts.slice(0, MAX_PATTERN_ALERTS);
}

// Firm-wide count for the weekly digest: the same detection, run over every
// engaged supplier's history in two queries (invoices + template coverage)
// instead of per-client round trips. Counts only — the digest phrases facts,
// it doesn't list clients' buyers — and, unlike the client card's top-5 cap,
// it states the TRUE count (a fact line, not a nudge list). Restricted to
// clients with a live engagement (same posture as the per-client-statement
// sweep): the digest must not nag about a client the firm archived.
export async function countFirmUnbilled(
  firmId: string,
  now: Date = new Date(),
): Promise<{ alerts: number; clients: number }> {
  const db = getDb();
  const covered = new Set(
    (
      await db
        .selectDistinct({
          supplierPartyId: recurringInvoiceTemplatesTable.supplierPartyId,
          buyerPartyId: recurringInvoiceTemplatesTable.buyerPartyId,
        })
        .from(recurringInvoiceTemplatesTable)
        .where(eq(recurringInvoiceTemplatesTable.firmId, firmId))
    ).map((r) => `${r.supplierPartyId}:${r.buyerPartyId}`),
  );

  const since = lagosDateString(
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
  );
  const rows = await db
    .select({
      id: invoicesTable.id,
      supplierPartyId: invoicesTable.supplierPartyId,
      buyerPartyId: invoicesTable.buyerPartyId,
      currency: invoicesTable.currency,
      issueDate: invoicesTable.issueDate,
      grandTotal: invoicesTable.grandTotal,
    })
    .from(invoicesTable)
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.kind, "invoice"),
        notInArray(invoicesTable.status, ["cancelled", "credited"]),
        gte(invoicesTable.issueDate, since),
        isNotNull(invoicesTable.grandTotal),
        isNull(partiesTable.mergedIntoId),
        eq(partiesTable.type, "buyer"),
        sql`EXISTS (
          SELECT 1 FROM ${engagementsTable} e
          WHERE e.firm_id = ${invoicesTable.firmId}
            AND e.client_party_id = ${invoicesTable.supplierPartyId}
            AND e.status IN ('open', 'in_progress')
        )`,
      ),
    );

  // Grouped per (supplier, buyer, CURRENCY) — the client-card grouping —
  // while template coverage stays per (supplier, buyer): a template covers
  // the relationship, whatever it bills in.
  const byPair = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const coverageKey = `${row.supplierPartyId}:${row.buyerPartyId}`;
    if (covered.has(coverageKey)) continue;
    const total = Number(row.grandTotal);
    if (!Number.isFinite(total)) continue;
    const key = `${coverageKey}:${row.currency}`;
    const list = byPair.get(key) ?? [];
    list.push({ id: row.id, issueDate: row.issueDate, grandTotal: total });
    byPair.set(key, list);
  }

  const today = lagosDateString(now);
  let alerts = 0;
  const clients = new Set<string>();
  for (const [key, invoices] of byPair) {
    if (unbilledAlertFor(invoices, today)) {
      alerts += 1;
      clients.add(key.split(":")[0]);
    }
  }
  return { alerts, clients: clients.size };
}
