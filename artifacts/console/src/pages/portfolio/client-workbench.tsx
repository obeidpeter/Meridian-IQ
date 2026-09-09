import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { type ClientRisk } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollRegion } from "@/components/scroll-region";
import { PenaltyRiskInfo } from "@/components/penalty-risk-info";
import {
  ChevronRight,
  X,
  Search,
  Bookmark,
  BookmarkPlus,
  Trash2,
} from "lucide-react";
import { formatDate, riskBadgeClasses, riskLabel } from "@/lib/format";
import { trackUsabilityEvent, type SavedView } from "@workspace/web-ui";
import { formatMoney } from "./format";
import type { ClientRiskFilter, ClientScope, ClientSort } from "./client-scope";

export function SavedViewsBar({
  views,
  onApply,
  onSave,
  onRemove,
}: {
  views: SavedView[];
  onApply: (view: SavedView) => void;
  onSave: (name: string) => void;
  onRemove: (view: SavedView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  return (
    <div
      className="border-b border-border bg-muted/40 px-4 py-3"
      data-testid="portfolio-saved-views"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
          <Bookmark className="size-3.5" aria-hidden="true" />
          Saved views
        </span>
        {views.map((view) => (
          <span
            key={view.id}
            className="inline-flex min-h-8 max-w-full items-stretch overflow-hidden rounded-md border border-border bg-card"
          >
            <button
              type="button"
              className="max-w-48 truncate px-2.5 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => onApply(view)}
              title={`Apply ${view.name}`}
            >
              {view.name}
            </button>
            <button
              type="button"
              className="grid w-8 place-items-center border-l border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => onRemove(view)}
              aria-label={`Delete saved view ${view.name}`}
              title={`Delete ${view.name}`}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        ))}
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 bg-white text-xs"
            onClick={() => setEditing(true)}
            data-testid="button-save-portfolio-view"
          >
            <BookmarkPlus className="size-3.5" aria-hidden="true" />
            Save current view
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="mt-2 flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onSave(name);
            setName("");
            setEditing(false);
          }}
        >
          <Input
            autoFocus
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
            placeholder="View name, e.g. High risk this week"
            aria-label="Saved view name"
            className="h-9"
            data-testid="input-portfolio-view-name"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9 shrink-0"
            onClick={() => {
              setEditing(false);
              setName("");
            }}
            aria-label="Cancel saving view"
            title="Cancel"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </form>
      )}
      {views.length === 0 && !editing && (
        <p className="mt-1 text-xs text-muted-foreground">
          Keep useful search, risk, and sort combinations one click away.
        </p>
      )}
    </div>
  );
}

export function ClientWorkbenchTable({
  clients,
  totalClients,
  search,
  onSearchChange,
  risk,
  onRiskChange,
  sort,
  onSortChange,
  toolbar,
  compact = false,
  scope,
  onScopeChange,
  scopeCounts,
}: {
  clients: ClientRisk[];
  totalClients: number;
  search: string;
  onSearchChange: (value: string) => void;
  risk: ClientRiskFilter;
  onRiskChange: (value: ClientRiskFilter) => void;
  sort: ClientSort;
  onSortChange: (value: ClientSort) => void;
  toolbar?: ReactNode;
  compact?: boolean;
  scope: ClientScope;
  onScopeChange: (value: ClientScope) => void;
  scopeCounts: { mine: number; all: number };
}) {
  const zeroResultReported = useRef(false);

  useEffect(() => {
    const isZeroResultSearch =
      search.trim().length >= 2 && clients.length === 0;
    if (!isZeroResultSearch) {
      zeroResultReported.current = false;
      return;
    }
    if (zeroResultReported.current) return;
    zeroResultReported.current = true;
    trackUsabilityEvent("zero_result_search", "portfolio");
  }, [clients.length, search]);

  return (
    <section className="overflow-hidden rounded-[var(--mi-radius)] border border-border bg-card shadow-sm">
      {toolbar}
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-bold text-foreground">
            {compact ? "Clients needing attention" : "Client book"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Showing {clients.length} of {totalClients} clients
          </p>
          <div
            className="mt-2 inline-flex rounded-md border border-border bg-muted/50 p-0.5"
            role="group"
            aria-label="Client scope"
          >
            {(
              [
                ["mine", "My clients"],
                ["all", "All clients"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => onScopeChange(value)}
                className={`rounded px-2.5 py-1 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  scope === value
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`button-client-scope-${value}`}
              >
                {label}
                <span className="ml-1 tabular-nums text-[10px] font-semibold text-muted-foreground">
                  {scopeCounts[value]}
                </span>
              </button>
            ))}
          </div>
        </div>
        {!compact && (
          <div className="grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_10rem_11rem]">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search clients"
                className="h-9 pl-9"
                aria-label="Search clients"
              />
            </div>
            <Select value={risk} onValueChange={onRiskChange}>
              <SelectTrigger className="h-9" aria-label="Filter by risk">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All risk levels</SelectItem>
                <SelectItem value="high">High risk</SelectItem>
                <SelectItem value="medium">Medium risk</SelectItem>
                <SelectItem value="low">Low risk</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={onSortChange}>
              <SelectTrigger className="h-9" aria-label="Sort clients">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="risk">Risk first</SelectItem>
                <SelectItem value="deadline">Next deadline</SelectItem>
                <SelectItem value="unsubmitted">Unsubmitted value</SelectItem>
                <SelectItem value="name">Client name</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {clients.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <p className="text-sm font-bold text-foreground">
            No matching clients
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Change the search or risk filter to widen the client book.
          </p>
        </div>
      ) : (
        <ScrollRegion label="Client book table">
          <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
            <thead className="bg-muted/50 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Client</th>
                <th className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1">
                    Risk
                    <PenaltyRiskInfo />
                  </span>
                </th>
                <th className="px-3 py-2.5 text-right">Unsubmitted</th>
                <th className="px-3 py-2.5 text-right">Failed</th>
                <th className="px-3 py-2.5 text-right">Pending</th>
                <th className="px-3 py-2.5">Next deadline</th>
                <th className="w-24 px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {clients.map((client) => (
                <tr
                  key={client.clientPartyId}
                  className="transition-colors hover:bg-teal-50/40"
                  data-testid={`row-client-${client.clientPartyId}`}
                >
                  <td className="px-4 py-3">
                    <p className="max-w-64 truncate font-bold text-foreground">
                      <Link
                        href={`/clients/${client.clientPartyId}`}
                        className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        data-testid={`link-client-${client.clientPartyId}`}
                      >
                        {client.legalName}
                      </Link>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {client.totalInvoices} invoice
                      {client.totalInvoices === 1 ? "" : "s"}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <span className={riskBadgeClasses(client.penaltyRisk)}>
                      {riskLabel(client.penaltyRisk)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <p className="font-semibold text-foreground">
                      {formatMoney(client.unsubmittedValue, "NGN")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {client.unsubmittedCount} item
                      {client.unsubmittedCount === 1 ? "" : "s"}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums text-foreground">
                    {client.failedCount}
                  </td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums text-foreground">
                    {client.pendingCount}
                  </td>
                  <td className="px-3 py-3">
                    {client.nextDeadline ? (
                      <>
                        <p className="max-w-56 truncate font-medium text-foreground">
                          {client.nextDeadline.title}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatDate(client.nextDeadline.dueDate)}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No deadline
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/clients/${client.clientPartyId}`}>
                        Open
                        <ChevronRight className="size-4" aria-hidden="true" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
}
