import { Link } from "wouter";
import type { BuyerInvoice } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronRight } from "lucide-react";
import {
  formatNaira,
  formatDate,
  confirmationLabel,
  confirmationBadgeClasses,
  stampBadge,
  eligibleBadge,
  stampRiskLabel,
} from "@/lib/format";
import { FOCUS_RING } from "./constants";

function daysSince(value: string): number | undefined {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days >= 0 ? days : undefined;
}

function StampBadges({ invoice }: { invoice: BuyerInvoice }) {
  const stamp = stampBadge(invoice.stampValid);
  const eligible = eligibleBadge(invoice.eligible);
  return (
    <span className="hidden lg:flex items-center gap-1">
      <span className={stamp.classes}>{stamp.label}</span>
      <span className={eligible.classes}>{eligible.label}</span>
    </span>
  );
}

export function InvoiceRow({
  invoice,
  showSelectionColumn,
  checked,
  onToggle,
}: {
  invoice: BuyerInvoice;
  // The selection column renders whenever the filtered list contains any
  // awaiting rows, so checkboxes and their non-selectable neighbours align.
  showSelectionColumn: boolean;
  checked: boolean;
  onToggle: (selected: boolean) => void;
}) {
  const selectable = invoice.confirmationState === "requested";
  // The API does not expose when the confirmation was requested, so the age
  // shown for awaiting rows is measured from the invoice's issue date.
  const age =
    invoice.confirmationState === "requested"
      ? daysSince(invoice.issueDate)
      : undefined;
  const stampRisk = stampRiskLabel(invoice);
  return (
    <div className="flex items-center gap-3">
      {showSelectionColumn &&
        (selectable ? (
          <Checkbox
            className="size-6 shrink-0"
            checked={checked}
            onCheckedChange={(v) => onToggle(v === true)}
            aria-label={`Select ${invoice.invoiceNumber} for bulk confirmation`}
            data-testid={`check-confirm-${invoice.id}`}
          />
        ) : (
          <span className="w-6 shrink-0" aria-hidden="true" />
        ))}
      <Link
        href={`/invoices/${invoice.id}`}
        data-testid={`row-invoice-${invoice.id}`}
        className={`flex-1 min-w-0 flex items-center gap-3 py-3 rounded-md hover:bg-muted/50 transition-colors ${
          showSelectionColumn ? "px-2" : "-mx-2 px-2"
        } ${FOCUS_RING}`}
      >
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate" title={invoice.invoiceNumber}>
            {invoice.invoiceNumber}
          </p>
          <p
            className="text-xs text-muted-foreground truncate"
            title={`${invoice.supplierName} - ${formatDate(invoice.issueDate)}`}
          >
            {invoice.supplierName} · {formatDate(invoice.issueDate)}
            <span className="sm:hidden tabular-nums">
              {" · "}
              {formatNaira(invoice.grandTotal)}
            </span>
            {stampRisk && (
              <span
                className="lg:hidden font-medium text-amber-700 dark:text-amber-400"
                data-testid={`text-stamp-risk-${invoice.id}`}
              >
                {" · "}
                {stampRisk}
              </span>
            )}
            {age !== undefined && (
              <span className="text-amber-700 dark:text-amber-400">
                {" · "}issued {age === 0 ? "today" : `${age}d ago`}
              </span>
            )}
          </p>
        </div>
        <StampBadges invoice={invoice} />
        <p className="text-sm font-medium tabular-nums hidden sm:block">
          {formatNaira(invoice.grandTotal)}
        </p>
        <span
          className={confirmationBadgeClasses(invoice.confirmationState)}
          data-testid={`badge-confirmation-${invoice.id}`}
        >
          {confirmationLabel(invoice.confirmationState)}
        </span>
        <ChevronRight
          className="w-4 h-4 text-muted-foreground shrink-0"
          aria-hidden="true"
        />
      </Link>
    </div>
  );
}
