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
const LOOKBACK_DAYS = 365;
const MAX_SUGGESTIONS = 5;

export interface RecurringSuggestion {
  buyerPartyId: string;
  buyerName: string;
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
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

// One client's billing history grouped per buyer, with buyers already covered
// by ANY template (active or paused) excluded — the recurring engine handles
// those, and re-suggesting a pattern the client deliberately paused is
// nagging, not help. Shared by the recurring suggestions and the
// unbilled-income check so the two surfaces mine the SAME history under the
// SAME exclusions.
export async function buyerBillingHistories(
  firmId: string,
  clientPartyId: string,
): Promise<Map<string, { name: string; invoices: HistoryRow[] }>> {
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

  const byBuyer = new Map<string, { name: string; invoices: HistoryRow[] }>();
  for (const row of rows) {
    if (covered.includes(row.buyerPartyId)) continue;
    const entry = byBuyer.get(row.buyerPartyId) ?? {
      name: row.buyerName,
      invoices: [],
    };
    const total = Number(row.grandTotal);
    if (Number.isFinite(total)) {
      entry.invoices.push({ id: row.id, issueDate: row.issueDate, grandTotal: total });
    }
    byBuyer.set(row.buyerPartyId, entry);
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
    count: number;
    medianAmount: number;
    lastInvoiceId: string;
    lastIssueDate: string;
  }> = [];
  for (const [buyerPartyId, entry] of byBuyer) {
    const pattern = detectMonthlyPattern(entry.invoices);
    if (pattern) patterns.push({ buyerPartyId, buyerName: entry.name, ...pattern });
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
    count: p.count,
    medianAmount: String(p.medianAmount),
    lastIssueDate: p.lastIssueDate,
    lines: linesByInvoice.get(p.lastInvoiceId) ?? [],
  }));
}
