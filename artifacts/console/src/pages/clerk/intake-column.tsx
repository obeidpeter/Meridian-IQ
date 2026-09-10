import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { caseIntakeKind, isReadyToApprove } from "@/pages/clerk-shared";
import { Plus, Search, ShieldCheck } from "lucide-react";
import { OPEN_STATUSES, QUEUE_STATUS } from "./constants";
import { CaptureForm } from "./capture-form";
import { IntakeEmptyState } from "./intake-empty-state";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The left column (R120): new intake capture, batch mode, the queue filters
// and the paged case list. Renders the workspace state it is handed.
export function IntakeColumn({ state }: { state: ClerkWorkspaceState }) {
  const {
    queueKind,
    queueSearch,
    setQueueSearch,
    switchQueueKind,
    hasMoreCases,
    loadingMoreCases,
    loadMoreCases,
    selectedId,
    setSelectedId,
    captureOpen,
    setCaptureOpen,
    batchResult,
    sortedCases,
    filteredCases,
    readyCount,
    bulkCandidates,
    setBulkOpen,
    queueGroups,
    batchById,
  } = state;
  return (
    <Card className="self-start lg:sticky lg:top-24 lg:flex lg:max-h-[calc(100vh-7rem)] lg:flex-col lg:overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-baseline gap-2">
          New intake
          <span
            className="text-sm font-normal text-muted-foreground"
            data-testid="text-open-count"
          >
            {sortedCases.filter((c) => OPEN_STATUSES.has(c.status)).length} open
          </span>
          {readyCount > 0 && (
            <span
              className="text-sm font-normal text-emerald-700 dark:text-emerald-400"
              data-testid="text-ready-count"
            >
              {readyCount} ready
            </span>
          )}
        </CardTitle>
        <Button
          size="sm"
          onClick={() => setCaptureOpen((o) => !o)}
          data-testid="button-new-capture"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={queueSearch}
            onChange={(event) => setQueueSearch(event.target.value)}
            placeholder="Search cases"
            className="pl-9"
            aria-label="Search intake cases"
            data-testid="input-search-cases"
          />
        </div>
        {/* One queue kind at a time: invoice extraction cases or
                    tax-authority notice cases (Notice Desk). The kind
                    travels to the server as the list's kind param. */}
        <div className="flex gap-1" aria-label="Intake kind">
          <Button
            size="sm"
            aria-pressed={queueKind === "extraction"}
            variant={queueKind === "extraction" ? "secondary" : "ghost"}
            onClick={() => switchQueueKind("extraction")}
            data-testid="tab-kind-extraction"
          >
            Invoices
          </Button>
          <Button
            size="sm"
            aria-pressed={queueKind === "notice"}
            variant={queueKind === "notice" ? "secondary" : "ghost"}
            onClick={() => switchQueueKind("notice")}
            data-testid="tab-kind-notice"
          >
            Notices
          </Button>
        </div>
        {/* Queue-level fast-lane approval: only when there is a lane
                    to bulk (2+ ready cases loaded). Everything it can do, the
                    dialog restates: fast-lane cases only, drafts only. */}
        {readyCount >= 2 && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setBulkOpen(true)}
            data-testid="button-bulk-approve"
          >
            <ShieldCheck className="w-4 h-4 mr-1" aria-hidden="true" />
            Approve fast lane ({bulkCandidates.length})
          </Button>
        )}
        {captureOpen && <CaptureForm state={state} />}
        {batchResult && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="batch-result"
          >
            Opened {batchResult.cases.length}{" "}
            {batchResult.cases.length === 1 ? "case" : "cases"} from{" "}
            {batchResult.segments}{" "}
            {batchResult.segments === 1 ? "invoice" : "invoices"} found
            {batchResult.skippedDuplicates > 0
              ? ` · ${batchResult.skippedDuplicates} ${
                  batchResult.skippedDuplicates === 1
                    ? "duplicate"
                    : "duplicates"
                } skipped`
              : ""}
          </p>
        )}
        {/* The query carries the active tab's kind param, so no
                    client-side kind filter is needed here. */}
        {filteredCases.length === 0 ? (
          <IntakeEmptyState state={state} />
        ) : (
          <div className="space-y-2">
            {queueGroups.map((g) => {
              const rows = g.cases.map((c) => {
                const kind = caseIntakeKind(c);
                const Icon = kind.icon;
                const status = QUEUE_STATUS[c.status];
                const ready = isReadyToApprove(c);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    aria-current={selectedId === c.id ? "true" : undefined}
                    className={`w-full text-left flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 ${
                      selectedId === c.id
                        ? "border-primary/50 ring-1 ring-primary/30 bg-muted/40"
                        : "border-border"
                    }`}
                    data-testid={`row-case-${c.id}`}
                  >
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
                      aria-hidden="true"
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="flex-1 min-w-0 block">
                      <span className="block text-xs text-muted-foreground">
                        {kind.label} · {formatDateTime(c.createdAt)}
                        {/* Kind badge: notices carry a distinct violet
                                  marker so a statutory notice never blends
                                  in with invoice paper. */}
                        {c.kind === "notice" && (
                          <span
                            className="ml-1.5 inline-flex items-center rounded-full border border-violet-200 bg-violet-100 px-1.5 py-px text-[10px] font-medium text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300"
                            data-testid="notice-pill"
                          >
                            Notice
                          </span>
                        )}
                      </span>
                      <span className="block text-sm font-semibold truncate mt-0.5">
                        {c.sourceName ?? "Untitled"}
                      </span>
                      <span
                        className={`block text-sm font-medium mt-1 ${status.cls}`}
                      >
                        {status.label}
                        {ready && (
                          <span
                            className="ml-1.5 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-100 px-1.5 py-px text-[10px] font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                            data-testid="ready-pill"
                          >
                            Ready
                          </span>
                        )}
                        {c.status === "in_review" ? (
                          <span
                            className="ml-1.5 text-[10px] uppercase text-muted-foreground font-normal"
                            data-testid={`indicator-claimed-${c.id}`}
                          >
                            claimed
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              });
              if (g.batchId === null) return rows;
              const batch = batchById.get(g.batchId);
              return (
                <div
                  key={`batch-${g.batchId}`}
                  className="space-y-2 rounded-lg border border-dashed border-border p-2"
                  data-testid={`group-batch-${g.batchId}`}
                >
                  <p className="px-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {batch?.name?.trim() || "Batch intake"}
                    </span>
                    {/* Counts only when the batch row resolved — a
                                batch beyond the newest-50 list must not
                                assert "0 reviewed". */}
                    {batch && (
                      <>
                        {" · "}
                        {batch.reviewedCases} of {batch.createdCases} reviewed
                      </>
                    )}
                  </p>
                  {rows}
                </div>
              );
            })}
          </div>
        )}
        {(hasMoreCases || loadingMoreCases) && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={loadMoreCases}
            disabled={loadingMoreCases}
            data-testid="button-load-more-cases"
          >
            {loadingMoreCases ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
