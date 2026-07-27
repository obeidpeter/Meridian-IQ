import { ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListBuyerInvoices,
  useBulkRespondConfirmations,
  getListBuyerInvoicesQueryKey,
  getExportBuyerConfirmationsUrl,
} from "@workspace/api-client-react";
import type {
  BuyerInvoice,
  BulkConfirmationsResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { useToast } from "@/hooks/use-toast";
import { ChevronRight, Download, Inbox, SearchX } from "lucide-react";
import {
  formatNaira,
  formatDate,
  confirmationLabel,
  confirmationBadgeClasses,
  stampBadge,
  eligibleBadge,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { errorDescription } from "@/lib/respond";
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

// The bulk endpoint accepts at most this many invoice ids per call — the
// header "Select all" stops here, and a hand-picked overflow disables the
// button with a reason instead of collecting a guaranteed 400.
const BULK_LIMIT = 50;

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

function InvoiceRow({
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
  return (
    <div className="flex items-center gap-3">
      {showSelectionColumn &&
        (selectable ? (
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => onToggle(v === true)}
            aria-label={`Select ${invoice.invoiceNumber} for bulk confirmation`}
            data-testid={`check-confirm-${invoice.id}`}
          />
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        ))}
      <Link
        href={`/invoices/${invoice.id}`}
        data-testid={`row-invoice-${invoice.id}`}
        className={`flex-1 min-w-0 flex items-center gap-3 py-3 rounded-md hover:bg-muted/50 transition-colors ${
          showSelectionColumn ? "px-2" : "-mx-2 px-2"
        } ${FOCUS_RING}`}
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
    </div>
  );
}

function PageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
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
      {actions}
    </div>
  );
}

export function Confirmations() {
  usePageTitle("Confirmations");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useListBuyerInvoices();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Bulk confirmation: the picked awaiting rows, the method/no-set-off pair
  // (same semantics as the single-response form), and the per-invoice report
  // from the last run.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMethod, setBulkMethod] = useState("portal");
  const [bulkNoSetOff, setBulkNoSetOff] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkConfirmationsResult | null>(
    null,
  );
  const bulk = useBulkRespondConfirmations();

  const invoices = useMemo(() => data ?? [], [data]);

  // A refetch can flip a selected row out of the awaiting state (someone
  // else responded, or our own bulk run landed) — drop it from the selection
  // instead of resubmitting a guaranteed skip.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const awaitingIds = new Set(
        invoices
          .filter((i) => i.confirmationState === "requested")
          .map((i) => i.id),
      );
      const next = new Set([...prev].filter((id) => awaitingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [invoices]);

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

  // Bulk selection derivations: the awaiting rows in the CURRENT filtered
  // view are what "Select all" covers, capped at the endpoint's batch size.
  const awaitingFiltered = filtered.filter(
    (i) => i.confirmationState === "requested",
  );
  const showSelectionColumn = awaitingFiltered.length > 0;
  const selectAllTargets = awaitingFiltered.slice(0, BULK_LIMIT);
  const allSelected =
    selectAllTargets.length > 0 &&
    selectAllTargets.every((i) => selected.has(i.id));
  const overLimit = selected.size > BULK_LIMIT;
  const selectAllCapped =
    allSelected && awaitingFiltered.length > BULK_LIMIT && !overLimit;
  const numbersById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

  const toggleRow = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const runBulk = () => {
    if (selected.size === 0 || overLimit || bulk.isPending) return;
    bulk.mutate(
      {
        data: {
          invoiceIds: [...selected],
          method: bulkMethod,
          noSetOff: bulkNoSetOff,
        },
      },
      {
        onSuccess: (res) => {
          setBulkResults(res);
          setSelected(new Set());
          setBulkNoSetOff(false);
          void queryClient.invalidateQueries({
            queryKey: getListBuyerInvoicesQueryKey(),
          });
          toast({
            title: `${res.confirmed} ${
              res.confirmed === 1 ? "invoice" : "invoices"
            } confirmed`,
            description:
              res.skipped > 0
                ? `${res.skipped} skipped — the results below say why.`
                : "The suppliers have been notified of your response.",
          });
        },
        onError: (err) =>
          toast({
            title: "Could not confirm the selected invoices",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  const skippedItems = (bulkResults?.items ?? []).filter(
    (i) => i.status === "skipped",
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          // CSV of the confirmation queue, as a plain same-origin navigation
          // (no react-query): the endpoint answers with a Content-Disposition
          // attachment and auth rides the session cookie, so the browser just
          // downloads the file.
          <Button asChild variant="outline" data-testid="button-export-confirmations">
            <a href={getExportBuyerConfirmationsUrl()}>
              <Download className="w-4 h-4 mr-2" aria-hidden="true" />
              Export CSV
            </a>
          </Button>
        }
      />

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

      {bulkResults !== null && (
        <Card data-testid="card-bulk-results">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <CardTitle>Bulk confirmation results</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBulkResults(null)}
                data-testid="button-dismiss-bulk-results"
              >
                Dismiss
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm" data-testid="text-bulk-outcome">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                {bulkResults.confirmed} confirmed
              </span>
              {" · "}
              <span
                className={`tabular-nums ${
                  bulkResults.skipped > 0
                    ? "font-semibold text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground"
                }`}
              >
                {bulkResults.skipped} skipped
              </span>
            </p>
            {skippedItems.length > 0 && (
              <div className="rounded-md border divide-y">
                {skippedItems.map((item) => (
                  <div
                    key={item.invoiceId}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-3 text-sm"
                    data-testid={`row-bulk-skipped-${item.invoiceId}`}
                  >
                    <Link
                      href={`/invoices/${item.invoiceId}`}
                      className={`font-medium text-primary hover:underline rounded-sm ${FOCUS_RING}`}
                      data-testid={`link-bulk-skipped-${item.invoiceId}`}
                    >
                      {numbersById.get(item.invoiceId) ?? item.invoiceId}
                    </Link>
                    <p className="text-muted-foreground">
                      {item.reason ?? "Skipped"}
                    </p>
                  </div>
                ))}
              </div>
            )}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Invoices</CardTitle>
            {showSelectionColumn && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="select-all-awaiting"
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(
                      v === true
                        ? new Set(selectAllTargets.map((i) => i.id))
                        : new Set(),
                    )
                  }
                  aria-label="Select all invoices awaiting your response"
                  data-testid="check-select-all"
                />
                <Label
                  htmlFor="select-all-awaiting"
                  className="text-sm font-normal text-muted-foreground"
                >
                  Select all
                </Label>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {selected.size > 0 && (
            <div
              className="mb-4 rounded-md border bg-muted/40 p-3 space-y-2"
              data-testid="bar-bulk-actions"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p
                  className="text-sm font-semibold tabular-nums"
                  data-testid="text-bulk-selected"
                >
                  {selected.size} selected
                  {selectAllCapped && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      (bulk limit)
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Label htmlFor="bulk-method" className="text-sm">
                    Method
                  </Label>
                  <Select value={bulkMethod} onValueChange={setBulkMethod}>
                    <SelectTrigger
                      id="bulk-method"
                      className="h-9 w-32"
                      data-testid="select-bulk-method"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portal">Portal</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="phone">Phone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="bulk-no-set-off"
                    checked={bulkNoSetOff}
                    onCheckedChange={(v) => setBulkNoSetOff(v === true)}
                    data-testid="checkbox-bulk-no-set-off"
                  />
                  <Label
                    htmlFor="bulk-no-set-off"
                    className="text-sm font-normal leading-snug"
                  >
                    We acknowledge no set-off will be applied against these
                    invoices
                  </Label>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      disabled={overLimit || bulk.isPending}
                      data-testid="button-bulk-confirm"
                    >
                      {bulk.isPending ? (
                        <>
                          <Spinner className="mr-2 size-4" /> Confirming…
                        </>
                      ) : (
                        "Confirm selected"
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Confirm {selected.size}{" "}
                        {selected.size === 1 ? "invoice" : "invoices"}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Each records who confirmed and how, permanently.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-cancel-bulk">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={runBulk}
                        disabled={bulk.isPending}
                        data-testid="button-confirm-bulk"
                      >
                        Confirm invoices
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              {overLimit && (
                <p
                  className="text-xs text-destructive"
                  data-testid="text-bulk-limit"
                >
                  Bulk confirm handles up to {BULK_LIMIT} invoices at a time —
                  narrow your selection.
                </p>
              )}
            </div>
          )}

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
                  <InvoiceRow
                    key={inv.id}
                    invoice={inv}
                    showSelectionColumn={showSelectionColumn}
                    checked={selected.has(inv.id)}
                    onToggle={(on) => toggleRow(inv.id, on)}
                  />
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
