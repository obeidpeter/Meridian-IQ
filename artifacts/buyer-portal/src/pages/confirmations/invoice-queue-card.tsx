import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Inbox, SearchX } from "lucide-react";
import { InvoiceRow } from "./invoice-row";
import { BulkActionBar } from "./bulk-action-bar";
import type { ConfirmationsPageState } from "./use-confirmations-page";

export function InvoiceQueueCard({ state }: { state: ConfirmationsPageState }) {
  const {
    isFetching,
    showSelectionColumn,
    allSelected,
    setSelected,
    selectAllTargets,
    selected,
    filtered,
    visible,
    toggleRow,
    pageCount,
    serverPage,
    hasNextServerPage,
  } = state;
  return (
    <Card aria-busy={isFetching}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Invoices</CardTitle>
          {showSelectionColumn && (
            <div className="flex items-center gap-2">
              <Checkbox
                className="size-6"
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
        {selected.size > 0 && <BulkActionBar state={state} />}

        {filtered.length === 0 ? (
          <EmptyQueue state={state} />
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
            {(pageCount > 1 || serverPage > 0 || hasNextServerPage) && (
              <QueuePagination state={state} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyQueue({ state }: { state: ConfirmationsPageState }) {
  const {
    isFirstRun,
    query,
    filter,
    hasActiveNarrowing,
    setFilter,
    setSearch,
    setPage,
    setServerPage,
  } = state;
  return (
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
            organization on Valo.
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
                setServerPage(0);
              }}
              data-testid="button-clear-filters"
            >
              Clear filters
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function QueuePagination({ state }: { state: ConfirmationsPageState }) {
  const {
    visibleStart,
    visibleEnd,
    hasPreviousPage,
    goToPreviousPage,
    displayPage,
    hasNextPage,
    goToNextPage,
  } = state;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <p
        className="text-xs text-muted-foreground tabular-nums"
        data-testid="text-truncated"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Showing {visibleStart} to {visibleEnd}
      </p>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              aria-disabled={!hasPreviousPage}
              className={
                !hasPreviousPage ? "pointer-events-none opacity-50" : undefined
              }
              onClick={(e) => {
                e.preventDefault();
                goToPreviousPage();
              }}
              data-testid="button-page-previous"
            />
          </PaginationItem>
          <PaginationItem>
            <span className="px-2 text-sm text-muted-foreground tabular-nums">
              Page {displayPage}
            </span>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              href="#"
              aria-disabled={!hasNextPage}
              className={
                !hasNextPage ? "pointer-events-none opacity-50" : undefined
              }
              onClick={(e) => {
                e.preventDefault();
                goToNextPage();
              }}
              data-testid="button-page-next"
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
