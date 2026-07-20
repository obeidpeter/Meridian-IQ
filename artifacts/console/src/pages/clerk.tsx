import { useEffect, useMemo, useState } from "react";
import {
  useListClerkCases,
  useListClerkBatches,
  useGetClerkCase,
  useCreateClerkCase,
  useCreateClerkCaseBatch,
  useDecideClerkCase,
  useBulkApproveClerkCases,
  useClaimClerkCase,
  useReleaseClerkCase,
  useRetryClerkCase,
  useGetClerkPartySuggestions,
  getClerkPartySuggestions,
  useGetClerkMetrics,
  useGetMe,
  useListFeatureFlags,
  useListFirms,
  useListParties,
  getListClerkCasesQueryKey,
  getListClerkBatchesQueryKey,
  getGetClerkCaseQueryKey,
  getGetClerkMetricsQueryKey,
  getGetClerkPartySuggestionsQueryKey,
} from "@workspace/api-client-react";
import type {
  BatchClerkCasesResult,
  ClerkBulkApproveReport,
  ClerkCase,
  ClerkCaseCreateInput,
  ClerkCaseDecisionInputCategory,
  ClerkPartySuggestions,
  InvoiceLineInput,
  ListClerkCasesParams,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { ClerkDisabledBanner, ClerkPageHeader } from "@/components/clerk-shell";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  errorStatus,
  killSwitchTripped,
  serverErrorMessage,
} from "@/lib/errors";
import { formatDateTime, pillClasses } from "@/lib/format";
import { PartySuggestionChips } from "@/pages/clerk-party-suggestions";
import type { ApproveForm } from "@/pages/clerk-shared";
import {
  approveDecisionFromForm,
  approveFormFromCase,
  bulkApproveFormFromCase,
  bulkApproveSummary,
  bulkDialogPhase,
  clerkDisabledToast,
  correctionHint,
  fastLaneCaseSummary,
  fieldLabel,
  fieldWeights,
  fileIsPdf,
  fileToBase64,
  groupQueueByBatch,
  intakeKind,
  isReadyToApprove,
  relativeTime,
  reviewEffort,
  serverErrorToast,
  shortActor,
  STATUS_TONE,
  truncateSnippet,
  vatPercentInvalid,
  voiceDuration,
} from "@/pages/clerk-shared";
import {
  MAX_RECORD_SECONDS,
  MAX_VOICE_BYTES,
  useVoiceRecorder,
} from "@/pages/use-voice-recorder";
import {
  AlertTriangle,
  Inbox,
  Mic,
  Plus,
  PowerOff,
  Quote,
  ShieldCheck,
} from "lucide-react";

// Clerk v0 is a shadow copilot for operators only. It reads documents and
// answers register questions, but it NEVER submits anything: an approval here
// creates a DRAFT invoice that still walks the normal human submission path.
// If the clerk_ai kill switch is off, the server answers 503 and this page
// says so instead of pretending.

const CATEGORIES: ClerkCaseDecisionInputCategory[] = ["b2b", "b2g", "b2c"];

// The case queue loads in pages: with limit/offset present the server
// returns a bounded, newest-first slice instead of the full legacy list. A
// full page means there may be more — "Load more" appends the next one.
const PAGE_SIZE = 50;

// The bulk-approve endpoint accepts at most 50 items per request (the
// contract's maxItems), so the fast-lane action sends at most one batch of
// the best-ranked ready cases.
const BULK_APPROVE_MAX = 50;

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.9 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400 font-medium";
  return <span className={`text-xs tabular-nums ${tone}`}>{pct}%</span>;
}

// The queue's one-word status line under each intake title.
const QUEUE_STATUS: Record<ClerkCase["status"], { label: string; cls: string }> = {
  pending: { label: "Reading…", cls: "text-muted-foreground" },
  extracted: { label: "Extracted", cls: "text-primary" },
  in_review: { label: "Review", cls: "text-primary" },
  approved: { label: "Approved", cls: "text-muted-foreground" },
  rejected: { label: "Rejected", cls: "text-muted-foreground" },
  escalated: { label: "Escalated", cls: "text-amber-700 dark:text-amber-400" },
  failed: { label: "Needs input", cls: "text-destructive" },
};

const OPEN_STATUSES = new Set<ClerkCase["status"]>([
  "pending",
  "extracted",
  "in_review",
]);

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function ClerkWorkspace() {
  usePageTitle("Clerk");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  // Greeting + guardrails signal for the page header. The clerk_ai flag drives
  // the pill: enabled means the human-review guardrails are governing live AI
  // calls; disabled means the kill switch has Clerk fully off. Operators hold
  // flags.read; if the flags query fails the pill simply doesn't render.
  const { data: me } = useGetMe();
  const { data: flags } = useListFeatureFlags();
  const clerkFlag = flags?.find((f) => f.key === "clerk_ai");
  const firstName = me?.fullName?.split(" ")[0];

  // Paged case queue. The Capture tab only ever shows extraction cases, so
  // that kind filter now travels to the server with the page bounds (any
  // filter change would restart from the first page — offset only ever grows
  // within one filter set). Only the page at `offset` is a live query;
  // earlier pages are kept in local state and re-appended below.
  const [offset, setOffset] = useState(0);
  const [earlierCases, setEarlierCases] = useState<ClerkCase[]>([]);
  const caseParams: ListClerkCasesParams = {
    kind: "extraction",
    limit: PAGE_SIZE,
    offset,
  };
  const {
    data: casePage,
    isLoading,
    error,
    refetch,
  } = useListClerkCases(caseParams, {
    query: { queryKey: getListClerkCasesQueryKey(caseParams) },
  });

  // The queue shifts while paging (a new capture pushes every row down one
  // slot), so a case can be returned by two page fetches — dedupe by id to
  // keep React keys unique.
  const cases = useMemo(() => {
    const seen = new Set<string>();
    const merged: ClerkCase[] = [];
    for (const c of [...earlierCases, ...(casePage ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
    return merged;
  }, [earlierCases, casePage]);

  // A short page is the end of the queue. When the total is an exact
  // multiple of PAGE_SIZE the last click fetches one empty page — harmless.
  const hasMoreCases = (casePage?.length ?? 0) === PAGE_SIZE;
  const loadingMoreCases = isLoading && offset > 0;
  const loadMoreCases = () => {
    if (!casePage) return;
    setEarlierCases((prev) => [...prev, ...casePage]);
    setOffset((o) => o + PAGE_SIZE);
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: selected } = useGetClerkCase(selectedId ?? "", {
    query: {
      queryKey: getGetClerkCaseQueryKey(selectedId ?? ""),
      enabled: selectedId != null,
    },
  });

  // Capture form
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureFile, setCaptureFile] = useState<File | null>(null);
  const [captureVoice, setCaptureVoice] = useState<File | null>(null);
  // Batch intake: PDF and pasted text can carry several invoices — when the
  // operator says so, the batch endpoint splits the document and opens one
  // case per invoice. The last batch's summary stays visible under the form.
  const [batchMode, setBatchMode] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchClerkCasesResult | null>(
    null,
  );
  // Duplicate guard: a 409 DUPLICATE_SOURCE on create means this exact
  // document content already has a live case. We hold the rejected payload
  // verbatim so "Create anyway" resubmits it byte-identical with
  // allowDuplicate: true. Cleared on success, on cancel, and whenever the
  // operator changes any source input (the held payload would be stale).
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    payload: ClerkCaseCreateInput;
    message: string;
  } | null>(null);

  // Decision form
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [reason, setReason] = useState("");
  // Which field rows have their source snippet expanded — per-case, collapsed
  // by default.
  const [openSnippets, setOpenSnippets] = useState<Set<string>>(new Set());
  const toggleSnippet = (field: string) =>
    setOpenSnippets((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  useEffect(() => {
    if (selected && (selected.status === "extracted" || selected.status === "in_review")) {
      setForm(approveFormFromCase(selected));
    } else {
      setForm(null);
    }
    setReason("");
    setOpenSnippets(new Set());
    // Reset only when the case identity or status changes: a react-query
    // refetch delivers a fresh `selected` reference with the same id/status
    // mid-edit, and depending on the object would clobber operator input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  const { data: firms } = useListFirms();
  const { data: parties } = useListParties();

  // Party-matching suggestions for the open approval form, fetched only
  // while the form is open for an extraction case. A failed fetch is silent:
  // suggestions are a convenience, the plain dropdowns keep working.
  const suggestionsCaseId =
    form != null && selected?.kind === "extraction" ? selected.id : null;
  const { data: partySuggestions } = useGetClerkPartySuggestions(
    suggestionsCaseId ?? "",
    {
      query: {
        queryKey: getGetClerkPartySuggestionsQueryKey(suggestionsCaseId ?? ""),
        enabled: suggestionsCaseId != null,
      },
    },
  );

  // Pre-select the top suggestion for any party slot the operator has not
  // picked yet. Only empty slots are ever filled — an operator's choice is
  // never overwritten, and the selects stay fully open to any other party.
  useEffect(() => {
    if (!partySuggestions) return;
    setForm((f) => {
      if (!f) return f;
      const supplierPartyId =
        f.supplierPartyId || (partySuggestions.supplier[0]?.partyId ?? "");
      const buyerPartyId =
        f.buyerPartyId || (partySuggestions.buyer[0]?.partyId ?? "");
      if (
        supplierPartyId === f.supplierPartyId &&
        buyerPartyId === f.buyerPartyId
      ) {
        return f;
      }
      return { ...f, supplierPartyId, buyerPartyId };
    });
  }, [partySuggestions, form]);

  const handleGatewayError = (err: unknown, fallback: string) => {
    if (killSwitchTripped(err)) {
      setDisabledBanner(true);
      clerkDisabledToast(
        toast,
        "The clerk_ai kill switch is disabled, so no AI calls are being made.",
      );
      return;
    }
    // Relay the server's own words when it sent any — typed rejections
    // (VOICE_UNREADABLE / VOICE_NO_SPEECH 422s, CASE_CLAIMED /
    // CASE_CLAIM_CONFLICT 409s) carry an actionable message.
    serverErrorToast(toast, err, fallback);
  };

  const invalidateCases = () => {
    // Reset paging before invalidating: fresh data trumps scroll position.
    // Only the first page stays mounted, so the refetch starts from the top
    // of the queue instead of stitching stale appended pages onto new data.
    setEarlierCases([]);
    setOffset(0);
    // getListClerkCasesQueryKey({}) prefix-matches every paged/filtered
    // variant of the list, so all cached pages go stale together.
    queryClient.invalidateQueries({ queryKey: getListClerkCasesQueryKey({}) });
    // The batch group headers count decided cases, so a decision must also
    // refresh the batches list or "reviewed R of C" lags behind the pills.
    queryClient.invalidateQueries({ queryKey: getListClerkBatchesQueryKey() });
    if (selectedId) {
      queryClient.invalidateQueries({
        queryKey: getGetClerkCaseQueryKey(selectedId),
      });
    }
  };

  const createCase = useCreateClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        setSelectedId(kase.id);
        setCaptureOpen(false);
        setCaptureText("");
        setCaptureFile(null);
        setCaptureVoice(null);
        setVoiceFromRecorder(false);
        setPendingDuplicate(null);
        setBatchResult(null);
        setDisabledBanner(false);
        toast({
          title:
            kase.status === "failed"
              ? "Reading failed"
              : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e, variables) => {
        // 409 DUPLICATE_SOURCE: the same content already has a live case.
        // No toast — an inline panel lets the operator create anyway
        // (allowDuplicate: true) or back out.
        if (errorStatus(e) === 409) {
          setPendingDuplicate({
            payload: variables.data,
            message:
              serverErrorMessage(e) ??
              "This exact document already has a live case.",
          });
          return;
        }
        handleGatewayError(e, "Could not read the document.");
      },
    },
  });

  // Batch path: same intake, but the server segments the document and opens
  // one case per invoice (exact-duplicate segments are skipped, not 409'd).
  // 502 SEGMENTATION_FAILED / 429 budget flow through handleGatewayError,
  // which relays the server's own words.
  const createCaseBatch = useCreateClerkCaseBatch({
    mutation: {
      onSuccess: (result) => {
        invalidateCases();
        if (result.cases[0]) setSelectedId(result.cases[0].id);
        setCaptureOpen(false);
        setCaptureText("");
        setCaptureFile(null);
        setBatchMode(false);
        setPendingDuplicate(null);
        setBatchResult(result);
        setDisabledBanner(false);
        toast({
          title: "Batch read",
          description:
            "One case per invoice — every case still needs your review.",
        });
      },
      onError: (e) => handleGatewayError(e, "Could not split the document."),
    },
  });

  const decideCase = useDecideClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.decisionAction === "approve"
              ? "Draft invoice created"
              : `Case ${kase.status}`,
          description:
            kase.decisionAction === "approve"
              ? "The Clerk never submits: the draft goes through the normal review and submission flow."
              : undefined,
        });
      },
      onError: (e) => handleGatewayError(e, "Could not record the decision."),
    },
  });

  // Claiming is optional (a solo operator can decide straight from
  // "extracted") — it just tells other operators someone is on the case. A
  // 409 means someone else won the race, so refetch to show the real claimant.
  const claimCase = useClaimClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case claimed",
          description:
            "You're on it — other operators now see this case as in review.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not claim the case.");
      },
    },
  });

  const releaseCase = useReleaseClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case released",
          description: "The case is back in the queue for any operator.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not release the case.");
      },
    },
  });

  // Retry is only valid for failed extraction cases — the server 409s
  // anything else, and handleGatewayError relays its words.
  const retryCase = useRetryClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.status === "failed" ? "Reading failed again" : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk still could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e) => handleGatewayError(e, "Could not retry the extraction."),
    },
  });

  // True when the current captureVoice came from the in-browser recorder
  // rather than an attached audio file — drives the "Recorded note ready"
  // label next to the record button.
  const [voiceFromRecorder, setVoiceFromRecorder] = useState(false);
  const {
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
  } = useVoiceRecorder({
    // The recorded blob is fed through the SAME captureVoice path as an
    // attached audio file, so submit, duplicate guard and post-success reset
    // all behave identically.
    onRecorded: (file) => {
      setCaptureVoice(file);
      setVoiceFromRecorder(true);
    },
    // Starting a new recording invalidates the held duplicate payload.
    onCleared: () => setPendingDuplicate(null),
  });

  const submitCapture = async () => {
    if (captureVoice) {
      const b64 = await fileToBase64(captureVoice);
      createCase.mutate({
        data: {
          sourceType: "voice",
          audioBase64: b64,
          name: captureVoice.name,
          // Only the in-browser recorder knows the length; attached files
          // carry no reliable duration.
          ...(voiceFromRecorder && recordSeconds > 0
            ? { durationSec: recordSeconds }
            : {}),
        },
      });
    } else if (captureFile) {
      const isPdf = fileIsPdf(captureFile);
      const b64 = await fileToBase64(captureFile);
      if (batchMode && isPdf) {
        createCaseBatch.mutate({
          data: { sourceType: "pdf", name: captureFile.name, pdfBase64: b64 },
        });
        return;
      }
      createCase.mutate({
        data: {
          sourceType: isPdf ? "pdf" : "image",
          name: captureFile.name,
          contentType: captureFile.type || undefined,
          ...(isPdf ? { pdfBase64: b64 } : { imageBase64: b64 }),
        },
      });
    } else if (captureText.trim()) {
      if (batchMode) {
        createCaseBatch.mutate({
          data: { sourceType: "text", name: "pasted-text.txt", text: captureText },
        });
        return;
      }
      createCase.mutate({
        data: {
          sourceType: "text",
          name: "pasted-text.txt",
          text: captureText,
        },
      });
    }
  };

  // Evidence weights from the corrections exhaust: the metrics endpoint's
  // per-field override rates make error-prone fields cost more expected
  // effort than fields operators always keep. Cached generously — the rates
  // move on the scale of days, not clicks.
  const { data: queueMetrics } = useGetClerkMetrics(undefined, {
    query: {
      queryKey: getGetClerkMetricsQueryKey(undefined),
      staleTime: 5 * 60_000,
      retry: false,
    },
  });
  const weights = useMemo(
    () => fieldWeights(queueMetrics?.corrections),
    [queueMetrics],
  );

  // Ready-to-approve cases jump the queue (fast lane); the rest order by
  // expected review effort (evidence-weighted flagged fields + pre-flight
  // findings, lightest first), newest breaking ties — the queue drains by
  // operator throughput rather than strict arrival order.
  const sortedCases = useMemo(() => {
    const byNewest = [...cases].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return [
      ...byNewest.filter(isReadyToApprove),
      ...byNewest
        .filter((c) => !isReadyToApprove(c))
        .sort((a, b) => reviewEffort(a, weights) - reviewEffort(b, weights)),
    ];
  }, [cases, weights]);
  const readyCases = useMemo(
    () => sortedCases.filter(isReadyToApprove),
    [sortedCases],
  );
  const readyCount = readyCases.length;

  // Fast-lane bulk approval (operator throughput): approve every loaded
  // "Ready" case in one confirmed action. The server re-checks eligibility
  // per case and applies each decision through the SAME decideCase machinery
  // a single approval runs — a skipped case is left exactly as it was, and
  // every approval still stops at a DRAFT invoice. Capped at the endpoint's
  // 50-item batch limit.
  const bulkCandidates = useMemo(
    () => readyCases.slice(0, BULK_APPROVE_MAX),
    [readyCases],
  );
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReport, setBulkReport] = useState<ClerkBulkApproveReport | null>(
    null,
  );
  // Supplier/number labels snapshotted when the batch is sent, so the
  // outcomes view can still name a case after the queue refetch drops it.
  const [bulkLabels, setBulkLabels] = useState<Map<string, string>>(
    () => new Map(),
  );

  // Party identities for the bulk decisions: the top register suggestion per
  // slot — the SAME auto-pre-selection the single review pane makes before
  // the operator touches anything. Fetched only while the dialog is open; a
  // failed lookup leaves that case's slots empty and the server then skips
  // the row with a named reason.
  const bulkIds = useMemo(() => bulkCandidates.map((c) => c.id), [bulkCandidates]);
  const { data: bulkSuggestions, isLoading: bulkSuggestionsLoading } = useQuery(
    {
      queryKey: ["clerk-bulk-party-suggestions", bulkIds],
      queryFn: async () => {
        const entries = await Promise.all(
          bulkIds.map(async (id) => {
            try {
              return [id, await getClerkPartySuggestions(id)] as const;
            } catch {
              return [id, undefined] as const;
            }
          }),
        );
        return new Map<string, ClerkPartySuggestions | undefined>(entries);
      },
      // >= 1, not >= 2: the open dialog's list is live, so a refetch can
      // shrink it below the 2-case button threshold — a single remaining
      // candidate still needs its party suggestions resolved or it would
      // render as "will be skipped" forever.
      enabled: bulkOpen && bulkIds.length >= 1,
      staleTime: 60_000,
      retry: false,
    },
  );

  const bulkApprove = useBulkApproveClerkCases({
    mutation: {
      onSuccess: (report) => {
        setBulkReport(report);
        setDisabledBanner(false);
        invalidateCases();
      },
      onError: (e) =>
        handleGatewayError(e, "Could not bulk-approve the fast lane."),
    },
  });

  // Which body the dialog shows: outcomes report, live candidate review, or
  // the drained state (the open dialog's queue refetched down to zero — an
  // empty batch would be a contract 400, so confirm disables and the dialog
  // says why).
  const bulkPhase = bulkDialogPhase({
    hasReport: bulkReport !== null,
    candidateCount: bulkCandidates.length,
    approvalPending: bulkApprove.isPending,
  });

  const confirmBulkApprove = () => {
    // Belt and braces behind the disabled button: never send an empty batch.
    if (bulkCandidates.length === 0) return;
    setBulkLabels(
      new Map(
        bulkCandidates.map((c) => {
          const s = fastLaneCaseSummary(c);
          return [c.id, `${s.supplier} · ${s.invoiceNumber}`];
        }),
      ),
    );
    bulkApprove.mutate({
      data: {
        items: bulkCandidates.map((c) => ({
          caseId: c.id,
          // The SAME builder the single-approve button calls, fed by the
          // same prefill (extraction values + top party suggestions + the
          // case's own firm).
          decision: approveDecisionFromForm(
            bulkApproveFormFromCase(c, bulkSuggestions?.get(c.id)),
            "",
          ),
        })),
      },
    });
  };

  const closeBulkDialog = () => {
    setBulkOpen(false);
    setBulkReport(null);
  };

  // Batch-aware grouping (round-8 idea #3): a bundle's segments stay together
  // under one header with per-batch progress; unbatched cases are untouched.
  const queueGroups = useMemo(
    () => groupQueueByBatch(sortedCases),
    [sortedCases],
  );
  const hasBatchGroups = queueGroups.some((g) => g.batchId !== null);
  const { data: queueBatches } = useListClerkBatches({
    query: {
      queryKey: getListClerkBatchesQueryKey(),
      enabled: hasBatchGroups,
      staleTime: 60_000,
      retry: false,
    },
  });
  const batchById = useMemo(
    () => new Map((queueBatches ?? []).map((b) => [b.id, b])),
    [queueBatches],
  );

  const approveDisabled =
    !form ||
    !form.firmId ||
    !form.supplierPartyId ||
    !form.buyerPartyId ||
    !form.invoiceNumber.trim() ||
    !form.issueDate ||
    form.lines.length === 0 ||
    form.lines.some(
      (l) =>
        !l.description.trim() ||
        !l.quantity ||
        !l.unitPrice ||
        vatPercentInvalid(l.vatRate),
    );

  // Only the FIRST page's load blanks the whole workspace; loading a later
  // page keeps the rows already on screen and spins the Load more button.
  if (isLoading && offset === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error) return <QueryError thing="Clerk cases" onRetry={refetch} />;

  const setLine = (i: number, patch: Partial<InvoiceLineInput>) => {
    if (!form) return;
    setForm({
      ...form,
      lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    });
  };

  // Pre-flight issues only steer the review while the case is still
  // decidable; decided cases keep their history without the amber paint.
  const activePreflight =
    selected != null &&
    (selected.status === "extracted" || selected.status === "in_review")
      ? (selected.preflight ?? [])
      : [];
  const preflightFields = new Set(activePreflight.map((i) => i.field));
  // "lines" / "lines.0.quantity" style issues point at the lines table as a
  // whole — per-cell targeting isn't worth the noise.
  const linesPreflightHit = activePreflight.some(
    (i) => i.field === "lines" || i.field.startsWith("lines."),
  );

  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Intake and review"
        title={firstName ? `${greeting()}, ${firstName}` : "Intake queue"}
        description="Clerk reads documents and voice notes — it never files anything. Every case below needs your review before a record changes."
        right={
          clerkFlag ? (
            clerkFlag.enabled ? (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3.5 py-1.5 text-sm font-medium text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300"
                data-testid="pill-guardrails"
              >
                <span
                  className="h-2 w-2 rounded-full bg-teal-500"
                  aria-hidden="true"
                />
                Guardrails on
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3.5 py-1.5 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                data-testid="pill-guardrails"
              >
                <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
                Clerk switched off
              </span>
            )
          ) : null
        }
      />

      {disabledBanner && (
        <ClerkDisabledBanner>
          No AI calls are made while it is off — re-enable it under Feature
          flags.
        </ClerkDisabledBanner>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1 self-start">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-baseline gap-2">
                  New intake
                  <span
                    className="text-sm font-normal text-muted-foreground"
                    data-testid="text-open-count"
                  >
                    {sortedCases.filter((c) => OPEN_STATUSES.has(c.status)).length}{" "}
                    open
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
              <CardContent className="space-y-3">
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
                      Invoice document (PDF or photo)
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
                      English voice notes; the audio is transcribed and only
                      the transcript is kept.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      or paste the invoice text:
                    </p>
                    <Textarea
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
                        the checkbox greys out for images and voice notes. */}
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
                      <Label
                        htmlFor="batch-toggle"
                        className="text-sm font-normal"
                      >
                        This upload contains multiple invoices
                      </Label>
                    </div>
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
                              {createCase.isPending
                                ? "Reading…"
                                : "Create anyway"}
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
                {/* The query is already extraction-only (kind param), so no
                    client-side kind filter is needed here anymore. */}
                {sortedCases.length === 0 ? (
                  // First-run empty state: show the two ways in — a single
                  // capture, or a multi-invoice bundle (same form, batch
                  // pre-ticked). Both only OPEN the form; reading still
                  // takes the operator's click.
                  <EmptyState
                    icon={Inbox}
                    title="No documents read yet"
                    description="Capture an invoice document, voice note or pasted text — Clerk reads it and queues it here for your review."
                    className="py-8 px-2"
                  >
                    <div className="flex flex-wrap justify-center gap-2 mt-1">
                      <Button
                        size="sm"
                        onClick={() => setCaptureOpen(true)}
                        data-testid="button-empty-capture"
                      >
                        <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                        Capture your first document
                      </Button>
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
                    </div>
                  </EmptyState>
                ) : (
                  <div className="space-y-2">
                    {queueGroups.map((g) => {
                      const rows = g.cases.map((c) => {
                      const kind = intakeKind(c.sourceType);
                      const Icon = kind.icon;
                      const status = QUEUE_STATUS[c.status];
                      const ready = isReadyToApprove(c);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          aria-current={selectedId === c.id ? "true" : undefined}
                          className={`w-full text-left flex items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/50 ${
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
                          className="space-y-2 rounded-xl border border-dashed border-border p-2"
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
                                {batch.reviewedCases} of {batch.createdCases}{" "}
                                reviewed
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

            <Card className="lg:col-span-2 self-start">
              <CardHeader>
                {selected ? (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {intakeKind(selected.sourceType).eyebrow}
                      </p>
                      <CardTitle className="text-xl mt-1 truncate">
                        {selected.sourceName ?? "Case detail"}
                      </CardTitle>
                    </div>
                    <span
                      className={pillClasses(
                        STATUS_TONE[selected.status] ?? "slate",
                      )}
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
                    Pick a case on the left, or read a new document.
                  </p>
                ) : (
                  <>
                    {/* The source, quoted: a voice note's transcript or the
                        pasted text, with its provenance line. */}
                    {selected.sourceText ? (
                      <div
                        className="rounded-xl border bg-muted/30 p-4 space-y-2.5"
                        data-testid="card-source-text"
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-white dark:bg-teal-500"
                            aria-hidden="true"
                          >
                            {(() => {
                              const Icon = intakeKind(selected.sourceType).icon;
                              return <Icon className="h-4 w-4" />;
                            })()}
                          </span>
                          <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {selected.sourceDurationSec
                                ? `${voiceDuration(selected.sourceDurationSec)} ${intakeKind(selected.sourceType).label.toLowerCase()}`
                                : intakeKind(selected.sourceType).label}
                            </span>{" "}
                            · {formatDateTime(selected.createdAt)}
                          </p>
                        </div>
                        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                          {selected.sourceText}
                        </p>
                      </div>
                    ) : null}
                    {selected.extraction && (
                      <p className="text-xs text-muted-foreground">
                        read by {selected.extraction.model} (
                        {selected.extraction.promptVersion})
                      </p>
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
                              onClick={() =>
                                retryCase.mutate({ id: selected.id })
                              }
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
                              <li key={`${issue.field}-${i}`}>
                                {issue.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}

                    {selected.extraction && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5 flex items-center gap-2">
                          Extracted fields — amber rows need checking
                          {selected.extraction.exemplarCaseId && (
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
                          {selected.extraction.fields.map((f) => {
                            const preflightHit = preflightFields.has(f.field);
                            const snippetOpen = openSnippets.has(f.field);
                            const hint = correctionHint(
                              f.field,
                              queueMetrics?.corrections,
                            );
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
                                    {fieldLabel(f.field)}
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

                    {selected.status === "approved" &&
                      selected.createdInvoiceId && (
                        <Alert data-testid="banner-draft-created">
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                          <AlertTitle>Draft invoice created</AlertTitle>
                          <AlertDescription>
                            The invoice was created as a DRAFT. It has not been
                            submitted — it follows the normal human submission
                            flow.
                          </AlertDescription>
                        </Alert>
                      )}

                    {form && (
                      <div className="border-t pt-4 space-y-3">
                        <p className="text-sm font-medium">
                          Review and approve — creates a draft invoice only
                        </p>
                        {/* Claiming is optional: deciding straight from
                            "extracted" stays possible (solo-operator fast
                            path). A claim only marks the case as actively
                            being reviewed so a second operator doesn't start
                            the same work. */}
                        {selected.status === "extracted" &&
                          !selected.claimedBy && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  claimCase.mutate({ id: selected.id })
                                }
                                disabled={claimCase.isPending}
                                data-testid="button-claim-case"
                              >
                                {claimCase.isPending
                                  ? "Claiming…"
                                  : "Claim for review"}
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                Optional — deciding below works without
                                claiming.
                              </p>
                            </div>
                          )}
                        {selected.status === "in_review" && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={pillClasses("amber")}
                              data-testid="badge-claimed"
                            >
                              Claimed by {shortActor(selected.claimedBy)} ·{" "}
                              {relativeTime(selected.claimedAt)}
                            </span>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                releaseCase.mutate({ id: selected.id })
                              }
                              disabled={releaseCase.isPending}
                              data-testid="button-release-case"
                            >
                              {releaseCase.isPending
                                ? "Releasing…"
                                : "Release"}
                            </Button>
                          </div>
                        )}
                        <div className="grid sm:grid-cols-3 gap-3">
                          <div className="space-y-1">
                            <Label>Firm</Label>
                            <Select
                              value={form.firmId}
                              onValueChange={(v) =>
                                setForm({ ...form, firmId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-firm">
                                <SelectValue placeholder="Choose firm" />
                              </SelectTrigger>
                              <SelectContent>
                                {(firms ?? []).map((f) => (
                                  <SelectItem key={f.id} value={f.id}>
                                    {f.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Supplier party</Label>
                            <Select
                              value={form.supplierPartyId}
                              onValueChange={(v) =>
                                setForm({ ...form, supplierPartyId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-supplier">
                                <SelectValue placeholder="Choose supplier" />
                              </SelectTrigger>
                              <SelectContent>
                                {(parties ?? []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.legalName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <PartySuggestionChips
                              suggestions={partySuggestions?.supplier ?? []}
                              value={form.supplierPartyId}
                              onPick={(partyId) =>
                                setForm({ ...form, supplierPartyId: partyId })
                              }
                              testId="suggestions-supplier"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label>Buyer party</Label>
                            <Select
                              value={form.buyerPartyId}
                              onValueChange={(v) =>
                                setForm({ ...form, buyerPartyId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-buyer">
                                <SelectValue placeholder="Choose buyer" />
                              </SelectTrigger>
                              <SelectContent>
                                {(parties ?? []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.legalName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <PartySuggestionChips
                              suggestions={partySuggestions?.buyer ?? []}
                              value={form.buyerPartyId}
                              onPick={(partyId) =>
                                setForm({ ...form, buyerPartyId: partyId })
                              }
                              testId="suggestions-buyer"
                            />
                          </div>
                        </div>
                        <div className="grid sm:grid-cols-4 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="apr-number">Invoice number</Label>
                            <Input
                              id="apr-number"
                              value={form.invoiceNumber}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  invoiceNumber: e.target.value,
                                })
                              }
                              data-testid="input-approve-number"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="apr-issue">Issue date</Label>
                            <Input
                              id="apr-issue"
                              type="date"
                              value={form.issueDate}
                              onChange={(e) =>
                                setForm({ ...form, issueDate: e.target.value })
                              }
                              data-testid="input-approve-issue-date"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="apr-due">Due date</Label>
                            <Input
                              id="apr-due"
                              type="date"
                              value={form.dueDate}
                              onChange={(e) =>
                                setForm({ ...form, dueDate: e.target.value })
                              }
                              data-testid="input-approve-due-date"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label>Category</Label>
                            <Select
                              value={form.category}
                              onValueChange={(v) =>
                                setForm({
                                  ...form,
                                  category:
                                    v as ClerkCaseDecisionInputCategory,
                                })
                              }
                            >
                              <SelectTrigger data-testid="select-category">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CATEGORIES.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {c.toUpperCase()}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div
                          className={`space-y-2${
                            linesPreflightHit
                              ? " rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800 dark:bg-amber-950/20"
                              : ""
                          }`}
                        >
                          <Label>Lines</Label>
                          {form.lines.map((line, i) => (
                            <div
                              key={i}
                              className="grid grid-cols-12 gap-2"
                              data-testid={`row-line-${i}`}
                            >
                              <Input
                                className="col-span-6"
                                placeholder="Description"
                                value={line.description}
                                onChange={(e) =>
                                  setLine(i, { description: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Qty"
                                value={line.quantity}
                                onChange={(e) =>
                                  setLine(i, { quantity: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Unit price"
                                value={line.unitPrice}
                                onChange={(e) =>
                                  setLine(i, { unitPrice: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="VAT %"
                                value={line.vatRate}
                                onChange={(e) =>
                                  setLine(i, { vatRate: e.target.value })
                                }
                              />
                            </div>
                          ))}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="apr-reason">
                            Reason (required to reject or escalate)
                          </Label>
                          <Textarea
                            id="apr-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={2}
                            data-testid="input-decision-reason"
                          />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                // The shared builder — the fast-lane bulk
                                // items are built by this same function.
                                data: approveDecisionFromForm(form, reason),
                              })
                            }
                            disabled={approveDisabled || decideCase.isPending}
                            data-testid="button-approve-case"
                          >
                            Approve as draft invoice
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "reject", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-reject-case"
                          >
                            Reject
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "escalate", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-escalate-case"
                          >
                            Escalate
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

      {/* Fast-lane bulk approval. The dialog is explicit about scope: only
          fast-lane cases (clean extraction, clear pre-flight, confident
          critical fields) are touched, every approval creates a DRAFT
          invoice only, and the server re-checks each case — anything that no
          longer qualifies is skipped and left exactly as it was. */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (!o) closeBulkDialog();
          else setBulkOpen(true);
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {/* Once the report is in, the queue has refetched and the
                  candidate list may be empty — pin the count to the batch
                  that actually ran. */}
              Approve the fast lane (
              {bulkReport ? bulkReport.results.length : bulkCandidates.length})
            </DialogTitle>
            <DialogDescription>
              This only touches fast-lane cases — extraction succeeded,
              pre-flight found nothing blocking and every critical field is
              confident. Each approval creates a DRAFT invoice only; nothing
              is submitted. The server re-checks every case and skips any
              that no longer qualify, leaving them exactly as they were.
            </DialogDescription>
          </DialogHeader>
          {bulkReport ? (
            (() => {
              const summary = bulkApproveSummary(bulkReport);
              return (
                <div className="space-y-3" data-testid="bulk-approve-report">
                  <p
                    className="text-sm font-medium text-emerald-700 dark:text-emerald-400"
                    role="status"
                    data-testid="text-bulk-approved-count"
                  >
                    {summary.approved} case
                    {summary.approved === 1 ? "" : "s"} approved as draft
                    invoices.
                  </p>
                  {summary.skipped.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        Skipped — left exactly as they were:
                      </p>
                      <ul
                        className="space-y-1 text-xs text-muted-foreground"
                        data-testid="bulk-skipped-list"
                      >
                        {summary.skipped.map((r) => (
                          <li
                            key={r.caseId}
                            data-testid={`row-bulk-skipped-${r.caseId}`}
                          >
                            <span className="font-medium text-foreground">
                              {bulkLabels.get(r.caseId) ?? r.caseId}
                            </span>
                            : {r.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <DialogFooter>
                    <Button
                      onClick={closeBulkDialog}
                      data-testid="button-close-bulk-approve"
                    >
                      Close
                    </Button>
                  </DialogFooter>
                </div>
              );
            })()
          ) : bulkPhase === "drained" ? (
            <>
              {/* The live queue drained the candidate list while the dialog
                  was open (a refetch, or another operator decided the cases).
                  Confirm stays disabled — an empty batch is a contract 400 —
                  and the dialog says why instead of offering a dead button. */}
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-bulk-drained"
              >
                The queue changed — nothing left to approve. The fast-lane
                cases were decided or updated while this dialog was open.
              </p>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={closeBulkDialog}
                  data-testid="button-cancel-bulk-approve"
                >
                  Close
                </Button>
                <Button
                  disabled
                  data-testid="button-confirm-bulk-approve"
                >
                  Approve as drafts
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div
                className="border rounded-md divide-y text-sm"
                data-testid="bulk-approve-rows"
              >
                {bulkCandidates.map((c) => {
                  const s = fastLaneCaseSummary(c);
                  const prefill = bulkApproveFormFromCase(
                    c,
                    bulkSuggestions?.get(c.id),
                  );
                  const unresolved =
                    !prefill.firmId ||
                    !prefill.supplierPartyId ||
                    !prefill.buyerPartyId;
                  return (
                    <div
                      key={c.id}
                      className="flex items-center gap-3 px-3 py-2"
                      data-testid={`row-bulk-case-${c.id}`}
                    >
                      <span className="flex-1 min-w-0 truncate font-medium">
                        {s.supplier}
                      </span>
                      <span className="text-muted-foreground">
                        {s.invoiceNumber}
                      </span>
                      <span className="tabular-nums">{s.amount}</span>
                      {!bulkSuggestionsLoading && unresolved && (
                        <span
                          className={pillClasses("amber")}
                          title="No firm or register match resolved — the server will skip this case; approve it from the single-case review instead."
                          data-testid={`pill-bulk-unresolved-${c.id}`}
                        >
                          will be skipped
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={closeBulkDialog}
                  data-testid="button-cancel-bulk-approve"
                >
                  Cancel
                </Button>
                <Button
                  onClick={confirmBulkApprove}
                  disabled={bulkApprove.isPending || bulkSuggestionsLoading}
                  data-testid="button-confirm-bulk-approve"
                >
                  {bulkApprove.isPending
                    ? "Approving…"
                    : `Approve ${bulkCandidates.length} as drafts`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
