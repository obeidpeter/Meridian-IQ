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
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { Search, FileText, ChevronRight, Send, SlidersHorizontal, X } from "lucide-react";
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

// The generated client throws an ApiError whose `data` carries the server's
// `{ error }` body (e.g. the 403 "consent required" refusal). The package does
// not export the class itself, so duck-type the field — mirrors lib/errors.ts.
function serverErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  }
  return error instanceof Error ? error.message : "Please try again.";
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
  // Debounced server-side search plus paging cursor, kept in one state object
  // so a new search term resets to the first page in the same update.
  const [paging, setPaging] = useState<{ q: string; offset: number }>({
    q: "",
    offset: 0,
  });
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

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

  const partyName = useMemo(() => {
    const map = new Map<string, string>();
    (parties || []).forEach((p) => map.set(p.id, p.legalName));
    return map;
  }, [parties]);

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
      // Drop the accumulated pages and jump back to the first page so the
      // refreshed statuses show instead of stale later pages.
      setPaging((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
      setPages((prev) => ({ q: prev.q, byOffset: {} }));
    } catch (e) {
      toast({
        title: "Bulk submit failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const bulkRows = bulkReport?.rows ?? [];
  const bulkSubmitted = bulkRows.filter((r) => r.outcome === "submitted").length;
  const bulkNeedsAttention = bulkRows.filter((r) => r.outcome !== "submitted");

  // The client's own invoice book — the base every filter applies to. The
  // search is server-side (q matches the invoice number or either party's
  // legal name); the tab and advanced filters apply to the loaded rows. The
  // status tabs group raw statuses by tone (e.g. draft + validated), so they
  // can't map onto the server's exact-match `status` param.
  const scoped = useMemo(
    () =>
      loaded.filter(
        (inv) => !me?.clientPartyId || inv.supplierPartyId === me.clientPartyId,
      ),
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Invoice vault
          </h1>
          <p className="text-muted-foreground mt-1">
            Every invoice, write-once and searchable.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
      </div>

      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          if (!open) closeBulk();
        }}
      >
        <DialogContent>
          {bulkReport === null ? (
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
                  onClick={closeBulk}
                  disabled={bulkSubmit.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={runBulkSubmit}
                  disabled={bulkSubmit.isPending}
                  data-testid="button-confirm-bulk-submit"
                >
                  {bulkSubmit.isPending ? "Submitting…" : "Validate & submit"}
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
                            onClick={closeBulk}
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
              {bulkReport.remaining > 0 && (
                <p className="text-sm text-muted-foreground">
                  {bulkReport.remaining} more pending draft
                  {bulkReport.remaining === 1 ? "" : "s"} — invalid drafts stay
                  pending until fixed, so they count toward this total.
                </p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={closeBulk}>
                  Close
                </Button>
                {bulkReport.remaining > 0 && (
                  <Button
                    onClick={runBulkSubmit}
                    disabled={bulkSubmit.isPending}
                    data-testid="button-bulk-next-batch"
                  >
                    {bulkSubmit.isPending ? "Submitting…" : "Submit next batch"}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

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
        <Card>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6">
            <div>
              <Label htmlFor="filter-from" className="text-xs">
                Issued from
              </Label>
              <Input
                id="filter-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="filter-to" className="text-xs">
                Issued to
              </Label>
              <Input
                id="filter-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
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
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
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
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
              />
            </div>
            {hasAdvanced && (
              <div className="sm:col-span-2">
                <Button variant="ghost" size="sm" onClick={clearAdvanced}>
                  Clear filters
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
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
            <CardContent className="py-12 flex flex-col items-center text-center gap-2">
              <FileText className="w-10 h-10 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold" data-testid="text-empty">
                No invoices yet
              </p>
              <p className="text-sm text-muted-foreground">
                Create your first invoice, or bring your whole book across in one
                go with{" "}
                <Link href="/import" className="text-primary hover:underline">
                  bulk import
                </Link>
                .
              </p>
              <Button asChild className="mt-2">
                <Link href="/invoices/new">Create your first invoice</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center gap-2">
              <FileText className="w-10 h-10 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold" data-testid="text-empty">
                No matches
              </p>
              <p className="text-sm text-muted-foreground">
                No invoices match the current search and filters.
              </p>
              <Button variant="outline" className="mt-2" onClick={clearAllFilters}>
                Clear filters
              </Button>
            </CardContent>
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
              onClick={() =>
                setPaging((prev) => ({
                  ...prev,
                  offset: prev.offset + PAGE_SIZE,
                }))
              }
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
