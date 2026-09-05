import type { DraftState } from "./invoice-draft";
import { invoiceLineErrors, lineTotals } from "./invoice-lines";
import { formatAmount } from "./format";

export function draftTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Lagos",
  }).format(new Date(value));
}

export function draftAmount(draft: DraftState): string {
  const incomplete =
    !draft.lines.length ||
    draft.lines.some((line) => {
      const errors = invoiceLineErrors(line);
      return errors.quantity || errors.unitPrice;
    });
  if (incomplete) return "Amount incomplete";
  return formatAmount(lineTotals(draft.lines).total, draft.currency || "NGN");
}

export function draftOptionLabel(
  draft: DraftState,
  updatedAt?: string,
): string {
  const title =
    draft.invoiceNumber.trim() ||
    draft.lines.find((line) => line.description.trim())?.description.trim() ||
    "Untitled invoice";
  return `${title.slice(0, 70)} - ${draftAmount(draft)}${updatedAt ? ` - ${draftTime(updatedAt)}` : ""}`;
}
