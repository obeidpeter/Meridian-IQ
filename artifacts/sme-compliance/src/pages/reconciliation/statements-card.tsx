import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { Landmark } from "lucide-react";
import {
  formatDate,
  formatPct,
  statementStatusLabel,
  statementBadgeClasses,
} from "@/lib/format";
import type { ReconciliationState } from "./use-reconciliation";

/** Section 2 — the committed statements list; selecting one opens section 3. */
export function StatementsCard({
  statements,
  statementsLoading,
  statementsIsError,
  refetchStatements,
  selectedId,
  setSelectedId,
}: Pick<
  ReconciliationState,
  | "statements"
  | "statementsLoading"
  | "statementsIsError"
  | "refetchStatements"
  | "selectedId"
  | "setSelectedId"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">2. Your statements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {statementsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : statementsIsError ? (
          <QueryError
            thing="your bank statements"
            onRetry={() => refetchStatements()}
          />
        ) : (statements || []).length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No statements yet"
            description="Upload a bank CSV or scanned PDF above to start reconciling."
            className="px-0 py-8 justify-center"
          />
        ) : (
          (statements || []).map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              aria-pressed={selectedId === s.id}
              className={`w-full text-left border rounded-md px-3 py-2 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                selectedId === s.id ? "border-primary bg-primary/5" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">
                      {s.filename || s.formatKey}
                    </span>
                    <span className={statementBadgeClasses(s.status)}>
                      {statementStatusLabel(s.status)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {s.parsedCount} of {s.lineCount} line(s) parsed · Parse rate{" "}
                    {s.lineCount > 0
                      ? formatPct(s.parsedCount / s.lineCount, 0)
                      : "—"}{" "}
                    · Uploaded {formatDate(s.createdAt)}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {selectedId === s.id ? "Selected" : "View matches"}
                </span>
              </div>
            </button>
          ))
        )}
      </CardContent>
    </Card>
  );
}
