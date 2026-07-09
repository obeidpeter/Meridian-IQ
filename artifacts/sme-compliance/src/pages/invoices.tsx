import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListInvoices,
  useListParties,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { Search, FileText, ChevronRight, SlidersHorizontal } from "lucide-react";
import { formatNaira, formatDate, statusLabel, badgeClasses, statusTone } from "@/lib/format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Unsubmitted" },
  { key: "pending", label: "Pending" },
  { key: "stamped", label: "Stamped" },
  { key: "failed", label: "Failed" },
] as const;

export function Invoices() {
  usePageTitle("Invoices");
  const { data: me } = useGetMe();
  const { data: invoices, isLoading, isError, refetch } = useListInvoices();
  const { data: parties } = useListParties();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

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

  // The client's own invoice book — the base every filter applies to.
  const scoped = useMemo(
    () =>
      (invoices || []).filter(
        (inv) => !me?.clientPartyId || inv.supplierPartyId === me.clientPartyId,
      ),
    [invoices, me?.clientPartyId],
  );

  const countFor = (key: (typeof FILTERS)[number]["key"]) =>
    key === "all"
      ? scoped.length
      : scoped.filter((inv) => statusTone(inv.status) === key).length;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minParsed = Number(minAmount);
    const maxParsed = Number(maxAmount);
    const min = minAmount && Number.isFinite(minParsed) ? minParsed : null;
    const max = maxAmount && Number.isFinite(maxParsed) ? maxParsed : null;
    return scoped
      .filter((inv) => (filter === "all" ? true : statusTone(inv.status) === filter))
      .filter((inv) => {
        if (!q) return true;
        const counterparty = (partyName.get(inv.buyerPartyId) || "").toLowerCase();
        return (
          inv.invoiceNumber.toLowerCase().includes(q) ||
          counterparty.includes(q)
        );
      })
      .filter((inv) => (fromDate ? inv.issueDate >= fromDate : true))
      .filter((inv) => (toDate ? inv.issueDate <= toDate : true))
      .filter((inv) => (min !== null ? Number(inv.grandTotal) >= min : true))
      .filter((inv) => (max !== null ? Number(inv.grandTotal) <= max : true));
  }, [
    scoped,
    filter,
    search,
    partyName,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
  ]);

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
        <Button asChild>
          <Link href="/invoices/new">New invoice</Link>
        </Button>
      </div>

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
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
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
              {!isLoading && !isError ? ` · ${countFor(f.key)}` : ""}
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

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : isError ? (
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
    </div>
  );
}
