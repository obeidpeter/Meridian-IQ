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
  const { data: me } = useGetMe();
  const { data: invoices, isLoading } = useListInvoices();
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

  const clearAdvanced = () => {
    setFromDate("");
    setToDate("");
    setMinAmount("");
    setMaxAmount("");
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minParsed = Number(minAmount);
    const maxParsed = Number(maxAmount);
    const min = minAmount && Number.isFinite(minParsed) ? minParsed : null;
    const max = maxAmount && Number.isFinite(maxParsed) ? maxParsed : null;
    const list = (invoices || []).filter(
      (inv) => !me?.clientPartyId || inv.supplierPartyId === me.clientPartyId,
    );
    return list
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
    invoices,
    me?.clientPartyId,
    filter,
    search,
    partyName,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
  ]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Invoice Vault</h1>
          <p className="text-muted-foreground">
            Every invoice, write-once and searchable.
          </p>
        </div>
        <Link
          href="/invoices/new"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
        >
          New Invoice
        </Link>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by invoice number or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
              filter === f.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground hover:bg-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
        <Button
          variant={hasAdvanced ? "default" : "outline"}
          size="sm"
          className="ml-auto rounded-full"
          onClick={() => setShowFilters((s) => !s)}
        >
          <SlidersHorizontal className="w-4 h-4 mr-1.5" />
          Filters{hasAdvanced ? " (on)" : ""}
        </Button>
      </div>

      {showFilters && (
        <Card>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6">
            <div>
              <Label className="text-xs">Issued from</Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Issued to</Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Min amount (₦)</Label>
              <Input
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Max amount (₦)</Label>
              <Input
                type="number"
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
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">No invoices found</p>
            <p className="text-sm text-muted-foreground">
              Try a different filter, or create a new invoice.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((inv) => (
            <Link key={inv.id} href={`/invoices/${inv.id}`}>
              <Card className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold truncate">
                        {inv.invoiceNumber}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${badgeClasses(inv.status)}`}
                      >
                        {statusLabel(inv.status)}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Issued {formatDate(inv.issueDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-semibold">
                      {formatNaira(inv.grandTotal)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
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
