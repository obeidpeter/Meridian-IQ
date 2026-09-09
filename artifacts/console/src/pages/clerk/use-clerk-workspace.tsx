import { useEffect, useMemo, useState } from "react";
import {
  useListClerkCases,
  useListClerkBatches,
  useGetClerkCase,
  useGetClerkCaseSourcePages,
  useCreateClerkCase,
  useCreateClerkCaseBatch,
  useDecideClerkCase,
  useDecideNoticeCase,
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
  getGetClerkCaseSourcePagesQueryKey,
  getGetClerkMetricsQueryKey,
  getGetClerkPartySuggestionsQueryKey,
  getListObligationsQueryKey,
  type BatchClerkCasesResult,
  type ClerkBulkApproveReport,
  type ClerkCase,
  type ClerkCaseCreateInput,
  type ClerkPartySuggestions,
  type ListClerkCasesParams,
  type Obligation,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  errorStatus,
  killSwitchTripped,
  serverErrorMessage,
} from "@/lib/errors";
import { pillClasses } from "@/lib/format";
import {
  type ApproveForm,
  type NoticeApproveForm,
  approveDecisionFromForm,
  approveFormFromCase,
  bulkApproveFormFromCase,
  bulkDialogPhase,
  clerkDisabledToast,
  fastLaneCaseSummary,
  fieldLabel,
  fieldWeights,
  fileIsPdf,
  fileToBase64,
  groupQueueByBatch,
  isReadyToApprove,
  noticeApproveFormFromCase,
  noticeFieldLabel,
  relativeTime,
  reviewEffort,
  serverErrorToast,
  shortActor,
  vatPercentInvalid,
} from "@/pages/clerk-shared";
import { useVoiceRecorder } from "@/pages/use-voice-recorder";
import { BULK_APPROVE_MAX, PAGE_SIZE, type QueueKind } from "./constants";

// Everything the Clerk intake workspace holds and does (R120 moved it out of
// the page shell): the queue paging, the capture state, the decision forms,
// the mutations and the bulk fast lane. The shell calls it once and hands
// the bag to the two columns, so nothing about hook order or closures
// changed in the split; the shell keeps the loading and error returns.
export function useClerkWorkspace() {
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

  // Paged case queue. The workspace shows one kind at a time — invoice
  // extraction cases or notice cases — and that kind filter travels to the
  // server with the page bounds (any filter change restarts from the first
  // page — offset only ever grows within one filter set). Only the page at
  // `offset` is a live query; earlier pages are kept in local state and
  // re-appended below.
  const [queueKind, setQueueKind] = useState<QueueKind>("extraction");
  const [queueSearch, setQueueSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [earlierCases, setEarlierCases] = useState<ClerkCase[]>([]);
  const caseParams: ListClerkCasesParams = {
    kind: queueKind,
    limit: PAGE_SIZE,
    offset,
  };
  const switchQueueKind = (kind: QueueKind) => {
    if (kind === queueKind) return;
    setQueueKind(kind);
    // Restart paging for the new filter set; keep the selected case — the
    // detail pane fetches by id and stays valid across tabs.
    setEarlierCases([]);
    setOffset(0);
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

  // Source-document panels in the review pane. A single captured image rides
  // along on the case row itself (sourceImageB64) — expanded by default, the
  // operator can fold it away. A scanned PDF's rendered pages are heavier, so
  // they are fetched lazily: only after "View pages", and only for the case
  // on screen. Both reset when the operator moves to another case.
  const [imageOpen, setImageOpen] = useState(true);
  const [pagesOpen, setPagesOpen] = useState(false);
  useEffect(() => {
    setImageOpen(true);
    setPagesOpen(false);
  }, [selectedId]);
  const pagesEnabled =
    pagesOpen &&
    selected != null &&
    selected.sourceType === "pdf" &&
    !selected.sourceText &&
    !selected.sourceImageB64;
  const {
    data: sourcePages,
    isLoading: sourcePagesLoading,
    error: sourcePagesError,
    refetch: refetchSourcePages,
  } = useGetClerkCaseSourcePages(selectedId ?? "", {
    query: {
      queryKey: getGetClerkCaseSourcePagesQueryKey(selectedId ?? ""),
      enabled: pagesEnabled,
      retry: false,
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

  // Decision forms — the invoice approve form and the notice decision form
  // are mutually exclusive: at most one is non-null, keyed by the selected
  // case's kind.
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [noticeForm, setNoticeForm] = useState<NoticeApproveForm | null>(null);
  const [reason, setReason] = useState("");
  // The obligation created by the LAST notice approval on the selected case:
  // survives the case refetching to "approved" (which clears the form), and
  // resets when the operator moves to another case.
  const [noticeObligation, setNoticeObligation] = useState<Obligation | null>(
    null,
  );
  useEffect(() => {
    setNoticeObligation(null);
  }, [selectedId]);
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
    if (
      selected &&
      (selected.status === "extracted" || selected.status === "in_review")
    ) {
      setForm(
        selected.kind === "extraction" ? approveFormFromCase(selected) : null,
      );
      setNoticeForm(
        selected.kind === "notice" ? noticeApproveFormFromCase(selected) : null,
      );
    } else {
      setForm(null);
      setNoticeForm(null);
    }
    setReason("");
    setOpenSnippets(new Set());
    // Reset only when the case identity or status changes: a react-query
    // refetch delivers a fresh `selected` reference with the same id/status
    // mid-edit, and depending on the object would clobber operator input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  const { data: firms } = useListFirms();
  // Bounded reads (R98): the operator desk sees the whole party spine, so it
  // asks for the reference-list ceiling; the suggestion endpoint below covers
  // the common path and the dropdowns are the fallback.
  const { data: parties } = useListParties({ limit: 500 });

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
        f.supplierPartyId || (partySuggestions.supplier?.[0]?.partyId ?? "");
      const buyerPartyId =
        f.buyerPartyId || (partySuggestions.buyer?.[0]?.partyId ?? "");
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
          title: kase.status === "failed" ? "Reading failed" : "Document read",
          description:
            kase.status === "failed"
              ? (kase.failReason ?? "The Clerk could not read this document.")
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

  // Notice decisions ride their own endpoint: approve creates an OPEN
  // obligation (client, authority, response deadline) — never an invoice.
  // The created obligation's deadline is surfaced in the success state, and
  // the obligations lists (client cards) go stale together with the queue.
  const decideNotice = useDecideNoticeCase({
    mutation: {
      onSuccess: (result) => {
        invalidateCases();
        queryClient.invalidateQueries({
          queryKey: getListObligationsQueryKey(),
        });
        if (result.obligation) {
          setNoticeObligation(result.obligation);
          toast({
            title: "Obligation recorded",
            description: `Obligation recorded — response due ${result.obligation.responseDueDate}`,
          });
        } else {
          toast({ title: `Case ${result.case.status}` });
        }
      },
      onError: (e) =>
        handleGatewayError(e, "Could not record the notice decision."),
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
              ? (kase.failReason ??
                "The Clerk still could not read this document.")
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

  // On the Notices tab a capture is a photographed/uploaded tax-authority
  // notice: the create payload says so (documentKind), and the invoice-only
  // affordances (voice dictation, batch splitting) don't apply.
  const noticeCapture = queueKind === "notice";

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
      if (batchMode && isPdf && !noticeCapture) {
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
          ...(noticeCapture ? { documentKind: "notice" as const } : {}),
        },
      });
    } else if (captureText.trim()) {
      if (batchMode && !noticeCapture) {
        createCaseBatch.mutate({
          data: {
            sourceType: "text",
            name: "pasted-text.txt",
            text: captureText,
          },
        });
        return;
      }
      createCase.mutate({
        data: {
          sourceType: "text",
          name: "pasted-text.txt",
          text: captureText,
          ...(noticeCapture ? { documentKind: "notice" as const } : {}),
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
  const filteredCases = useMemo(() => {
    const needle = queueSearch.trim().toLowerCase();
    if (!needle) return sortedCases;
    return sortedCases.filter((c) =>
      [
        c.sourceName,
        c.status,
        c.kind,
        c.id,
        ...(c.extraction?.fields.map((field) => field.value) ?? []),
        ...(c.noticeExtraction?.fields.map((field) => field.value) ?? []),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [queueSearch, sortedCases]);

  useEffect(() => {
    if (selectedId == null && filteredCases[0]) {
      setSelectedId(filteredCases[0].id);
    }
  }, [filteredCases, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "input, textarea, select, button, [contenteditable='true']",
        )
      ) {
        return;
      }
      event.preventDefault();
      const current = filteredCases.findIndex((c) => c.id === selectedId);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(
        Math.max(current < 0 ? 0 : current + direction, 0),
        filteredCases.length - 1,
      );
      if (filteredCases[next]) setSelectedId(filteredCases[next].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredCases, selectedId]);
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
  const bulkIds = useMemo(
    () => bulkCandidates.map((c) => c.id),
    [bulkCandidates],
  );
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
    () => groupQueueByBatch(filteredCases),
    [filteredCases],
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

  // The review pane's fields table serves both case kinds: an invoice case
  // carries `extraction`, a notice case carries `noticeExtraction` — same
  // field shape (value/confidence/flagged/critical/snippet), same
  // presentation, different label vocabulary. Correction hints stay
  // invoice-only: the corrections exhaust is invoice-field evidence.
  const detailExtraction =
    selected?.extraction ?? selected?.noticeExtraction ?? null;
  const detailFieldLabel =
    selected?.kind === "notice" ? noticeFieldLabel : fieldLabel;

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

  // Claiming is optional: deciding straight from "extracted" stays possible
  // (solo-operator fast path). A claim only marks the case as actively being
  // reviewed so a second operator doesn't start the same work. Shared by the
  // invoice and notice decision forms.
  const claimControls =
    selected == null ? null : (
      <>
        {selected.status === "extracted" && !selected.claimedBy && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => claimCase.mutate({ id: selected.id })}
              disabled={claimCase.isPending}
              data-testid="button-claim-case"
            >
              {claimCase.isPending ? "Claiming…" : "Claim for review"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Optional — deciding below works without claiming.
            </p>
          </div>
        )}
        {selected.status === "in_review" && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className={pillClasses("amber")} data-testid="badge-claimed">
              Claimed by {shortActor(selected.claimedBy)} ·{" "}
              {relativeTime(selected.claimedAt)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => releaseCase.mutate({ id: selected.id })}
              disabled={releaseCase.isPending}
              data-testid="button-release-case"
            >
              {releaseCase.isPending ? "Releasing…" : "Release"}
            </Button>
          </div>
        )}
      </>
    );

  return {
    queryClient,
    toast,
    disabledBanner,
    setDisabledBanner,
    me,
    flags,
    clerkFlag,
    firstName,
    queueKind,
    setQueueKind,
    queueSearch,
    setQueueSearch,
    offset,
    setOffset,
    earlierCases,
    setEarlierCases,
    caseParams,
    switchQueueKind,
    casePage,
    isLoading,
    error,
    refetch,
    cases,
    hasMoreCases,
    loadingMoreCases,
    loadMoreCases,
    selectedId,
    setSelectedId,
    selected,
    imageOpen,
    setImageOpen,
    pagesOpen,
    setPagesOpen,
    pagesEnabled,
    sourcePages,
    sourcePagesLoading,
    sourcePagesError,
    refetchSourcePages,
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
    setBatchResult,
    pendingDuplicate,
    setPendingDuplicate,
    form,
    setForm,
    noticeForm,
    setNoticeForm,
    reason,
    setReason,
    noticeObligation,
    setNoticeObligation,
    openSnippets,
    setOpenSnippets,
    toggleSnippet,
    firms,
    parties,
    suggestionsCaseId,
    partySuggestions,
    handleGatewayError,
    invalidateCases,
    createCase,
    createCaseBatch,
    decideCase,
    decideNotice,
    claimCase,
    releaseCase,
    retryCase,
    voiceFromRecorder,
    setVoiceFromRecorder,
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
    noticeCapture,
    submitCapture,
    queueMetrics,
    weights,
    sortedCases,
    filteredCases,
    readyCases,
    readyCount,
    bulkCandidates,
    bulkOpen,
    setBulkOpen,
    bulkReport,
    setBulkReport,
    bulkLabels,
    setBulkLabels,
    bulkIds,
    bulkSuggestions,
    bulkSuggestionsLoading,
    bulkApprove,
    bulkPhase,
    confirmBulkApprove,
    closeBulkDialog,
    queueGroups,
    hasBatchGroups,
    queueBatches,
    batchById,
    approveDisabled,
    detailExtraction,
    detailFieldLabel,
    activePreflight,
    preflightFields,
    linesPreflightHit,
    claimControls,
  };
}

export type ClerkWorkspaceState = ReturnType<typeof useClerkWorkspace>;
