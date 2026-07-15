import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useCreateClerkCase,
  useCreateClerkCaseBatch,
  useGetClerkCase,
  useGetClerkUsage,
  useListClerkCases,
  getGetClerkCaseQueryKey,
  getGetClerkUsageQueryKey,
  getListClerkCasesQueryKey,
} from "@workspace/api-client-react";
import type {
  BatchClerkCasesResult,
  ClerkCase,
  ClerkCaseCreateInput,
  ListClerkCasesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CapabilityGate } from "@/components/capability-gate";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import {
  batchSummary,
  captureBadgeClasses,
  captureStatusLabel,
  fieldLabel,
  fileToBase64,
  handleClerkGatewayError,
  MAX_VOICE_BYTES,
  usagePct,
} from "@/lib/clerk";
import { ClerkDisabledBanner } from "@/components/clerk-disabled-banner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCheck2,
  Sparkles,
} from "lucide-react";

// Clerk is capture-only for clients: they submit a document, voice note, or
// pasted text and watch the status. Every approval happens on the operator
// side — an approved case links the DRAFT invoice it created, nothing more.

// Small allowance meter for the page header. The endpoint 400s for
// principals without a firm allowance, and the meter is a nicety — any error
// (or a still-loading query) simply renders nothing.
function UsageMeter() {
  const { data: usage, isError } = useGetClerkUsage();
  if (isError || !usage) return null;
  const pct = usagePct(usage.usedTokens, usage.budgetTokens);
  return (
    <div className="w-48" data-testid="meter-clerk-usage">
      <p className="text-xs text-muted-foreground text-right">
        Clerk allowance: {pct}% used this month
      </p>
      <div
        className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Clerk allowance used this month"
      >
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 90
              ? "bg-destructive"
              : pct >= 75
                ? "bg-amber-500"
                : "bg-primary"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// Read-only detail for the expanded submission row: what Clerk extracted,
// why a read failed, and — once approved — the draft-invoice hand-off note.
function CaseDetail({ caseId }: { caseId: string }) {
  const { data: kase, isLoading, isError, refetch } = useGetClerkCase(caseId, {
    query: { queryKey: getGetClerkCaseQueryKey(caseId) },
  });

  if (isLoading) {
    return <Skeleton className="h-24" data-testid="skeleton-case-detail" />;
  }
  if (isError || !kase) {
    return <QueryError thing="this submission" onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-3 border-t pt-3" data-testid={`detail-case-${kase.id}`}>
      {kase.status === "failed" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Clerk could not read this</AlertTitle>
          <AlertDescription>
            {kase.failReason ??
              "The document was unreadable. Try a clearer photo or paste the text instead."}
          </AlertDescription>
        </Alert>
      )}

      {kase.status === "approved" && (
        <Alert data-testid="banner-draft-created">
          <FileCheck2 className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Draft invoice created</AlertTitle>
          <AlertDescription>
            Draft invoice created — your accountant will take it from here.
            {kase.createdInvoiceId && (
              <>
                {" "}
                <Link
                  href={`/invoices/${kase.createdInvoiceId}`}
                  className="text-primary hover:underline font-medium"
                  data-testid="link-created-invoice"
                >
                  View the draft
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {kase.status === "rejected" && kase.decisionReason && (
        <p className="text-sm text-muted-foreground">
          Reason: {kase.decisionReason}
        </p>
      )}

      {kase.status === "pending" && (
        <p className="text-sm text-muted-foreground">
          Clerk is reading your submission — check back in a moment.
        </p>
      )}

      {(kase.status === "extracted" || kase.status === "in_review") && (
        <p className="text-sm text-muted-foreground">
          Your accountant reviews everything below before anything is created.
        </p>
      )}

      {kase.extraction && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5">
            What Clerk read
          </p>
          <div className="divide-y text-sm">
            {kase.extraction.fields.map((f) => (
              <div
                key={f.field}
                className="flex items-center gap-3 px-1 py-2"
                data-testid={`row-field-${f.field}`}
              >
                <span className="w-36 shrink-0 text-muted-foreground">
                  {fieldLabel(f.field)}
                </span>
                <span className="flex-1 truncate text-right font-medium">
                  {f.value ?? (
                    <em className="text-muted-foreground font-normal">
                      missing
                    </em>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CaptureContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [captureText, setCaptureText] = useState("");
  const [captureFile, setCaptureFile] = useState<File | null>(null);
  const [captureVoice, setCaptureVoice] = useState<File | null>(null);
  const [disabledBanner, setDisabledBanner] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Duplicate guard: a 409 DUPLICATE_SOURCE on create means this exact
  // content already has a live case. Hold the rejected payload verbatim so
  // "Create anyway" resubmits it byte-identical with allowDuplicate: true.
  // Cleared on success, on cancel, and whenever any source input changes.
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    payload: ClerkCaseCreateInput;
    message: string;
  } | null>(null);
  // Batch intake: "This contains multiple invoices" routes the same text/PDF
  // through the batch endpoint, which segments the document and opens one
  // case per invoice. The result summary sticks inline (unlike the toasts)
  // until any source input changes.
  const [batchMode, setBatchMode] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchClerkCasesResult | null>(
    null,
  );

  // The server scopes this list to the caller (a client_user sees only their
  // own submissions), so no client-side ownership filter is needed.
  const caseParams: ListClerkCasesParams = { kind: "extraction" };
  const {
    data: cases,
    isLoading,
    isError,
    refetch,
  } = useListClerkCases(caseParams, {
    query: { queryKey: getListClerkCasesQueryKey(caseParams) },
  });

  const sortedCases = useMemo(
    () =>
      [...(cases ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [cases],
  );

  const handleClerkError = (err: unknown) =>
    handleClerkGatewayError(err, {
      onDisabled: () => setDisabledBanner(true),
      toast,
      fallbackTitle: "Clerk couldn't take that",
    });

  const createCase = useCreateClerkCase({
    mutation: {
      onSuccess: (kase: ClerkCase) => {
        queryClient.invalidateQueries({
          queryKey: getListClerkCasesQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getGetClerkUsageQueryKey() });
        setSelectedId(kase.id);
        setCaptureText("");
        setCaptureFile(null);
        setCaptureVoice(null);
        setPendingDuplicate(null);
        setDisabledBanner(false);
        toast({
          title:
            kase.status === "failed" ? "Clerk couldn't read that" : "Sent to Clerk",
          description:
            kase.status === "failed"
              ? kase.failReason ??
                "Try a clearer photo, or paste the invoice text instead."
              : "Your accountant will review it before anything is created.",
        });
      },
      onError: (e, variables) => {
        // 409 DUPLICATE_SOURCE: no toast — an inline panel offers "Create
        // anyway" (allowDuplicate: true) or backing out.
        if (errorStatus(e) === 409) {
          setPendingDuplicate({
            payload: variables.data,
            message:
              serverErrorMessage(e) ??
              "You've already sent this exact document to Clerk.",
          });
          return;
        }
        handleClerkError(e);
      },
    },
  });

  const createBatch = useCreateClerkCaseBatch({
    mutation: {
      onSuccess: (result: BatchClerkCasesResult) => {
        queryClient.invalidateQueries({
          queryKey: getListClerkCasesQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getGetClerkUsageQueryKey() });
        setBatchResult(result);
        setCaptureText("");
        setCaptureFile(null);
        setPendingDuplicate(null);
        setDisabledBanner(false);
      },
      onError: (e) => {
        // 502 BATCH_SEGMENTATION_FAILED: Clerk couldn't split the bundle —
        // point at the single-invoice path instead of relaying the raw error.
        if (errorStatus(e) === 502) {
          toast({
            title: "Clerk couldn't split that document",
            description:
              "Try uploading the invoices one at a time — each becomes its own submission.",
            variant: "destructive",
          });
          return;
        }
        handleClerkError(e);
      },
    },
  });

  const isPdfFile =
    captureFile != null &&
    (captureFile.type === "application/pdf" ||
      captureFile.name.toLowerCase().endsWith(".pdf"));
  // The batch splitter only takes text it can segment (pasted text or a
  // PDF's text layer), so the toggle hides for photo and voice sources.
  const batchEligible = captureVoice == null && (captureFile == null || isPdfFile);

  const submitCapture = async () => {
    setBatchResult(null);
    if (batchMode && batchEligible && (captureFile || captureText.trim())) {
      if (captureFile) {
        const b64 = await fileToBase64(captureFile);
        createBatch.mutate({
          data: { sourceType: "pdf", name: captureFile.name, pdfBase64: b64 },
        });
      } else {
        createBatch.mutate({
          data: {
            sourceType: "text",
            name: "pasted-text.txt",
            text: captureText,
          },
        });
      }
      return;
    }
    if (captureVoice) {
      const b64 = await fileToBase64(captureVoice);
      createCase.mutate({
        data: {
          sourceType: "voice",
          audioBase64: b64,
          name: captureVoice.name,
        },
      });
    } else if (captureFile) {
      const b64 = await fileToBase64(captureFile);
      createCase.mutate({
        data: {
          sourceType: isPdfFile ? "pdf" : "image",
          name: captureFile.name,
          contentType: captureFile.type || undefined,
          ...(isPdfFile ? { pdfBase64: b64 } : { imageBase64: b64 }),
        },
      });
    } else if (captureText.trim()) {
      createCase.mutate({
        data: {
          sourceType: "text",
          name: "pasted-text.txt",
          text: captureText,
        },
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Send to Clerk"
        description="Snap or upload an invoice — Clerk reads it and your accountant reviews it before anything is created."
      >
        <UsageMeter />
      </PageHeader>

      {disabledBanner && (
        <ClerkDisabledBanner>
          Please try again later, or{" "}
          <Link href="/invoices/new" className="underline">
            enter the invoice manually
          </Link>
          .
        </ClerkDisabledBanner>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
            New submission
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="capture-file">Invoice document (PDF or photo)</Label>
            <Input
              id="capture-file"
              type="file"
              accept=".pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => {
                setCaptureFile(e.target.files?.[0] ?? null);
                setPendingDuplicate(null);
                setBatchResult(null);
              }}
              disabled={captureVoice != null}
              data-testid="input-capture-file"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capture-voice">or a voice note (max 5 MB)</Label>
            <Input
              id="capture-voice"
              type="file"
              accept="audio/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setPendingDuplicate(null);
                setBatchResult(null);
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
              disabled={captureFile != null}
              data-testid="input-voice-file"
            />
            <p className="text-xs text-muted-foreground">
              English voice notes; the audio is transcribed and only the
              transcript is kept.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capture-text">or paste the invoice text</Label>
            <Textarea
              id="capture-text"
              value={captureText}
              onChange={(e) => {
                setCaptureText(e.target.value);
                setPendingDuplicate(null);
                setBatchResult(null);
              }}
              placeholder="INVOICE No: ..."
              rows={5}
              disabled={captureFile != null || captureVoice != null}
              data-testid="input-capture-text"
            />
          </div>
          {batchEligible && (
            <div className="flex items-center gap-2">
              <input
                id="batch-toggle"
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={batchMode}
                onChange={(e) => {
                  setBatchMode(e.target.checked);
                  setBatchResult(null);
                }}
                data-testid="batch-toggle"
              />
              <Label htmlFor="batch-toggle" className="font-normal">
                This contains multiple invoices
              </Label>
            </div>
          )}
          <Button
            className="w-full sm:w-auto"
            onClick={submitCapture}
            disabled={
              createCase.isPending ||
              createBatch.isPending ||
              (!captureFile && !captureVoice && captureText.trim().length < 10)
            }
            data-testid="button-send-to-clerk"
          >
            {createCase.isPending || createBatch.isPending
              ? captureVoice
                ? "Transcribing…"
                : "Reading…"
              : "Send to Clerk"}
          </Button>
          {batchResult && (
            <Alert data-testid="batch-result">
              <FileCheck2 className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Sent to Clerk</AlertTitle>
              <AlertDescription>
                {batchSummary(
                  batchResult.cases.length,
                  batchResult.skippedDuplicates,
                )}
                {batchResult.cases.length > 0 &&
                  " — your accountant will review each one before anything is created."}
              </AlertDescription>
            </Alert>
          )}
          {pendingDuplicate && (
            <Alert data-testid="banner-duplicate-source">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Already sent this one?</AlertTitle>
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
                    {createCase.isPending ? "Sending…" : "Create anyway"}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My submissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : isError ? (
            <QueryError thing="your submissions" onRetry={() => refetch()} />
          ) : sortedCases.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Nothing sent yet"
              description="Your submissions and their review status will show up here."
              className="py-8"
            />
          ) : (
            sortedCases.map((c) => {
              const expanded = selectedId === c.id;
              return (
                <div
                  key={c.id}
                  className={`rounded-xl border transition-colors ${
                    expanded ? "border-primary/50 bg-muted/30" : "border-border"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(expanded ? null : c.id)}
                    aria-expanded={expanded}
                    className="w-full flex items-center justify-between gap-3 p-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
    </div>
  );
}

export function ClerkCapture() {
  usePageTitle("Send to Clerk");
  return (
    <CapabilityGate capability="clerk.capture">
      <CaptureContent />
    </CapabilityGate>
  );
}
