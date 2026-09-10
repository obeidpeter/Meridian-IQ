import type { ClerkCase } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { formatDateTime } from "@/lib/format";
import {
  caseIntakeKind,
  imageDataUri,
  voiceDuration,
} from "@/pages/clerk-shared";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The selected case's source panels (R126 moved them out of the review
// pane): the quoted text, the inline document image and the lazily fetched
// scanned pages. `selected` is the pane's narrowed case.
export function CaseSourcePanels({
  selected,
  state,
}: {
  selected: ClerkCase;
  state: ClerkWorkspaceState;
}) {
  const { imageOpen, setImageOpen } = state;
  return (
    <>
      {/* The source, quoted: a voice note's transcript or the
                        pasted text, with its provenance line. */}
      {selected.sourceText ? (
        <div
          className="rounded-lg border bg-muted/30 p-4 space-y-2.5"
          data-testid="card-source-text"
        >
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-white dark:bg-teal-500"
              aria-hidden="true"
            >
              {(() => {
                const Icon = caseIntakeKind(selected).icon;
                return <Icon className="h-4 w-4" />;
              })()}
            </span>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {selected.sourceDurationSec
                  ? `${voiceDuration(selected.sourceDurationSec)} ${caseIntakeKind(selected).label.toLowerCase()}`
                  : caseIntakeKind(selected).label}
              </span>{" "}
              · {formatDateTime(selected.createdAt)}
            </p>
          </div>
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
            {selected.sourceText}
          </p>
        </div>
      ) : null}
      {/* The captured document itself: a single photographed/
                        uploaded image rides on the case row, so it renders
                        with no extra fetch. Expanded by default — seeing the
                        paper is the whole point of the review pane. */}
      {selected.sourceImageB64 ? (
        <div
          className="rounded-lg border bg-muted/30 p-4 space-y-2.5"
          data-testid="card-source-image"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Document</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setImageOpen((o) => !o)}
              aria-expanded={imageOpen}
              data-testid="button-toggle-source-image"
            >
              {imageOpen ? "Collapse" : "Expand"}
            </Button>
          </div>
          {imageOpen && (
            <div className="max-h-96 overflow-auto rounded-md border bg-background">
              <img
                src={imageDataUri(selected.sourceImageB64)}
                alt={`Captured document for ${selected.sourceName ?? "this case"}`}
                className="w-full"
                data-testid="img-source-document"
              />
            </div>
          )}
        </div>
      ) : null}
      {/* A scanned PDF has neither text nor an inline image —
                        its rendered pages are fetched lazily, only when the
                        operator asks, and only while retention still holds
                        the document content. */}
      {selected.sourceType === "pdf" &&
      !selected.sourceText &&
      !selected.sourceImageB64 ? (
        <ScannedPagesCard selected={selected} state={state} />
      ) : null}
    </>
  );
}

// A scanned PDF's rendered pages: fetched only after "View pages", and only
// while retention still holds the document content.
function ScannedPagesCard({
  selected,
  state,
}: {
  selected: ClerkCase;
  state: ClerkWorkspaceState;
}) {
  const {
    pagesOpen,
    setPagesOpen,
    sourcePages,
    sourcePagesLoading,
    sourcePagesError,
    refetchSourcePages,
  } = state;
  return (
    <div
      className="rounded-lg border bg-muted/30 p-4 space-y-2.5"
      data-testid="card-source-pages"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Scanned document</p>
        {!pagesOpen && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPagesOpen(true)}
            data-testid="button-view-source-pages"
          >
            View pages
          </Button>
        )}
      </div>
      {pagesOpen &&
        (sourcePagesLoading ? (
          <Skeleton className="h-40" data-testid="skeleton-source-pages" />
        ) : sourcePagesError || !sourcePages ? (
          <QueryError
            thing="the scanned pages"
            onRetry={() => refetchSourcePages()}
            detail={
              sourcePagesError instanceof Error
                ? sourcePagesError.message
                : undefined
            }
          />
        ) : sourcePages.purged ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-source-purged"
          >
            The document content has been cleared by retention.
          </p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-auto rounded-md border bg-background p-2">
            {sourcePages.pages.map((page, i) => (
              <img
                key={i}
                src={imageDataUri(page)}
                alt={`Page ${i + 1} of ${selected.sourceName ?? "the scanned document"}`}
                className="w-full"
                data-testid={`img-source-page-${i + 1}`}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
