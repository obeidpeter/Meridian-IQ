import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useListBuyerInvoices } from "@workspace/api-client-react";
import type { BuyerInvoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { ChevronRight, Inbox, SearchX } from "lucide-react";
import {
  formatNaira,
  formatDate,
  confirmationLabel,
  confirmationBadgeClasses,
  stampBadge,
  eligibleBadge,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "none", label: "Not requested" },
  { key: "requested", label: "Requested" },
  { key: "confirmed", label: "Confirmed" },
  { key: "queried", label: "Queried" },
  { key: "rejected", label: "Rejected" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const PAGE_SIZE = 25;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

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

function InvoiceRow({ invoice }: { invoice: BuyerInvoice }) {
  // The API does not expose when the confirmation was requested, so the age
  // shown for awaiting rows is measured from the invoice's issue date.
  const age =
    invoice.confirmationState === "requested"
      ? daysSince(invoice.issueDate)
      : undefined;
  return (
    <Link
      href={`/invoices/${invoice.id}`}
      data-testid={`row-invoice-${invoice.id}`}
      className={`flex items-center gap-3 py-3 -mx-2 px-2 rounded-md hover:bg-muted/50 transition-colors ${FOCUS_RING}`}
    >
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{invoice.invoiceNumber}</p>
        <p className="text-xs text-muted-foreground truncate">
          {invoice.supplierName} · {formatDate(invoice.issueDate)}
          <span className="sm:hidden tabular-nums">
            {" · "}
            {formatNaira(invoice.grandTotal)}
          </span>
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
  );
}

function PageHeader() {
  return (
    <div>
      <h1
        className="text-2xl md:text-3xl font-bold"
        data-testid="text-page-title"
      >
        Confirmations
      </h1>
      <p className="text-muted-foreground mt-1">
        Invoices addressed to your organization. Respond to confirmation
        requests to keep your input VAT protected.
      </p>
    </div>
  );
}

export function Confirmations() {
  usePageTitle("Confirmations");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useListBuyerInvoices();

  const invoices = useMemo(() => data ?? [], [data]);

  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let rows = invoices;
    if (filter !== "all") {
      rows = rows.filter((i) => i.confirmationState === filter);
    }
    if (query !== "") {
      rows = rows.filter(
        (i) =>
          i.invoiceNumber.toLowerCase().includes(query) ||
          i.supplierName.toLowerCase().includes(query),
      );
    }
    return rows;
  }, [invoices, filter, query]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96 max-w-full mt-2" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-24" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Buyer Rails" />
        ) : (
          <QueryError thing="your invoices" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const awaiting = invoices.filter((i) => i.confirmationState === "requested");
  const awaitingTotal = awaiting.reduce(
    (sum, i) => sum + (Number(i.grandTotal) || 0),
    0,
  );
  const counts = new Map<FilterKey, number>([["all", invoices.length]]);
  for (const inv of invoices) {
    const key = inv.confirmationState as FilterKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const isFirstRun = invoices.length === 0;
  const hasActiveNarrowing = filter !== "all" || query !== "";

  return (
    <div className="space-y-6">
      <PageHeader />

      {awaiting.length > 0 && (
        <Card
          className="border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40"
          data-testid="card-awaiting"
        >
          <CardHeader>
            <CardTitle className="text-base text-amber-900 dark:text-amber-300">
              {awaiting.length}{" "}
              {awaiting.length === 1 ? "invoice needs" : "invoices need"} your
              response
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-amber-900/80 dark:text-amber-300/80">
              <span className="font-semibold tabular-nums">
                {formatNaira(awaitingTotal)}
              </span>{" "}
              of input VAT-bearing spend is awaiting your confirmation.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilter("requested");
                setPage(1);
              }}
              data-testid="button-view-awaiting"
            >
              View requested
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="invoice-search" className="sr-only">
            Search by invoice number or supplier
          </Label>
          <Input
            id="invoice-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search invoice number or supplier…"
            data-testid="input-search"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const count = counts.get(f.key) ?? 0;
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => {
                  setFilter(f.key);
                  setPage(1);
                }}
                aria-pressed={isActive}
                data-testid={`chip-${f.key}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border min-h-9 transition-colors ${FOCUS_RING} ${
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-2">
              {isFirstRun ? (
                <>
                  <Inbox
                    className="w-10 h-10 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="font-semibold" data-testid="text-empty">
                    No invoices yet
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Invoices appear when your suppliers address them to your
                    organization on MeridianIQ.
                  </p>
                </>
              ) : (
                <>
                  <SearchX
                    className="w-10 h-10 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="font-semibold" data-testid="text-empty">
                    No matches
                  </p>
                  <p className="text-sm text-muted-foreground">
                    No invoices match the current
                    {query !== "" ? " search" : ""}
                    {query !== "" && filter !== "all" ? " and" : ""}
                    {filter !== "all" ? " filter" : ""}.
                  </p>
                  {hasActiveNarrowing && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setFilter("all");
                        setSearch("");
                        setPage(1);
                      }}
                      data-testid="button-clear-filters"
                    >
                      Clear filters
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : (
            <>
              <div className="divide-y">
                {visible.map((inv) => (
                  <InvoiceRow key={inv.id} invoice={inv} />
                ))}
              </div>
              {pageCount > 1 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <p
                    className="text-xs text-muted-foreground tabular-nums"
                    data-testid="text-truncated"
                  >
                    Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                    {Math.min(currentPage * PAGE_SIZE, filtered.length)} of{" "}
                    {filtered.length} invoices
                  </p>
                  <Pagination className="mx-0 w-auto justify-end">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          aria-disabled={currentPage === 1}
                          className={
                            currentPage === 1
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                          onClick={(e) => {
                            e.preventDefault();
                            setPage(Math.max(1, currentPage - 1));
                          }}
                          data-testid="button-page-previous"
                        />
                      </PaginationItem>
                      <PaginationItem>
                        <span className="px-2 text-sm text-muted-foreground tabular-nums">
                          Page {currentPage} of {pageCount}
                        </span>
                      </PaginationItem>
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          aria-disabled={currentPage === pageCount}
                          className={
                            currentPage === pageCount
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                          onClick={(e) => {
                            e.preventDefault();
                            setPage(Math.min(pageCount, currentPage + 1));
                          }}
                          data-testid="button-page-next"
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
