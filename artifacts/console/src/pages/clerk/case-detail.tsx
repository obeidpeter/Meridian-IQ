import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { QueryError } from "@/components/query-error";
import { formatDateTime, pillClasses } from "@/lib/format";
import {
  caseIntakeKind,
  correctionHint,
  imageDataUri,
  noticeTypeLabel,
  STATUS_TONE,
  truncateSnippet,
  voiceDuration,
} from "@/pages/clerk-shared";
import { AlertTriangle, Quote, ShieldCheck } from "lucide-react";
import { InvoiceDecisionForm } from "./invoice-decision-form";
import { ConfidenceBadge } from "./confidence-badge";
import { NoticeDecisionForm } from "./notice-decision-form";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The right column (R120): the selected case with its source text, image and
// pages, the extraction or notice decision form, claim controls and the
// retry path. Renders the workspace state it is handed.
export function CaseDetail({ state }: { state: ClerkWorkspaceState }) {
  const {
    setSelectedId,
    selected,
    imageOpen,
    setImageOpen,
    pagesOpen,
    setPagesOpen,
    sourcePages,
    sourcePagesLoading,
    sourcePagesError,
    refetchSourcePages,
    form,
    setForm,
    noticeForm,
    setNoticeForm,
    reason,
    setReason,
    noticeObligation,
    openSnippets,
    toggleSnippet,
    firms,
    parties,
    partySuggestions,
    decideCase,
    decideNotice,
    retryCase,
    queueMetrics,
    approveDisabled,
    detailExtraction,
    detailFieldLabel,
    preflightFields,
    linesPreflightHit,
    claimControls,
  } = state;
  return (
    <Card className="min-w-0 self-start">
      <CardHeader>
        {selected ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted-foreground">
                {caseIntakeKind(selected).eyebrow}
              </p>
              <CardTitle className="text-xl mt-1 truncate">
                {selected.sourceName ?? "Case detail"}
              </CardTitle>
            </div>
            <span
              className={pillClasses(STATUS_TONE[selected.status] ?? "slate")}
            >
              {selected.status.replace("_", " ")}
            </span>
          </div>
        ) : (
          <CardTitle className="text-base">Case detail</CardTitle>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            Select a case to view its details, or read a new document.
          </p>
        ) : (
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
                    <Skeleton
                      className="h-40"
                      data-testid="skeleton-source-pages"
                    />
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
            ) : null}
            {detailExtraction && (
              <p className="text-xs text-muted-foreground">
                read by {detailExtraction.model} (
                {detailExtraction.promptVersion})
              </p>
            )}

            {/* What kind of notice this is, front and centre — the
                        first thing an operator triages a notice by. The
                        extracted value is free text; the label maps
                        humanize the catalogue values and anything else
                        falls back to plain humanization. */}
            {selected.kind === "notice" && selected.noticeExtraction && (
              <div
                className="rounded-lg border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30"
                data-testid="card-notice-type"
              >
                <p className="text-xs font-semibold text-muted-foreground">
                  Tax authority notice
                </p>
                <p
                  className="mt-1 text-lg font-semibold"
                  data-testid="text-notice-type"
                >
                  {noticeTypeLabel(selected.noticeExtraction.noticeType)}
                </p>
              </div>
            )}

            {selected.status === "failed" && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Reading failed</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    {selected.failReason ??
                      "The Clerk could not read this document. Enter the invoice manually."}
                  </p>
                  {/* Retry re-runs extraction on the stored source —
                              only failed extraction cases qualify (the server
                              409s anything else). */}
                  {selected.kind === "extraction" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => retryCase.mutate({ id: selected.id })}
                      disabled={retryCase.isPending}
                      data-testid="button-retry-case"
                    >
                      {retryCase.isPending ? "Retrying…" : "Retry"}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {selected.status === "escalated" && (
              <Alert>
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Escalated</AlertTitle>
                <AlertDescription>
                  {selected.decisionReason ??
                    "This case needs a human decision outside the Clerk."}
                </AlertDescription>
              </Alert>
            )}

            {/* Deterministic pre-approval checks, computed by the
                        server on every successful extraction. null means the
                        extraction never succeeded (or predates pre-flight) —
                        render nothing rather than a false all-clear. */}
            {(selected.status === "extracted" ||
              selected.status === "in_review") &&
              selected.preflight != null &&
              (selected.preflight.length === 0 ? (
                <p
                  className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"
                  data-testid="preflight-clear"
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  Pre-flight clear — nothing blocking approval
                </p>
              ) : (
                <div
                  className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
                  data-testid="preflight-issues"
                >
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    Pre-flight —{" "}
                    {selected.preflight.length === 1
                      ? "1 issue"
                      : `${selected.preflight.length} issues`}{" "}
                    to resolve before approval
                  </p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
                    {selected.preflight.map((issue, i) => (
                      <li key={`${issue.field}-${i}`}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              ))}

            {detailExtraction && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5 flex items-center gap-2">
                  Extracted fields — amber rows need checking
                  {selected.extraction?.exemplarCaseId && (
                    /* Provenance is navigable: selecting the exemplar
                               id drives the same by-id case fetch the queue
                               uses, so it opens even when that case has
                               scrolled off the loaded pages. */
                    <button
                      type="button"
                      onClick={() => {
                        const id = selected.extraction?.exemplarCaseId;
                        if (id) setSelectedId(id);
                      }}
                      className="normal-case rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-800 transition-colors hover:bg-violet-100 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/70"
                      title="Extraction was guided by a previously approved invoice from the same supplier — open that case"
                      aria-label="Open the exemplar case that guided this extraction"
                      data-testid="badge-exemplar"
                    >
                      supplier memory
                    </button>
                  )}
                </p>
                <div className="divide-y text-sm">
                  {detailExtraction.fields.map((f) => {
                    const preflightHit = preflightFields.has(f.field);
                    const snippetOpen = openSnippets.has(f.field);
                    const hint =
                      selected.kind === "extraction"
                        ? correctionHint(f.field, queueMetrics?.corrections)
                        : null;
                    return (
                      <div key={f.field}>
                        <div
                          className={`flex items-center gap-3 px-1 py-2.5 ${
                            f.flagged || preflightHit
                              ? "bg-amber-50 dark:bg-amber-950/40 rounded-md px-2"
                              : ""
                          }${
                            preflightHit
                              ? " border-l-2 border-amber-400 dark:border-amber-600"
                              : ""
                          }`}
                          data-testid={`row-field-${f.field}`}
                        >
                          <span className="w-36 shrink-0 text-muted-foreground">
                            {detailFieldLabel(f.field)}
                          </span>
                          <span className="flex-1 truncate text-right font-semibold">
                            {f.value ?? (
                              <em className="text-muted-foreground font-normal">
                                missing
                              </em>
                            )}
                          </span>
                          {f.critical && (
                            <span className="text-[10px] uppercase text-muted-foreground">
                              critical
                            </span>
                          )}
                          {hint && (
                            <span
                              className="shrink-0 text-[10px] text-amber-700 dark:text-amber-400"
                              title="From the corrections exhaust across recent approved cases"
                              data-testid={`hint-${f.field}`}
                            >
                              {hint}
                            </span>
                          )}
                          <ConfidenceBadge confidence={f.confidence} />
                          {f.sourceSnippet != null && (
                            <button
                              type="button"
                              onClick={() => toggleSnippet(f.field)}
                              aria-label="Show source text"
                              aria-expanded={snippetOpen}
                              className={`shrink-0 rounded p-0.5 transition-colors hover:text-foreground ${
                                snippetOpen
                                  ? "text-foreground"
                                  : "text-muted-foreground"
                              }`}
                              data-testid={`snippet-toggle-${f.field}`}
                            >
                              <Quote
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        </div>
                        {snippetOpen && f.sourceSnippet != null && (
                          <blockquote
                            className="mx-1 mb-2 border-l-2 border-teal-300 pl-3 text-xs italic text-muted-foreground dark:border-teal-800"
                            data-testid={`snippet-${f.field}`}
                          >
                            “{truncateSnippet(f.sourceSnippet)}”
                          </blockquote>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selected.status === "approved" && selected.createdInvoiceId && (
              <Alert data-testid="banner-draft-created">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Draft invoice created</AlertTitle>
                <AlertDescription>
                  The invoice was created as a DRAFT. It has not been submitted
                  — it follows the normal human submission flow.
                </AlertDescription>
              </Alert>
            )}

            {/* A notice approval's success state: the obligation the
                        server just recorded, deadline front and centre. */}
            {selected.kind === "notice" && noticeObligation && (
              <Alert data-testid="banner-obligation-created">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Obligation recorded</AlertTitle>
                <AlertDescription>
                  Obligation recorded — response due{" "}
                  {noticeObligation.responseDueDate}. Track and update it from
                  the client&apos;s page.
                </AlertDescription>
              </Alert>
            )}
            {/* A notice case approved before this visit: the
                        obligation itself lives on the client's page. */}
            {selected.kind === "notice" &&
              selected.status === "approved" &&
              !noticeObligation && (
                <Alert data-testid="banner-obligation-exists">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  <AlertTitle>Notice approved</AlertTitle>
                  <AlertDescription>
                    An open response obligation was recorded for this notice —
                    track it on the client&apos;s page.
                  </AlertDescription>
                </Alert>
              )}

            {form && (
              <InvoiceDecisionForm
                form={form}
                setForm={setForm}
                reason={reason}
                setReason={setReason}
                firms={firms}
                parties={parties}
                partySuggestions={partySuggestions}
                claimControls={claimControls}
                caseId={selected.id}
                decideCase={decideCase}
                approveDisabled={approveDisabled}
                linesPreflightHit={linesPreflightHit}
              />
            )}

            {noticeForm && (
              <NoticeDecisionForm
                noticeForm={noticeForm}
                setNoticeForm={setNoticeForm}
                reason={reason}
                setReason={setReason}
                firms={firms}
                parties={parties}
                claimControls={claimControls}
                caseId={selected.id}
                decideNotice={decideNotice}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
