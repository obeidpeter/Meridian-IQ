import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListInvoices,
  useBulkSubmitInvoices,
  getListInvoicesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  useListParties,
} from "@workspace/api-client-react";
import type {
  BulkSubmitRowResult,
  Invoice,
  ListInvoicesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { idMap, scopedToSupplier } from "@/lib/rows";
import {
  Search,
  FileText,
  ChevronRight,
  Send,
  SlidersHorizontal,
  X,
  Download,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  statusLabel,
  badgeClasses,
  statusTone,
  pillClasses,
} from "@/lib/format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Unsubmitted" },
  { key: "pending", label: "Pending" },
  { key: "stamped", label: "Stamped" },
  { key: "failed", label: "Failed" },
] as const;

// Server page size. Passing limit/offset switches GET /invoices into its
// newest-first bounded mode, so we never pull the unbounded legacy list.
const PAGE_SIZE = 50;

// Offset-paged accumulation of GET /invoices for the vault list: debounces
// the search box into the server-side `q`, keeps every fetched page for the
// current term, and exposes load-more / reset-to-first-page controls plus the
// derived loading flags. `query` is the debounced term the pages were fetched
// with (the CSV export URL must be built from it, not the live input).
function useAccumulatedInvoicePages(search: string) {
  // Debounced server-side search plus paging cursor, kept in one state object
  // so a new search term resets to the first page in the same update.
  const [paging, setPaging] = useState<{ q: string; offset: number }>({
    q: "",
    offset: 0,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      const q = search.trim();
      setPaging((prev) => (prev.q === q ? prev : { q, offset: 0 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params: ListInvoicesParams = paging.q
    ? { limit: PAGE_SIZE, offset: paging.offset, q: paging.q }
    : { limit: PAGE_SIZE, offset: paging.offset };
  const {
    data: page,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });

  // Earlier pages accumulated per search term, keyed by offset so a
  // background refetch of a page replaces it instead of appending a
  // duplicate. The current offset's page always comes live from the query
  // and is merged in below; the effect just persists it for later offsets.
  const [pages, setPages] = useState<{
    q: string;
    byOffset: Record<number, Invoice[]>;
  }>({ q: "", byOffset: {} });

  useEffect(() => {
    if (!page) return;
    setPages((prev) =>
      prev.q === paging.q
        ? { q: prev.q, byOffset: { ...prev.byOffset, [paging.offset]: page } }
        : { q: paging.q, byOffset: { [paging.offset]: page } },
    );
  }, [page, paging]);

  const byOffset = useMemo(() => {
    const merged: Record<number, Invoice[]> =
      pages.q === paging.q ? { ...pages.byOffset } : {};
    if (page) merged[paging.offset] = page;
    return merged;
  }, [pages, paging, page]);

  const loaded = useMemo(
    () =>
      Object.keys(byOffset)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((offset) => byOffset[offset] ?? []),
    [byOffset],
  );

  const hasLoaded = Object.keys(byOffset).length > 0;
  const lastPage = byOffset[paging.offset];
  const hasMore = !!lastPage && lastPage.length === PAGE_SIZE;
  const loadingMore = isFetching && hasLoaded && !lastPage;
  const initialLoading = isLoading && !hasLoaded;

  const loadMore = () =>
    setPaging((prev) => ({
      ...prev,
      offset: prev.offset + PAGE_SIZE,
    }));

  // Drop the accumulated pages and jump back to the first page so the
  // refreshed statuses show instead of stale later pages.
  const resetToFirstPage = () => {
    setPaging((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
    setPages((prev) => ({ q: prev.q, byOffset: {} }));
  };

  return {
    loaded,
    hasLoaded,
    hasMore,
    loadingMore,
    initialLoading,
    isError,
    refetch,
    loadMore,
    resetToFirstPage,
    query: paging.q,
  };
}

// The two-step bulk-submit dialog: `report === null` is the confirmation
// step; a report switches it to the results view. Purely presentational —
// the mutation, report merging, and query invalidations live in the parent.
function BulkSubmitDialog({
  open,
  report,
  isPending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  report: { rows: BulkSubmitRowResult[]; remaining: number } | null;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const bulkRows = report?.rows ?? [];
  const bulkSubmitted = bulkRows.filter((r) => r.outcome === "submitted").length;
  const bulkNeedsAttention = bulkRows.filter((r) => r.outcome !== "submitted");

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {report === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Submit all pending drafts?</DialogTitle>
              <DialogDescription>
                This validates every pending draft (draft or validated,
                oldest first) and submits the valid ones to the FIRS stamping
                rail, in batches of up to 200. Submission cannot be undone.
                Drafts that fail validation stay pending, with their issues
                listed so you can fix them.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                disabled={isPending}
                data-testid="button-confirm-bulk-submit"
              >
                {isPending ? "Submitting…" : "Validate & submit"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle data-testid="text-bulk-headline">
                {bulkRows.length === 0
                  ? "No pending drafts"
                  : `Submitted ${bulkSubmitted} of ${bulkRows.length}`}
              </DialogTitle>
              <DialogDescription>
                {bulkRows.length === 0
                  ? "There was nothing to validate — every invoice is already past the draft stage."
                  : bulkNeedsAttention.length === 0
                    ? "Every pending draft in this run is now on the stamping rail."
                    : `${bulkNeedsAttention.length} draft(s) need a fix before they can be submitted.`}
              </DialogDescription>
            </DialogHeader>
            {bulkNeedsAttention.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Needs attention</p>
                <ul className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {bulkNeedsAttention.map((r) => (
                    <li
                      key={r.invoiceId}
                      className="text-sm border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link
                          href={`/invoices/${r.invoiceId}`}
                          onClick={onClose}
                          className="font-semibold truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                          data-testid={`link-bulk-row-${r.invoiceId}`}
                        >
                          {r.invoiceNumber}
                        </Link>
                        <span
                          className={pillClasses(
                            r.outcome === "invalid" ? "amber" : "red",
                          )}
                        >
                          {r.outcome === "invalid" ? "Invalid" : "Failed"}
                        </span>
                      </div>
                      <p className="text-xs text-destructive mt-1">
                        {r.errors[0]
                          ? `${r.errors[0].field}: ${r.errors[0].message}`
                          : r.error ||
                            "Submission failed — open the invoice for details."}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.remaining > 0 && (
              <p className="text-sm text-muted-foreground">
                {report.remaining} more pending draft
                {report.remaining === 1 ? "" : "s"} — invalid drafts stay
                pending until fixed, so they count toward this total.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {report.remaining > 0 && (
                <Button
                  onClick={onConfirm}
                  disabled={isPending}
                  data-testid="button-bulk-next-batch"
                >
                  {isPending ? "Submitting…" : "Submit next batch"}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

type AdvancedFilterValues = {
  fromDate: string;
  toDate: string;
  minAmount: string;
  maxAmount: string;
};

// Controlled advanced-filters card: the parent owns the four filter values
// (the row filtering and the Filters toggle button read them); the card
// derives its own has-values flag for the Clear button.
function AdvancedFiltersCard({
  values,
  onChange,
  onClear,
}: {
  values: AdvancedFilterValues;
  onChange: (values: AdvancedFilterValues) => void;
  onClear: () => void;
}) {
  const hasValues =
    !!values.fromDate || !!values.toDate || !!values.minAmount || !!values.maxAmount;
  return (
    <Card>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6">
        <div>
          <Label htmlFor="filter-from" className="text-xs">
            Issued from
          </Label>
          <Input
            id="filter-from"
            type="date"
            value={values.fromDate}
            onChange={(e) => onChange({ ...values, fromDate: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="filter-to" className="text-xs">
            Issued to
          </Label>
          <Input
            id="filter-to"
            type="date"
            value={values.toDate}
            onChange={(e) => onChange({ ...values, toDate: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="filter-min" className="text-xs">
            Min amount (₦)
          </Label>
          <Input
            id="filter-min"
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="0"
            value={values.minAmount}
            onChange={(e) => onChange({ ...values, minAmount: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="filter-max" className="text-xs">
            Max amount (₦)
          </Label>
          <Input
            id="filter-max"
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="Any"
            value={values.maxAmount}
            onChange={(e) => onChange({ ...values, maxAmount: e.target.value })}
          />
        </div>
        {hasValues && (
          <div className="sm:col-span-2">
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Invoices() {
  usePageTitle("Invoices");
  const { data: me } = useGetMe();
  const { data: parties } = useListParties();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const bulkSubmit = useBulkSubmitInvoices();
  const [search, setSearch] = useState("");
  // Bulk submit dialog: `bulkReport === null` is the confirmation step; a
  // report switches it to the results view. Rows accumulate across batches,
  // deduped by invoiceId (an invalid draft stays pending by design, so it
  // reappears in every batch until fixed).
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReport, setBulkReport] = useState<{
    rows: BulkSubmitRowResult[];
    remaining: number;
  } | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  const {
    loaded,
    hasLoaded,
    hasMore,
    loadingMore,
    initialLoading,
    isError,
    refetch,
    loadMore,
    resetToFirstPage,
    query,
  } = useAccumulatedInvoicePages(search);

  const partyName = useMemo(
    () => idMap(parties, (p) => p.id, (p) => p.legalName),
    [parties],
  );

  const hasAdvanced =
    !!fromDate || !!toDate || !!minAmount || !!maxAmount;
  const hasAnyFilter = hasAdvanced || !!search.trim() || filter !== "all";

  const clearAdvanced = () => {
    setFromDate("");
    setToDate("");
    setMinAmount("");
    setMaxAmount("");
  };

  const clearAllFilters = () => {
    clearAdvanced();
    setSearch("");
    setFilter("all");
  };

  const openBulk = () => {
    setBulkReport(null);
    setBulkOpen(true);
  };

  // CSV of the current server-side search, as a plain browser navigation (no
  // react-query): the endpoint answers with a Content-Disposition attachment
  // and auth rides the session cookie, so the browser just downloads the file.
  // The status tabs are client-side tone groupings, so no status param is sent.
  const exportCsv = () => {
    window.location.assign(
      query
        ? `/api/invoices/export?q=${encodeURIComponent(query)}`
        : "/api/invoices/export",
    );
  };

  const closeBulk = () => {
    setBulkOpen(false);
    setBulkReport(null);
  };

  // One server-side batch per call: validate→submit up to 200 of this
  // client's oldest pending drafts. "Submit next batch" calls it again and
  // merges the new rows into the running report.
  const runBulkSubmit = async () => {
    if (!me?.clientPartyId) return;
    try {
      const res = await bulkSubmit.mutateAsync({
        data: { clientPartyId: me.clientPartyId },
      });
      setBulkReport((prev) => {
        const byId = new Map((prev?.rows ?? []).map((r) => [r.invoiceId, r]));
        res.rows.forEach((r) => byId.set(r.invoiceId, r));
        return { rows: [...byId.values()], remaining: res.remaining };
      });
      // Not awaited: a background refetch rejection must not surface as a
      // false "bulk submit failed" error after the batch already ran. The
      // no-args keys prefix-match every param variant of these queries.
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetReceivablesSummaryQueryKey(),
      });
      resetToFirstPage();
    } catch (e) {
      toast({
        title: "Bulk submit failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  // The client's own invoice book — the base every filter applies to. The
  // search is server-side (q matches the invoice number or either party's
  // legal name); the tab and advanced filters apply to the loaded rows. The
  // status tabs group raw statuses by tone (e.g. draft + validated), so they
  // can't map onto the server's exact-match `status` param.
  const scoped = useMemo(
    () => scopedToSupplier(loaded, me?.clientPartyId),
    [loaded, me?.clientPartyId],
  );

  const countFor = (key: (typeof FILTERS)[number]["key"]) =>
    key === "all"
      ? scoped.length
      : scoped.filter((inv) => statusTone(inv.status) === key).length;

  const rows = useMemo(() => {
    const minParsed = Number(minAmount);
    const maxParsed = Number(maxAmount);
    const min = minAmount && Number.isFinite(minParsed) ? minParsed : null;
    const max = maxAmount && Number.isFinite(maxParsed) ? maxParsed : null;
    return scoped
      .filter((inv) => (filter === "all" ? true : statusTone(inv.status) === filter))
      .filter((inv) => (fromDate ? inv.issueDate >= fromDate : true))
      .filter((inv) => (toDate ? inv.issueDate <= toDate : true))
      .filter((inv) => (min !== null ? Number(inv.grandTotal) >= min : true))
      .filter((inv) => (max !== null ? Number(inv.grandTotal) <= max : true));
  }, [scoped, filter, fromDate, toDate, minAmount, maxAmount]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoice vault"
        description="Every invoice, write-once and searchable."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={initialLoading}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4 mr-2" aria-hidden="true" />
            Export CSV
          </Button>
          {me?.clientPartyId && (
            <Button
              variant="outline"
              onClick={openBulk}
              disabled={initialLoading || bulkSubmit.isPending}
              data-testid="button-bulk-submit"
            >
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              {bulkSubmit.isPending ? "Submitting…" : "Submit all drafts"}
            </Button>
          )}
          <Button asChild>
            <Link href="/invoices/new">New invoice</Link>
          </Button>
        </div>
      </PageHeader>

      <BulkSubmitDialog
        open={bulkOpen}
        report={bulkReport}
        isPending={bulkSubmit.isPending}
        onConfirm={runBulkSubmit}
        onClose={closeBulk}
      />

      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Label htmlFor="invoice-search" className="sr-only">
          Search invoices
        </Label>
        <Input
          id="invoice-search"
          placeholder="Search by invoice number or customer"
          value={search}
          maxLength={120}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="button-clear-search"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={isActive}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border min-h-9 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground hover:bg-muted"
              }`}
            >
              {f.label}
              {hasLoaded ? ` · ${countFor(f.key)}` : ""}
            </button>
          );
        })}
        <Button
          variant={hasAdvanced ? "default" : "outline"}
          size="sm"
          className="ml-auto rounded-full"
          onClick={() => setShowFilters((s) => !s)}
          aria-pressed={showFilters}
        >
          <SlidersHorizontal className="w-4 h-4 mr-1.5" aria-hidden="true" />
          Filters{hasAdvanced ? " (on)" : ""}
        </Button>
      </div>

      {showFilters && (
        <AdvancedFiltersCard
          values={{ fromDate, toDate, minAmount, maxAmount }}
          onChange={(next) => {
            setFromDate(next.fromDate);
            setToDate(next.toDate);
            setMinAmount(next.minAmount);
            setMaxAmount(next.maxAmount);
          }}
          onClear={clearAdvanced}
        />
      )}

      {initialLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : isError && !hasLoaded ? (
        <QueryError thing="your invoices" onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        scoped.length === 0 && !hasAnyFilter ? (
          <Card>
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description={
                <>
                  Create your first invoice, or bring your whole book across in one
                  go with{" "}
                  <Link href="/import" className="text-primary hover:underline">
                    bulk import
                  </Link>
                  .
                </>
              }
            >
              <Button asChild className="mt-2">
                <Link href="/invoices/new">Create your first invoice</Link>
              </Button>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={FileText}
              title="No matches"
              description="No invoices match the current search and filters."
            >
              <Button variant="outline" className="mt-2" onClick={clearAllFilters}>
                Clear filters
              </Button>
            </EmptyState>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {rows.map((inv) => (
            <Link key={inv.id} href={`/invoices/${inv.id}`} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <Card className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardContent className="flex items-center justify-between p-4 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold truncate">
                        {inv.invoiceNumber}
                      </span>
                      <span className={badgeClasses(inv.status)}>
                        {statusLabel(inv.status)}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 truncate">
                      {partyName.get(inv.buyerPartyId) || "Unknown customer"} ·
                      Issued {formatDate(inv.issueDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-semibold tabular-nums">
                      {formatNaira(inv.grandTotal)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {hasLoaded && loaded.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
          <span data-testid="text-showing-count">
            Showing {rows.length} invoice{rows.length === 1 ? "" : "s"}
          </span>
          {isError ? (
            <>
              <span className="text-destructive">
                Unable to load more invoices.
              </span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            </>
          ) : hasMore || loadingMore ? (
            <Button
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={loadingMore}
              data-testid="button-load-more"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
