import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { SkeletonList } from "@/components/skeleton-list";
import { formatDateTime } from "@/lib/format";
import { captureBadgeClasses, captureStatusLabel } from "@/lib/clerk";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { CaseDetail } from "./case-detail";
import type { CaptureState } from "./use-capture";

/** The "My submissions" card: the caller's cases, one expandable per row. */
export function SubmissionsCard({
  isLoading,
  isError,
  refetch,
  sortedCases,
  selectedId,
  setSelectedId,
}: Pick<
  CaptureState,
  | "isLoading"
  | "isError"
  | "refetch"
  | "sortedCases"
  | "selectedId"
  | "setSelectedId"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My submissions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <SkeletonList count={3} itemClassName="h-16" className="space-y-2" />
        ) : isError ? (
          <QueryError thing="your submissions" onRetry={() => refetch()} />
        ) : sortedCases.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Nothing sent yet"
            description="Your submissions and their review status will show up here."
            className="py-8"
          >
            {/* Wired to the real file input above — the CTA opens the same
                  picker the form uses, so "snap" (mobile camera) and upload
                  both just work. */}
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => document.getElementById("capture-file")?.click()}
              data-testid="button-empty-first-capture"
            >
              Snap or upload your first document
            </Button>
          </EmptyState>
        ) : (
          sortedCases.map((c) => {
            const expanded = selectedId === c.id;
            return (
              <div
                key={c.id}
                className={`rounded-lg border transition-colors ${
                  expanded ? "border-primary/50 bg-muted/30" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(expanded ? null : c.id)}
                  aria-expanded={expanded}
                  className="flex w-full items-center justify-between gap-3 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  data-testid={`row-case-${c.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">
                      {c.sourceName ?? "Untitled"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Sent {formatDateTime(c.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={captureBadgeClasses(c.status)}>
                      {captureStatusLabel(c.status)}
                    </span>
                    {expanded ? (
                      <ChevronDown
                        className="w-4 h-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        className="w-4 h-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </button>
                {expanded && (
                  <div className="px-3 pb-3">
                    <CaseDetail caseId={c.id} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
