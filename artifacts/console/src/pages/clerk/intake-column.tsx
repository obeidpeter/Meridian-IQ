import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/empty-state";
import { formatDateTime } from "@/lib/format";
import {
  caseIntakeKind,
  fileIsPdf,
  isReadyToApprove,
} from "@/pages/clerk-shared";
import {
  MAX_RECORD_SECONDS,
  MAX_VOICE_BYTES,
} from "@/pages/use-voice-recorder";
import {
  AlertTriangle,
  Inbox,
  Mic,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import { OPEN_STATUSES, QUEUE_STATUS } from "./constants";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The left column (R120): new intake capture, batch mode, the queue filters
// and the paged case list. Renders the workspace state it is handed.
export function IntakeColumn({ state }: { state: ClerkWorkspaceState }) {
  const {
    toast,
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
    captureText,
    setCaptureText,
    captureFile,
    setCaptureFile,
    captureVoice,
    setCaptureVoice,
    batchMode,
    setBatchMode,
    batchResult,
    pendingDuplicate,
    setPendingDuplicate,
    createCase,
    createCaseBatch,
    voiceFromRecorder,
    setVoiceFromRecorder,
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
    noticeCapture,
    submitCapture,
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
        {captureOpen && (
          <div className="border rounded-md p-3 space-y-2">
            <Label htmlFor="capture-file">
              {noticeCapture
                ? "Notice document (PDF or photo)"
                : "Invoice document (PDF or photo)"}
            </Label>
            <Input
              id="capture-file"
              type="file"
              accept=".pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => {
                setCaptureFile(e.target.files?.[0] ?? null);
                setPendingDuplicate(null);
              }}
              disabled={captureVoice != null}
              data-testid="input-capture-file"
            />
            {!noticeCapture && (
              <>
                <Label htmlFor="capture-voice">
                  or a voice note (max 5 MB)
                </Label>
                <Input
                  id="capture-voice"
                  type="file"
                  accept="audio/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setPendingDuplicate(null);
                    setVoiceFromRecorder(false);
                    if (f && f.size > MAX_VOICE_BYTES) {
                      toast({
                        title: "Voice note too large",
                        description: `Voice notes are capped at 5 MB; this file is ${(
                          f.size /
                          (1024 * 1024)
                        ).toFixed(1)} MB. Record a shorter note.`,
                        variant: "destructive",
                      });
                      e.target.value = "";
                      setCaptureVoice(null);
                      return;
                    }
                    setCaptureVoice(f);
                  }}
                  disabled={captureFile != null || isRecording}
                  data-testid="input-voice-file"
                />
                {recordingSupported && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      size="sm"
                      variant={isRecording ? "destructive" : "secondary"}
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={
                        createCase.isPending ||
                        (!isRecording && captureFile != null)
                      }
                      data-testid="button-record-voice"
                    >
                      <Mic className="w-4 h-4 mr-1" aria-hidden="true" />
                      {isRecording ? "Stop recording" : "Record voice note"}
                    </Button>
                    <span
                      className="text-xs text-muted-foreground tabular-nums"
                      aria-live="polite"
                      data-testid="text-record-elapsed"
                    >
                      {isRecording
                        ? `Recording… ${recordSeconds}s (stops at ${MAX_RECORD_SECONDS}s)`
                        : voiceFromRecorder && captureVoice != null
                          ? "Recorded note ready — recording.webm"
                          : ""}
                    </span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  English voice notes; the audio is transcribed and only the
                  transcript is kept.
                </p>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {noticeCapture
                ? "or paste the notice text:"
                : "or paste the invoice text:"}
            </p>
            <Textarea
              aria-label={noticeCapture ? "Notice text" : "Invoice text"}
              value={captureText}
              onChange={(e) => {
                setCaptureText(e.target.value);
                setPendingDuplicate(null);
              }}
              placeholder="INVOICE No: ..."
              rows={5}
              disabled={captureFile != null || captureVoice != null}
              data-testid="input-capture-text"
            />
            {/* Batch splitting works on PDFs and pasted text only —
                        the checkbox greys out for images and voice notes,
                        and never shows for notice captures (a notice is one
                        document, not an invoice bundle). */}
            {!noticeCapture && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="batch-toggle"
                  checked={batchMode}
                  onCheckedChange={(v) => setBatchMode(v === true)}
                  disabled={
                    captureVoice != null ||
                    (captureFile != null && !fileIsPdf(captureFile))
                  }
                  data-testid="batch-toggle"
                />
                <Label htmlFor="batch-toggle" className="text-sm font-normal">
                  This upload contains multiple invoices
                </Label>
              </div>
            )}
            <Button
              className="w-full"
              onClick={submitCapture}
              disabled={
                createCase.isPending ||
                createCaseBatch.isPending ||
                (!captureFile &&
                  !captureVoice &&
                  captureText.trim().length < 10)
              }
              data-testid="button-run-capture"
            >
              {createCaseBatch.isPending
                ? "Splitting…"
                : createCase.isPending
                  ? captureVoice
                    ? "Transcribing…"
                    : "Reading…"
                  : "Read with Clerk"}
            </Button>
            {pendingDuplicate && (
              <Alert data-testid="banner-duplicate-source">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Already read this one?</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{pendingDuplicate.message}</p>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      onClick={() =>
                        createCase.mutate({
                          data: {
                            ...pendingDuplicate.payload,
                            allowDuplicate: true,
                          },
                        })
                      }
                      disabled={createCase.isPending}
                      data-testid="button-create-anyway"
                    >
                      {createCase.isPending ? "Reading…" : "Create anyway"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setPendingDuplicate(null)}
                      data-testid="button-cancel-duplicate"
                    >
                      Cancel
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
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
          // First-run empty state: show the ways in — a single
          // capture, or (invoices only) a multi-invoice bundle
          // (same form, batch pre-ticked). Both only OPEN the form;
          // reading still takes the operator's click.
          <EmptyState
            icon={Inbox}
            title={
              queueKind === "notice"
                ? queueSearch
                  ? "No matching notices"
                  : "No notices read yet"
                : queueSearch
                  ? "No matching documents"
                  : "No documents read yet"
            }
            description={
              queueKind === "notice"
                ? queueSearch
                  ? "Try a source name, reference, status or case ID."
                  : "Capture a tax-authority notice — a photo, scan or pasted text — Clerk reads it and queues it here for your review."
                : queueSearch
                  ? "Try a source name, invoice number, status or case ID."
                  : "Capture an invoice document, voice note or pasted text — Clerk reads it and queues it here for your review."
            }
            className="py-8 px-2"
          >
            <div className="flex flex-wrap justify-center gap-2 mt-1">
              <Button
                size="sm"
                onClick={() => setCaptureOpen(true)}
                data-testid="button-empty-capture"
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                {queueKind === "notice"
                  ? "Capture your first notice"
                  : "Capture your first document"}
              </Button>
              {queueKind === "extraction" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCaptureOpen(true);
                    setBatchMode(true);
                  }}
                  data-testid="button-empty-import-batch"
                >
                  Import a multi-invoice bundle
                </Button>
              )}
            </div>
          </EmptyState>
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
