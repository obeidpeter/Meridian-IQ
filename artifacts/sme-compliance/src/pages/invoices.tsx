import { useRef, useState, type RefObject } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useBulkSubmitInvoices,
  getListInvoicesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
} from "@workspace/api-client-react";
import type { BulkSubmitRowResult, Invoice } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
import { useUrlParam, useUrlTab } from "@workspace/web-ui";
import { PillToggle } from "@/components/pill-toggle";
import { QueryError } from "@/components/query-error";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { CustomerName } from "@/components/customer-directory-picker";
import { useInvoicePages } from "@/lib/invoice-pages";
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
  formatAmount,
  formatDate,
  formatNaira,
  statusLabel,
  badgeClasses,
  statusTone,
  pillClasses,
} from "@/lib/format";

// Tabs group raw statuses by TONE (statusTone) so the tab words can mirror
// the row badges exactly: Drafts covers draft+validated, Pending stamp covers
// submitted, Stamped covers stamped+confirmed, and Closed collects the
// terminal credited/cancelled records that used to be reachable only via All.
export const FILTERS = [
  { key: "all", label: "All", tones: [] },
  { key: "draft", label: "Drafts", tones: ["draft"] },
  { key: "pending", label: "Pending stamp", tones: ["pending"] },
  { key: "stamped", label: "Stamped", tones: ["stamped"] },
  { key: "settled", label: "Settled", tones: ["settled"] },
  { key: "failed", label: "Failed", tones: ["failed"] },
  { key: "closed", label: "Closed", tones: ["credited", "cancelled"] },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];
const FILTER_KEYS: readonly FilterKey[] = FILTERS.map((f) => f.key);

// Which tab a row belongs to. Off-contract "unknown" tones match only All.
// Exported for the unit tests.
export function matchesFilter(inv: Invoice, key: FilterKey): boolean {
  if (key === "all") return true;
  const f = FILTERS.find((f) => f.key === key);
  return !!f && (f.tones as readonly string[]).includes(statusTone(inv.status));
}

// The vault's Min/Max filters are ₦-labeled, so they compare naira VALUE:
// foreign invoices convert through their captured FX rate; one without a
// rate cannot be compared, so it only shows while no amount filter is set.
export function nairaEquivalent(
  inv: Pick<Invoice, "currency" | "grandTotal" | "fxRateToNgn">,
): number | null {
  if (inv.currency === "NGN") return Number(inv.grandTotal);
  const rate = Number(inv.fxRateToNgn);
  return Number.isFinite(rate) && rate > 0
    ? Number(inv.grandTotal) * rate
    : null;
}

// The same conversion as a visible line: VAT is assessed in naira, so a
// foreign amount should never appear without its naira value when the
// captured rate makes one computable (a rate is never assumed). NGN rows and
// rate-less foreign rows get no line.
export function nairaApproxLine(
  inv: Pick<Invoice, "currency" | "grandTotal" | "fxRateToNgn">,
): string | null {
  if (inv.currency === "NGN") return null;
  const value = nairaEquivalent(inv);
  return value === null ? null : `≈ ${formatNaira(value.toFixed(2))}`;
}

// The two-step bulk-submit dialog: `report === null` is the confirmation
// step; a report switches it to the results view. Purely presentational —
// the mutation, report merging, and query invalidations live in the parent.
function BulkSubmitDialog({
  open,
  report,
  isPending,
  triggerRef,
  onConfirm,
  onClose,
}: {
  open: boolean;
  report: { rows: BulkSubmitRowResult[]; remaining: number } | null;
  isPending: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const bulkRows = report?.rows ?? [];
  const bulkSubmitted = bulkRows.filter(
    (r) => r.outcome === "submitted",
  ).length;
  const bulkNeedsAttention = bulkRows.filter((r) => r.outcome !== "submitted");

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent
        closeDisabled={isPending}
        onCloseAutoFocus={(event) => {
          // This controlled dialog's trigger lives outside its Radix root.
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        {report === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Submit all pending drafts?</DialogTitle>
              <DialogDescription>
                This validates every pending draft (draft or validated, oldest
                first) and submits the valid ones to the FIRS stamping rail, in
                batches of up to 200. Submission cannot be undone. Drafts that
                fail validation stay pending, with their issues listed so you
                can fix them.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={isPending}>
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
                      {r.errors.length > 0 ? (
                        r.errors.map((err, i) => (
                          <p
                            key={`${err.field}-${i}`}
                            className="text-xs text-destructive mt-1"
                          >
                            {err.field}: {err.message}
                          </p>
                        ))
                      ) : (
                        <p className="text-xs text-destructive mt-1">
                          {r.error ||
                            "Submission failed — open the invoice for details."}
                        </p>
                      )}
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
              <Button variant="ghost" onClick={onClose} disabled={isPending}>
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
    !!values.fromDate ||
    !!values.toDate ||
    !!values.minAmount ||
    !!values.maxAmount;
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const bulkSubmit = useBulkSubmitInvoices();
  const [search, setSearch] = useUrlParam("q");
  // Bulk submit dialog: `bulkReport === null` is the confirmation step; a
  // report switches it to the results view. Rows accumulate across batches,
  // deduped by invoiceId (an invalid draft stays pending by design, so it
  // reappears in every batch until fixed).
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkTriggerRef = useRef<HTMLButtonElement>(null);
  const [bulkReport, setBulkReport] = useState<{
    rows: BulkSubmitRowResult[];
    remaining: number;
  } | null>(null);
  // URL-persisted (recognition over recall): a bookmark or the Today tile's
  // "Open vault" link lands on the Stamped view directly, and back-navigation
  // from an invoice returns to the same shelf of the vault (D16).
  const [filter, setFilter] = useUrlTab<FilterKey>(
    "filter",
    "all",
    FILTER_KEYS,
  );
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useUrlParam("fromDate");
  const [toDate, setToDate] = useUrlParam("toDate");
  const [minAmount, setMinAmount] = useUrlParam("minAmount");
  const [maxAmount, setMaxAmount] = useUrlParam("maxAmount");

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
    counts,
    total,
  } = useInvoicePages(
    search,
    { statusGroup: filter, fromDate, toDate, minAmount, maxAmount },
    me ? `${me.firmId}:${me.userId}:${me.clientPartyId}` : "",
  );

  const hasAdvanced = !!fromDate || !!toDate || !!minAmount || !!maxAmount;
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

  const rows = loaded;

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
              ref={bulkTriggerRef}
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
        triggerRef={bulkTriggerRef}
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
        {FILTERS.map((f) => (
          <PillToggle
            key={f.key}
            active={filter === f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-invoices-${f.key}`}
          >
            {f.label}
            {counts[f.key] !== undefined ? ` · ${counts[f.key]}` : ""}
          </PillToggle>
        ))}
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

      <p
        className="text-xs text-muted-foreground"
        data-testid="text-lifecycle-legend"
      >
        Lifecycle: Draft → Validated → Pending stamp → Stamped → Settled.
        Rejected submissions show under Failed; credited and cancelled invoices
        under Closed.
      </p>

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
        <SkeletonList count={5} itemClassName="h-20" />
      ) : isError && !hasLoaded ? (
        <QueryError thing="your invoices" onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        !hasAnyFilter ? (
          <Card>
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description={
                <>
                  Create your first invoice, or bring your whole book across in
                  one go with{" "}
                  <Link
                    href="/import"
                    className="rounded-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
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
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {hasMore && (
                  <Button
                    onClick={loadMore}
                    disabled={loadingMore}
                    data-testid="button-load-more-empty"
                  >
                    {loadingMore ? "Loading…" : "Load older invoices"}
                  </Button>
                )}
                <Button variant="outline" onClick={clearAllFilters}>
                  Clear filters
                </Button>
              </div>
            </EmptyState>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {rows.map((inv) => (
            <Link
              key={inv.id}
              href={`/invoices/${inv.id}`}
              className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
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
                      {inv.buyerLegalName || (
                        <CustomerName id={inv.buyerPartyId} />
                      )}{" "}
                      · Issued {formatDate(inv.issueDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <span className="font-semibold tabular-nums">
                        {formatAmount(inv.grandTotal, inv.currency)}
                      </span>
                      {nairaApproxLine(inv) && (
                        <p
                          className="text-xs text-muted-foreground tabular-nums"
                          data-testid={`text-ngn-equivalent-${inv.id}`}
                        >
                          {nairaApproxLine(inv)}
                        </p>
                      )}
                    </div>
                    <ChevronRight
                      className="w-4 h-4 text-muted-foreground"
                      aria-hidden="true"
                    />
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
            Showing {rows.length} of {total ?? "..."} invoice
            {total === 1 ? "" : "s"}
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
          ) : (hasMore || loadingMore) && rows.length > 0 ? (
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
