import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { pillClasses } from "@/lib/format";
import {
  caseIntakeKind,
  correctionHint,
  STATUS_TONE,
} from "@/pages/clerk-shared";
import { Quote, ShieldCheck } from "lucide-react";
import { InvoiceDecisionForm } from "./invoice-decision-form";
import { ConfidenceBadge } from "./confidence-badge";
import { NoticeDecisionForm } from "./notice-decision-form";
import { CaseSourcePanels } from "./case-source-panels";
import { CaseStatusBanners } from "./case-status-banners";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";
import { fieldsNeedingReview } from "./review-derivations";
import { ReviewNavigation } from "./review-navigation";

// The right column (R120): the selected case with its source text, image and
// pages, the extraction or notice decision form, claim controls and the
// retry path. Renders the workspace state it is handed.
export function CaseDetail({ state }: { state: ClerkWorkspaceState }) {
  const {
    setSelectedId,
    selected,
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
  const reviewFields = selected
    ? fieldsNeedingReview(selected, form, noticeForm)
    : [];
  return (
    <section className="min-w-0 self-start space-y-4" aria-label="Case review">
      <header>
        {selected ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted-foreground">
                {caseIntakeKind(selected).eyebrow}
              </p>
              <h2 className="text-xl font-semibold mt-1 [overflow-wrap:anywhere]">
                {selected.sourceName ?? "Case detail"}
              </h2>
            </div>
            <span
              className={pillClasses(STATUS_TONE[selected.status] ?? "slate")}
            >
              {selected.status.replace("_", " ")}
            </span>
          </div>
        ) : (
          <h2 className="text-base font-semibold">Case detail</h2>
        )}
      </header>
      <div>
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            Select a case to view its details, or read a new document.
          </p>
        ) : (
          <div
            className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]"
            data-testid="clerk-review-layout"
          >
            <section
              aria-label="Source document"
              className="min-w-0 space-y-4 lg:sticky lg:top-24"
            >
              <CaseSourcePanels selected={selected} state={state} />
              {detailExtraction && (
                <p className="text-xs text-muted-foreground">
                  read by {detailExtraction.model} (
                  {detailExtraction.promptVersion})
                </p>
              )}
            </section>

            <ReviewNavigation
              key={`${selected.id}-${selected.status}`}
              kind={selected.kind}
              fields={reviewFields}
              onReviewField={(field) =>
                state.setOpenSnippets((open) => new Set(open).add(field))
              }
            >
              <CaseStatusBanners selected={selected} retryCase={retryCase} />

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
                            tabIndex={-1}
                            role="group"
                            data-review-field={f.field}
                            aria-label={`${detailFieldLabel(f.field)}: ${f.value ?? "missing"}`}
                            className={`flex flex-wrap items-center gap-2 px-1 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring ${
                              reviewFields.includes(f.field) ||
                              f.flagged ||
                              preflightHit
                                ? "bg-amber-50 dark:bg-amber-950/40 rounded-md px-2"
                                : ""
                            }${
                              preflightHit
                                ? " border-l-2 border-amber-400 dark:border-amber-600"
                                : ""
                            }`}
                            data-testid={`row-field-${f.field}`}
                          >
                            <span className="basis-full text-muted-foreground">
                              {detailFieldLabel(f.field)}
                            </span>
                            <span className="min-w-0 flex-1 font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {f.value?.trim() ? (
                                f.value
                              ) : (
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
                                title="Based on corrections made in recently approved cases"
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
                                aria-label={`Show source text for ${detailFieldLabel(f.field)}`}
                                aria-expanded={snippetOpen}
                                className={`flex h-11 w-11 items-center justify-center shrink-0 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground ${
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
                              className="mx-1 mb-2 border-l-2 border-teal-300 pl-3 text-sm italic text-muted-foreground [overflow-wrap:anywhere] dark:border-teal-800"
                              data-testid={`snippet-${f.field}`}
                            >
                              “{f.sourceSnippet}”
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
                    The invoice was created as a DRAFT. It has not been
                    submitted — it follows the normal human submission flow.
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
            </ReviewNavigation>
          </div>
        )}
      </div>
    </section>
  );
}
