import { useState } from "react";
import { Link } from "wouter";
import { useListBuyerInvoices } from "@workspace/api-client-react";
import type { BuyerInvoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight, Inbox } from "lucide-react";
import {
  formatNaira,
  formatDate,
  confirmationLabel,
  confirmationBadgeClasses,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "none", label: "Not requested" },
  { key: "requested", label: "Requested" },
  { key: "confirmed", label: "Confirmed" },
  { key: "queried", label: "Queried" },
  { key: "rejected", label: "Rejected" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const MAX_ROWS = 100;

function StampBadges({ invoice }: { invoice: BuyerInvoice }) {
  return (
    <span className="hidden lg:flex items-center gap-1">
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
          invoice.stampValid
            ? "bg-emerald-100 text-emerald-800 border-emerald-200"
            : "bg-slate-100 text-slate-600 border-slate-200"
        }`}
      >
        {invoice.stampValid ? "Stamp valid" : "No stamp"}
      </span>
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
          invoice.eligible
            ? "bg-emerald-100 text-emerald-800 border-emerald-200"
            : "bg-amber-100 text-amber-800 border-amber-200"
        }`}
      >
        {invoice.eligible ? "VAT eligible" : "Not eligible"}
      </span>
    </span>
  );
}

function InvoiceRow({ invoice }: { invoice: BuyerInvoice }) {
  return (
    <Link
      href={`/invoices/${invoice.id}`}
      data-testid={`row-invoice-${invoice.id}`}
      className="flex items-center gap-3 py-3 -mx-2 px-2 rounded-md hover:bg-muted/50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{invoice.invoiceNumber}</p>
        <p className="text-xs text-muted-foreground truncate">
          {invoice.supplierName} · {formatDate(invoice.issueDate)}
        </p>
      </div>
      <StampBadges invoice={invoice} />
      <p className="text-sm font-medium hidden sm:block">
        {formatNaira(invoice.grandTotal)}
      </p>
      <span
        className={`text-xs font-medium px-2.5 py-1 rounded-full border ${confirmationBadgeClasses(invoice.confirmationState)}`}
        data-testid={`badge-confirmation-${invoice.id}`}
      >
        {confirmationLabel(invoice.confirmationState)}
      </span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

export function Confirmations() {
  const [filter, setFilter] = useState<FilterKey>("all");
  const { data, isLoading, error } = useListBuyerInvoices();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    if (isFeatureDisabled(error)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Confirmations
          </h1>
          <FeatureUnavailable feature="Buyer rails" />
        </div>
      );
    }
    return (
      <p className="text-destructive" data-testid="text-error">
        Unable to load your invoices.
      </p>
    );
  }

  const invoices = data;
  const awaiting = invoices.filter((i) => i.confirmationState === "requested");
  const counts = new Map<FilterKey, number>([["all", invoices.length]]);
  for (const inv of invoices) {
    const key = inv.confirmationState as FilterKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const filtered =
    filter === "all"
      ? invoices
      : invoices.filter((i) => i.confirmationState === filter);
  const visible = filtered.slice(0, MAX_ROWS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Confirmations
        </h1>
        <p className="text-muted-foreground mt-1">
          Invoices addressed to your organization. Respond to confirmation
          requests to keep your input VAT protected.
        </p>
      </div>

      {awaiting.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60" data-testid="card-awaiting">
          <CardHeader>
            <CardTitle className="text-base text-amber-900">
              Awaiting your confirmation ({awaiting.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {awaiting.slice(0, MAX_ROWS).map((inv) => (
                <InvoiceRow key={inv.id} invoice={inv} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = counts.get(f.key) ?? 0;
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              data-testid={`chip-${f.key}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground hover:bg-muted"
              }`}
            >
              {f.label} · {count}
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="flex items-center gap-3 text-muted-foreground py-4" data-testid="text-empty">
              <Inbox className="w-5 h-5" />
              <p className="text-sm">No invoices in this state.</p>
            </div>
          ) : (
            <>
              <div className="divide-y">
                {visible.map((inv) => (
                  <InvoiceRow key={inv.id} invoice={inv} />
                ))}
              </div>
              {filtered.length > MAX_ROWS && (
                <p className="text-xs text-muted-foreground mt-3" data-testid="text-truncated">
                  Showing the first {MAX_ROWS} of {filtered.length} invoices.
                  Use the filters to narrow the list.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
