import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { ScanSearch, Check, Sparkles } from "lucide-react";
import { narrationChipFor, narrationSummaryLine } from "./helpers";
import { ProposalCard } from "./proposal-card";
import type { ReconciliationState } from "./use-reconciliation";

/**
 * The bulk-accept / narration-suggest action row and the narration run
 * summary. Returns a fragment (no wrapper element) so both stay direct
 * children of the card's space-y-3 content, exactly as before the split.
 */
function ProposalActions({
  bulkEligibleCount,
  showNarrationSuggest,
  runBulkAccept,
  bulkAccept,
  decidingId,
  bulkArmed,
  runNarrationSuggest,
  narrationMut,
  narrationSummary,
  selectedId,
}: Pick<
  ReconciliationState,
  | "bulkEligibleCount"
  | "showNarrationSuggest"
  | "runBulkAccept"
  | "bulkAccept"
  | "decidingId"
  | "bulkArmed"
  | "runNarrationSuggest"
  | "narrationMut"
  | "narrationSummary"
  | "selectedId"
>) {
  return (
    <>
      {(bulkEligibleCount > 0 || showNarrationSuggest) && (
        <div className="flex flex-wrap items-center gap-2">
          {bulkEligibleCount > 0 && (
            <Button
              size="sm"
              onClick={runBulkAccept}
              disabled={bulkAccept.isPending || decidingId !== null}
              data-testid="button-bulk-accept"
            >
              <Check className="w-4 h-4 mr-1" aria-hidden="true" />
              {bulkAccept.isPending
                ? "Accepting…"
                : bulkArmed
                  ? "Click again to confirm"
                  : `Accept all ≥ 85% (${bulkEligibleCount})`}
            </Button>
          )}
          {showNarrationSuggest && (
            <Button
              size="sm"
              variant="outline"
              onClick={runNarrationSuggest}
              disabled={narrationMut.isPending}
              data-testid="button-narration-suggest"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {narrationMut.isPending
                ? "Reading narrations…"
                : "Ask Clerk to read the narrations"}
            </Button>
          )}
        </div>
      )}
      {narrationSummary && narrationSummary.statementId === selectedId && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-testid="narration-summary"
        >
          {narrationSummaryLine(narrationSummary)}
        </p>
      )}
    </>
  );
}

/** Section 3 — the selected statement's match proposals. */
export function ProposalsCard({
  selectedId,
  selectedStatement,
  bulkEligibleCount,
  showNarrationSuggest,
  runBulkAccept,
  bulkAccept,
  decidingId,
  bulkArmed,
  runNarrationSuggest,
  narrationMut,
  narrationSummary,
  proposals,
  proposalsLoading,
  proposalsIsError,
  refetchProposals,
  linesById,
  assistingId,
  assistById,
  decide,
  explainMatch,
}: Pick<
  ReconciliationState,
  | "selectedId"
  | "selectedStatement"
  | "bulkEligibleCount"
  | "showNarrationSuggest"
  | "runBulkAccept"
  | "bulkAccept"
  | "decidingId"
  | "bulkArmed"
  | "runNarrationSuggest"
  | "narrationMut"
  | "narrationSummary"
  | "proposals"
  | "proposalsLoading"
  | "proposalsIsError"
  | "refetchProposals"
  | "linesById"
  | "assistingId"
  | "assistById"
  | "decide"
  | "explainMatch"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          3. Match proposals
          {selectedStatement
            ? ` — ${selectedStatement.filename || selectedStatement.formatKey}`
            : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Accepting a match records a settlement against the invoice and marks
          it as settled. Rejecting keeps the invoice outstanding.
        </p>
        <ProposalActions
          bulkEligibleCount={bulkEligibleCount}
          showNarrationSuggest={showNarrationSuggest}
          runBulkAccept={runBulkAccept}
          bulkAccept={bulkAccept}
          decidingId={decidingId}
          bulkArmed={bulkArmed}
          runNarrationSuggest={runNarrationSuggest}
          narrationMut={narrationMut}
          narrationSummary={narrationSummary}
          selectedId={selectedId}
        />
        {proposalsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : proposalsIsError ? (
          <QueryError
            thing="match proposals"
            onRetry={() => refetchProposals()}
          />
        ) : (proposals || []).length === 0 ? (
          <EmptyState icon={ScanSearch} className="px-0 py-8 justify-center">
            {selectedStatement && selectedStatement.status !== "reconciled" ? (
              <>
                <p className="font-semibold">Matching in progress…</p>
                <p className="text-sm text-muted-foreground">
                  The statement is committed; proposals appear here as soon as
                  matching finishes (a few seconds).
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold" data-testid="text-empty">
                  No match proposals
                </p>
                <p className="text-sm text-muted-foreground">
                  None of this statement's credits matched an open invoice.
                </p>
              </>
            )}
          </EmptyState>
        ) : (
          (proposals || []).map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              // Advisory only: the chip marks the proposal Clerk's
              // narration read points at — it never pre-selects
              // Accept.
              narrationChip={narrationChipFor(
                linesById.get(p.statementLineId),
                p.id,
              )}
              decidingId={decidingId}
              assistingId={assistingId}
              assist={assistById[p.id]}
              onDecide={decide}
              onExplain={explainMatch}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
