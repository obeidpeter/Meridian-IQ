import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
} from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  invoiceLinesTable,
  partiesTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { LOOKBACK_DAYS, addDays, daysBetween, median } from "./date-math";
import type { LineInput } from "./lines";

// Recurring-invoice suggestions (exhaust idea #3). recurring_invoice_templates
// exist, but clients set them up by hand — meanwhile their own invoice history
// already shows the retainers: the same buyer, a similar amount, roughly every
// month. This module MINES that pattern deterministically (no model call, no
// storage — computed on demand) and the recurring page offers a "make this
// recurring?" card that prefills the existing template dialog. The client
// disposes; nothing is ever created automatically.

// Pattern thresholds. Deliberately conservative: a false suggestion teaches
// the user to ignore the card. At least three invoices, spanning three-ish
// months, with a monthly-looking median gap and amounts clustered around the
// median.
const MIN_OCCURRENCES = 3;
const MIN_SPAN_DAYS = 55;
const MEDIAN_GAP_MIN_DAYS = 21;
const MEDIAN_GAP_MAX_DAYS = 45;
const AMOUNT_TOLERANCE = 0.25; // within ±25% of the median amount
const AMOUNT_CLUSTER_SHARE = 0.6; // …for at least 60% of the invoices
// Shared with unbilled-income.ts / missing-bills.ts so every surface mines
// the same year — the constant itself lives in date-math.ts (re-exported
// here for existing importers).
export { LOOKBACK_DAYS };
const MAX_SUGGESTIONS = 5;

export interface RecurringSuggestion {
  buyerPartyId: string;
  buyerName: string;
  currency: string;
  count: number;
  medianAmount: string;
  lastIssueDate: string;
  lines: LineInput[];
}

export interface HistoryRow {
  id: string;
  issueDate: string;
  grandTotal: number;
}

// ---------------------------------------------------------------------------
// The shared alert-window core (refactoring round): unbilled-income and
// missing-bills fire under the SAME discipline over a mined monthly pattern
// — the two functions were token-identical twins held in lockstep by prose.
// An alert is live only inside [expected + grace, expected + max] (both
// ends inclusive):
//  - GRACE_DAYS of slack first — cadences wobble, and nagging on day one of
//    a slipped cycle teaches the client to ignore the card;
//  - silence past MAX_OVERDUE_DAYS means the arrangement probably ENDED —
//    a lapsed retainer is not "unbilled income" and a cancelled
//    subscription is not a missing bill. (If activity resumes, the
//    pattern's lastIssueDate moves and the check re-arms.)
// ---------------------------------------------------------------------------

export const GRACE_DAYS = 5;
export const MAX_OVERDUE_DAYS = 45;
export const MAX_PATTERN_ALERTS = 5;

export interface PatternAlertCore {
  count: number;
  medianAmount: string;
  medianGapDays: number;
  lastIssueDate: string;
  expectedByDate: string;
  overdueDays: number;
}

// Pure projection over one counterparty's mined pattern: the next document
// was expected medianGapDays after the last one; the alert is live while
// "today" sits inside the window above.
export function patternAlertFor(
  rows: HistoryRow[],
  todayLagos: string,
): PatternAlertCore | null {
  const pattern = detectMonthlyPattern(rows);
  if (!pattern) return null;
  const expectedByDate = addDays(pattern.lastIssueDate, pattern.medianGapDays);
  const overdueDays = daysBetween(expectedByDate, todayLagos);
  if (overdueDays < GRACE_DAYS || overdueDays > MAX_OVERDUE_DAYS) return null;
  return {
    count: pattern.count,
    medianAmount: String(pattern.medianAmount),
    medianGapDays: pattern.medianGapDays,
    lastIssueDate: pattern.lastIssueDate,
    expectedByDate,
    overdueDays,
  };
}

// Pure pattern detection over one buyer's invoices (oldest-first), exported
// for unit tests. Returns the pattern summary or null. medianGapDays is the
// observed billing cadence — unbilled-income.ts projects the next expected
// issue date from it.
export function detectMonthlyPattern(invoices: HistoryRow[]): {
  count: number;
  medianAmount: number;
  medianGapDays: number;
  lastInvoiceId: string;
  lastIssueDate: string;
} | null {
  if (invoices.length < MIN_OCCURRENCES) return null;
  const sorted = [...invoices].sort((a, b) =>
    a.issueDate.localeCompare(b.issueDate),
  );
  const span = daysBetween(sorted[0].issueDate, sorted[sorted.length - 1].issueDate);
  if (span < MIN_SPAN_DAYS) return null;

  // Non-zero gaps only: several invoices on the SAME day are one billing
  // event, not a faster cadence — a 0-day gap would drag the median down and
  // let a bursty pair masquerade as monthly.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1].issueDate, sorted[i].issueDate);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < MIN_OCCURRENCES - 1) return null;
  const medianGap = median(gaps);
  if (medianGap < MEDIAN_GAP_MIN_DAYS || medianGap > MEDIAN_GAP_MAX_DAYS) {
    return null;
  }

  const amounts = sorted.map((r) => r.grandTotal).filter((n) => n > 0);
  if (amounts.length < MIN_OCCURRENCES) return null;
  const medianAmount = median(amounts);
  if (medianAmount <= 0) return null;
  const clustered = amounts.filter(
    (n) => Math.abs(n - medianAmount) <= medianAmount * AMOUNT_TOLERANCE,
  );
  if (
    clustered.length < MIN_OCCURRENCES ||
    clustered.length / amounts.length < AMOUNT_CLUSTER_SHARE
  ) {
    return null;
  }

  const last = sorted[sorted.length - 1];
  return {
    // Report the count the median was computed over (invoices with a usable
    // amount), so the card's "N invoices … about ₦X each" is honest.
    count: amounts.length,
    medianAmount,
    medianGapDays: Math.round(medianGap),
    lastInvoiceId: last.id,
    lastIssueDate: last.issueDate,
  };
}

// One client's billing history grouped per (buyer, CURRENCY), with buyers
// already covered by ANY template (active or paused) excluded — the
// recurring engine handles those, and re-suggesting a pattern the client
// deliberately paused is nagging, not help. Shared by the recurring
// suggestions and the unbilled-income check so the two surfaces mine the
// SAME history under the SAME exclusions. Currency is part of the group
// key (round-20 hygiene): a retainer billed in USD and an NGN one-off to
// the same buyer are different habits, and merging them minted a median
// that was neither — rendered as naira.
export async function buyerBillingHistories(
  firmId: string,
  clientPartyId: string,
): Promise<
  Map<
    string,
    { buyerPartyId: string; name: string; currency: string; invoices: HistoryRow[] }
  >
> {
  const db = getDb();
  const covered = (
    await db
      .selectDistinct({ buyerPartyId: recurringInvoiceTemplatesTable.buyerPartyId })
      .from(recurringInvoiceTemplatesTable)
      .where(
        and(
          eq(recurringInvoiceTemplatesTable.firmId, firmId),
          eq(recurringInvoiceTemplatesTable.supplierPartyId, clientPartyId),
        ),
      )
  ).map((r) => r.buyerPartyId);

  const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const since = lagosDateString(sinceDate);
  const rows = await db
    .select({
      id: invoicesTable.id,
      buyerPartyId: invoicesTable.buyerPartyId,
      currency: invoicesTable.currency,
      issueDate: invoicesTable.issueDate,
      grandTotal: invoicesTable.grandTotal,
      buyerName: partiesTable.legalName,
    })
    .from(invoicesTable)
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientPartyId),
        eq(invoicesTable.kind, "invoice"),
        // Cancelled/credited paper is not evidence of a standing arrangement.
        notInArray(invoicesTable.status, ["cancelled", "credited"]),
        gte(invoicesTable.issueDate, since),
        isNotNull(invoicesTable.grandTotal),
        // Never suggest a buyer the SME form can't pick: a merged-away party
        // (invoices are not rewritten on merge) or a non-buyer type would seed
        // a template against a party the picker doesn't offer.
        isNull(partiesTable.mergedIntoId),
        eq(partiesTable.type, "buyer"),
      ),
    )
    .orderBy(asc(invoicesTable.issueDate));

  const byBuyer = new Map<
    string,
    { buyerPartyId: string; name: string; currency: string; invoices: HistoryRow[] }
  >();
  for (const row of rows) {
    if (covered.includes(row.buyerPartyId)) continue;
    const key = `${row.buyerPartyId}:${row.currency}`;
    const entry = byBuyer.get(key) ?? {
      buyerPartyId: row.buyerPartyId,
      name: row.buyerName,
      currency: row.currency,
      invoices: [],
    };
    const total = Number(row.grandTotal);
    if (Number.isFinite(total)) {
      entry.invoices.push({ id: row.id, issueDate: row.issueDate, grandTotal: total });
    }
    byBuyer.set(key, entry);
  }
  return byBuyer;
}

export async function listRecurringSuggestions(
  firmId: string,
  clientPartyId: string,
): Promise<RecurringSuggestion[]> {
  const db = getDb();
  const byBuyer = await buyerBillingHistories(firmId, clientPartyId);

  const patterns: Array<{
    buyerPartyId: string;
    buyerName: string;
    currency: string;
    count: number;
    medianAmount: number;
    lastInvoiceId: string;
    lastIssueDate: string;
  }> = [];
  for (const entry of byBuyer.values()) {
    const pattern = detectMonthlyPattern(entry.invoices);
    if (pattern) {
      patterns.push({
        buyerPartyId: entry.buyerPartyId,
        buyerName: entry.name,
        currency: entry.currency,
        ...pattern,
      });
    }
  }
  // Strongest habits first; cap so the card row stays a nudge, not a wall.
  patterns.sort((a, b) => b.count - a.count);
  const top = patterns.slice(0, MAX_SUGGESTIONS);
  if (top.length === 0) return [];

  // Seed lines come from the newest invoice in each pattern — the template
  // dialog opens prefilled with what the client actually bills.
  const lineRows = await db
    .select({
      invoiceId: invoiceLinesTable.invoiceId,
      lineNo: invoiceLinesTable.lineNo,
      description: invoiceLinesTable.description,
      quantity: invoiceLinesTable.quantity,
      unitPrice: invoiceLinesTable.unitPrice,
      vatRate: invoiceLinesTable.vatRate,
    })
    .from(invoiceLinesTable)
    .where(
      inArray(
        invoiceLinesTable.invoiceId,
        top.map((p) => p.lastInvoiceId),
      ),
    )
    .orderBy(asc(invoiceLinesTable.lineNo));
  const linesByInvoice = new Map<string, LineInput[]>();
  for (const l of lineRows) {
    const list = linesByInvoice.get(l.invoiceId) ?? [];
    list.push({
      description: l.description,
      quantity: String(Number(l.quantity)),
      unitPrice: String(Number(l.unitPrice)),
      vatRate: String(Number(l.vatRate)),
    });
    linesByInvoice.set(l.invoiceId, list);
  }

  return top.map((p) => ({
    buyerPartyId: p.buyerPartyId,
    buyerName: p.buyerName,
    currency: p.currency,
    count: p.count,
    medianAmount: String(p.medianAmount),
    lastIssueDate: p.lastIssueDate,
    lines: linesByInvoice.get(p.lastInvoiceId) ?? [],
  }));
}
