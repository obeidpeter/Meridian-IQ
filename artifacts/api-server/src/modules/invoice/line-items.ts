import { and, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import { getDb, invoicesTable, invoiceLinesTable } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";

// Line-item memory (exhaust idea #1, round 4). A client's approved invoices
// already show WHAT they sell: the same line descriptions, at consistent
// prices, month after month. This module MINES that catalogue
// deterministically — no model call, nothing stored, computed on demand —
// for two consumers:
//  - the SME draft form's "frequent items" chips (prefill a line);
//  - capture pre-flight (flag a unit price far off this item's history —
//    the OCR-slipped-digit on a line, cheaper to catch than to unwind).
//
// Same posture as recurring-suggest: conservative thresholds (a noisy
// suggestion teaches users to ignore the feature), the client's OWN history
// only (firm + supplier filters at every query; SEC-03 gating is the
// caller's job exactly like the other history checks).

const LOOKBACK_DAYS = 365;
// An item seen fewer times than this is not a habit worth suggesting.
const MIN_OCCURRENCES = 2;
// ...and price-deviation warnings need more history than suggestions do.
const PRICE_CHECK_MIN_OCCURRENCES = 3;
// A unit price this many times the item's median — or that fraction of it —
// is worth a second look. Much tighter than the invoice-total outlier factor
// (×10): totals vary with quantity, a specific item's unit price does not.
const PRICE_OUTLIER_FACTOR = 4;
const MAX_ITEMS = 30;
// Newest lines considered per mining pass — a safety cap so one very busy
// client cannot make every capture pay for its full annual line history.
const MAX_LINES = 5000;
// The suggestions consumer casts a wide net: everything except dead paper —
// mirrors recurring-suggest's exclusions.
const DEAD_STATUSES = ["cancelled", "credited"] as const;
// The pre-flight BASELINE is stricter: only documents that lived on the
// rails may define an item's "usual" price. A Clerk approval creates a DRAFT
// invoice, so a mis-extracted draft price must not seed the very check built
// to catch the next mis-extraction. Mirrors register-preflight's
// HISTORY_STATUSES.
const LIVE_STATUSES = [
  "validated",
  "submitted",
  "stamped",
  "confirmed",
  "settled",
] as const;

export interface LineItemSuggestion {
  // Normalized identity of the item (see itemKey) — stable across word
  // order, case and punctuation, so the UI can dedupe against typed lines.
  key: string;
  // The most recently used literal description — what a picked chip inserts.
  description: string;
  count: number;
  medianUnitPrice: string;
  // The item's dominant VAT rate (mode over its history).
  vatRate: string;
  lastUsed: string;
}

// Order-insensitive token key, mirroring the alias-memory normalization:
// "Bag of Cement 50kg" and "50KG CEMENT BAG" are the same item. Tokens under
// 3 chars drop ("of", "a"); null when nothing meaningful remains.
export function itemKey(description: string | null | undefined): string | null {
  if (!description) return null;
  const tokens = [
    ...new Set(
      description
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter((t) => t.length >= 3),
    ),
  ].sort();
  if (tokens.length === 0) return null;
  const key = tokens.join(" ");
  return key.length >= 3 ? key : null;
}

interface MinedLine {
  description: string;
  unitPrice: number;
  vatRate: number;
  issueDate: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure aggregation over mined lines, exported for unit tests: group by
// itemKey, keep habits (MIN_OCCURRENCES+), newest description wins, median
// unit price, modal VAT rate.
export function aggregateLineItems(lines: MinedLine[]): LineItemSuggestion[] {
  const byKey = new Map<string, MinedLine[]>();
  for (const line of lines) {
    const key = itemKey(line.description);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(line);
    byKey.set(key, list);
  }

  const items: LineItemSuggestion[] = [];
  for (const [key, group] of byKey) {
    if (group.length < MIN_OCCURRENCES) continue;
    const prices = group
      .map((l) => l.unitPrice)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length < MIN_OCCURRENCES) continue;
    const newest = [...group].sort((a, b) =>
      b.issueDate.localeCompare(a.issueDate),
    )[0];
    // Modal VAT rate: the treatment this item actually gets, not an average
    // that would land between the two lawful rates.
    const rateCounts = new Map<number, number>();
    for (const l of group) {
      rateCounts.set(l.vatRate, (rateCounts.get(l.vatRate) ?? 0) + 1);
    }
    const modalRate = [...rateCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    items.push({
      key,
      description: newest.description,
      count: group.length,
      // Two decimals: an even-count median of 2-decimal prices otherwise
      // carries float noise straight into the form's price input.
      medianUnitPrice: median(prices).toFixed(2),
      vatRate: String(modalRate),
      lastUsed: newest.issueDate,
    });
  }
  items.sort((a, b) => b.count - a.count);
  return items.slice(0, MAX_ITEMS);
}

// The client's item catalogue, mined from its own invoices in this firm.
// `liveOnly` narrows the basis to rails-proven documents — the pre-flight
// baseline — while the default keeps the suggestion net wide.
export async function listLineItemSuggestions(
  firmId: string,
  clientPartyId: string,
  opts: { liveOnly?: boolean } = {},
): Promise<LineItemSuggestion[]> {
  const since = lagosDateString(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000));
  const rows = await getDb()
    .select({
      description: invoiceLinesTable.description,
      unitPrice: invoiceLinesTable.unitPrice,
      vatRate: invoiceLinesTable.vatRate,
      issueDate: invoicesTable.issueDate,
    })
    .from(invoiceLinesTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, invoiceLinesTable.invoiceId))
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientPartyId),
        eq(invoicesTable.kind, "invoice"),
        opts.liveOnly
          ? inArray(invoicesTable.status, [...LIVE_STATUSES])
          : notInArray(invoicesTable.status, [...DEAD_STATUSES]),
        gte(invoicesTable.issueDate, since),
        sql`${invoiceLinesTable.unitPrice}::numeric > 0`,
      ),
    )
    .orderBy(desc(invoicesTable.issueDate))
    .limit(MAX_LINES);

  return aggregateLineItems(
    rows.map((r) => ({
      description: r.description,
      unitPrice: Number(r.unitPrice),
      vatRate: Number(r.vatRate),
      issueDate: r.issueDate,
    })),
  );
}

export interface LinePriceIssue {
  lineNo: number;
  description: string;
  message: string;
}

// Pure price-deviation check, exported for tests and consumed by the capture
// pre-flight: a line whose unit price is far outside ITS OWN item's history.
// Only items with enough history may complain, and the message quotes the
// document's value plus the history — never another client's data (the
// caller passes this supplier's own catalogue).
export function linePriceIssues(
  lines: Array<{ description: string | null; unitPrice: string | null }>,
  items: LineItemSuggestion[],
): LinePriceIssue[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const issues: LinePriceIssue[] = [];
  lines.forEach((line, index) => {
    const key = itemKey(line.description);
    if (!key || !line.description) return;
    const item = byKey.get(key);
    if (!item || item.count < PRICE_CHECK_MIN_OCCURRENCES) return;
    const price = Number((line.unitPrice ?? "").replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) return;
    const usual = Number(item.medianUnitPrice);
    if (!Number.isFinite(usual) || usual <= 0) return;
    if (price > usual * PRICE_OUTLIER_FACTOR || price < usual / PRICE_OUTLIER_FACTOR) {
      issues.push({
        lineNo: index + 1,
        description: line.description,
        message: `Line ${index + 1}: the unit price (NGN ${price}) is far from this item's usual NGN ${usual} (${item.count} past lines) — double-check the amount`,
      });
    }
  });
  return issues;
}
