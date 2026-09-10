import type {
  BuyerInvoice,
  BuyerInvoiceSummary,
} from "@workspace/api-client-react";
import type { FilterKey } from "./constants";

// The queue's headline numbers: the summary endpoint's counts when it has
// answered, else the counts folded from the page in hand.
export function queueCounts(
  summary: BuyerInvoiceSummary | undefined,
  invoices: BuyerInvoice[],
) {
  const awaiting = invoices.filter((i) => i.confirmationState === "requested");
  const summaryCounts = summary?.counts;
  const awaitingCount = summaryCounts?.requested ?? awaiting.length;
  const awaitingTotal =
    summary?.awaitingTotal ??
    String(awaiting.reduce((sum, i) => sum + (Number(i.grandTotal) || 0), 0));
  const counts = new Map<FilterKey, number>([
    ["all", summary?.total ?? invoices.length],
    ["none", summaryCounts?.none ?? 0],
    ["requested", awaitingCount],
    ["confirmed", summaryCounts?.confirmed ?? 0],
    ["queried", summaryCounts?.queried ?? 0],
    ["rejected", summaryCounts?.rejected ?? 0],
  ]);
  return { awaitingCount, awaitingTotal, counts };
}
