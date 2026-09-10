import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  useCreateClerkCase,
  useCreateClerkBatch,
  useGetMe,
  useGetClerkBatch,
  useListClerkBatches,
  useListClerkCases,
  getGetClerkBatchQueryKey,
  getGetClerkUsageQueryKey,
  getListClerkBatchesQueryKey,
  getListClerkCasesQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkBatchView,
  ClerkCase,
  ClerkCaseCreateInput,
  ClerkCaseCreateInputDocumentKind,
  CreateClerkBatchInput,
  ListClerkCasesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import {
  fileToBase64,
  handleClerkGatewayError,
  MAX_VOICE_BYTES,
} from "@/lib/clerk";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
} from "@workspace/web-ui";

// Clerk is capture-only for clients: they submit a document, voice note, or
// pasted text and watch the status. Every approval happens on the operator
// side — an approved case links the DRAFT invoice it created, nothing more.

/**
 * Every hook, query, mutation and handler of the capture page, in the order
 * the page has always called them (R126 split). The body-shape guarantees
 * (no documentKind key in invoice mode, voice never carrying documentKind,
 * batch never taking voice) all live in submitCapture / kindFields below.
 */
export function useCapture() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const operationKey = operationSessionKey(me);

  const [captureText, setCaptureText] = useState("");
  const [captureFile, setCaptureFile] = useState<File | null>(null);
  const [captureVoice, setCaptureVoice] = useState<File | null>(null);
  // What the user is sending: an invoice (the default — the body carries no
  // documentKind, byte-identical to the pre-notices submission) or a
  // tax-authority notice (documentKind: "notice"). Notice mode hides the
  // voice option (the server rejects voice notices) and batch intake (the
  // splitter segments invoices only).
  const [documentKind, setDocumentKind] =
    useState<ClerkCaseCreateInputDocumentKind>("invoice");
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
  // Batch intake (async, idea #8): "This contains multiple invoices" QUEUES
  // the bundle — up to 50 invoices — and the progress card below polls the
  // batch's counters while the platform segments and extracts out of band.
  const [batchMode, setBatchMode] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatchOperationId, setActiveBatchOperationId] = useState<
    string | null
  >(null);

  // Batch work is server-owned and survives route changes. Recover the newest
  // in-flight bundle when this page remounts; if processing failed before it
  // created anything, recover that failure too so it cannot disappear merely
  // because the user navigated away.
  const { data: batches } = useListClerkBatches({
    query: {
      queryKey: getListClerkBatchesQueryKey(),
      retry: false,
    },
  });
  useEffect(() => {
    if (activeBatchId || !batches?.length) return;
    const newest = [...batches].sort(
      (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    );
    const recoverable =
      newest.find(
        (batch) => batch.status === "queued" || batch.status === "processing",
      ) ??
      newest.find(
        (batch) => batch.status === "failed" && batch.createdCases === 0,
      );
    if (recoverable) setActiveBatchId(recoverable.id);
  }, [activeBatchId, batches]);

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

  // Shared success plumbing for both the single and batch create paths.
  // Deliberately leaves captureVoice alone (batch never accepts voice; the
  // single path clears it in its own tail) and the per-path result state.
  // Query invalidation is per-path too: the single path refetches at once,
  // while the batch path defers it until the queued bundle lands (see the
  // activeBatchStatus effect below).
  const finishSubmission = () => {
    setCaptureText("");
    setCaptureFile(null);
    setPendingDuplicate(null);
    setDisabledBanner(false);
  };

  // Editing an input drops only the duplicate prompt attached to the old
  // source. Batch progress is independent server work and must remain visible
  // while the user composes another submission.
  const clearInputResidue = () => {
    setPendingDuplicate(null);
  };

  const createCase = useCreateClerkCase({
    mutation: {
      onSuccess: (kase: ClerkCase) => {
        queryClient.invalidateQueries({
          queryKey: getListClerkCasesQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getGetClerkUsageQueryKey() });
        finishSubmission();
        setSelectedId(kase.id);
        setCaptureVoice(null);
        toast({
          title:
            kase.status === "failed"
              ? "Clerk couldn't read that"
              : "Sent to Clerk",
          description:
            kase.status === "failed"
              ? (kase.failReason ??
                "Try a clearer photo, or paste the invoice text instead.")
              : "Your accountant will review it before anything is created.",
        });
      },
      onError: (e, variables) => {
        // 409 DUPLICATE_SOURCE: no toast — an inline panel offers "Create
        // anyway" (allowDuplicate: true) or backing out.
        if (errorStatus(e) === 409) {
          setPendingDuplicate({
            payload: variables.data,
            message: serverErrorMessage(e),
          });
          return;
        }
        handleClerkError(e);
      },
    },
  });

  const createBatch = useCreateClerkBatch({
    mutation: {
      onSuccess: (batch: ClerkBatchView) => {
        finishSubmission();
        setActiveBatchId(batch.id);
        queryClient.invalidateQueries({
          queryKey: getListClerkBatchesQueryKey(),
        });
      },
      onError: (e) => handleClerkError(e),
    },
  });

  // Poll the queued batch's progress; segmentation failures now surface here
  // as the batch's failReason instead of a submit-time error.
  const { data: activeBatch } = useGetClerkBatch(activeBatchId || "", {
    query: {
      enabled: !!activeBatchId,
      queryKey: getGetClerkBatchQueryKey(activeBatchId || ""),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "processing" ? 2000 : false;
      },
    },
  });
  // When the batch lands, the new cases and the spent tokens appear at once.
  const activeBatchStatus = activeBatch?.status;
  const activeBatchInFlight =
    activeBatchStatus === "queued" || activeBatchStatus === "processing";
  useEffect(() => {
    if (activeBatchStatus === "done" || activeBatchStatus === "failed") {
      queryClient.invalidateQueries({
        queryKey: getListClerkBatchesQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getListClerkCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClerkUsageQueryKey() });
    }
  }, [activeBatchStatus, queryClient]);
  useEffect(() => {
    if (!activeBatch || !activeBatchOperationId) return;
    if (activeBatch.status === "queued") {
      updateOperation(operationKey, activeBatchOperationId, {
        status: "queued",
        detail: "The bundle is queued for segmentation and extraction.",
        savedSummary:
          "The batch is stored server-side and can continue after navigation.",
      });
      return;
    }
    if (activeBatch.status === "processing") {
      updateOperation(operationKey, activeBatchOperationId, {
        status: "running",
        detail: activeBatch.totalSegments
          ? `${activeBatch.processedSegments} of ${activeBatch.totalSegments} segment(s) processed.`
          : "Clerk is splitting the bundle into invoices.",
        savedSummary: `${activeBatch.createdCases} submission(s) created so far.`,
      });
      return;
    }
    const hasPartialResult =
      activeBatch.createdCases > 0 || activeBatch.skippedDuplicates > 0;
    updateOperation(operationKey, activeBatchOperationId, {
      status:
        activeBatch.status === "done"
          ? activeBatch.skippedDuplicates > 0
            ? "partial"
            : "succeeded"
          : hasPartialResult
            ? "partial"
            : "failed",
      detail:
        activeBatch.status === "done"
          ? `${activeBatch.createdCases} submission(s) created; ${activeBatch.skippedDuplicates} duplicate(s) skipped.`
          : (activeBatch.failReason ?? "The batch could not be completed."),
      savedSummary: `${activeBatch.createdCases} Clerk submission(s) were saved.`,
    });
  }, [activeBatch, activeBatchOperationId, operationKey]);

  const isPdfFile =
    captureFile != null &&
    (captureFile.type === "application/pdf" ||
      captureFile.name.toLowerCase().endsWith(".pdf"));
  const isNotice = documentKind === "notice";
  // The batch splitter only takes text it can segment (pasted text or a
  // PDF's text layer), so the toggle hides for photo and voice sources —
  // and it segments INVOICES only, so notice mode hides it too (which also
  // keeps submitCapture off the batch path if batchMode was left on).
  const batchEligible =
    !isNotice && captureVoice == null && (captureFile == null || isPdfFile);

  // Only a notice marks the create body; absent = invoice, so the default
  // submission stays byte-identical to what this page sent before notices.
  // Voice never carries it — the server rejects voice notices and the voice
  // option is hidden in notice mode.
  const kindFields = isNotice ? { documentKind: "notice" as const } : {};

  // Switching kinds drops per-source residue too — and a picked voice note
  // has no notice path, so notice mode clears it as well.
  const switchKind = (kind: ClerkCaseCreateInputDocumentKind) => {
    if (kind === documentKind) return;
    setDocumentKind(kind);
    clearInputResidue();
    if (kind === "notice") setCaptureVoice(null);
  };

  // The pasted-text payload both the single and batch paths submit. The
  // "as const" keeps sourceType a literal so it satisfies both create inputs
  // outside mutate()'s contextual position. documentKind is spread in at the
  // single-case call site only — the batch input has no notice mode.
  const textPayload = () => ({
    sourceType: "text" as const,
    name: "pasted-text.txt",
    text: captureText,
  });

  const submitCase = (payload: ClerkCaseCreateInput) => {
    const operation = beginOperation(operationKey, {
      title:
        payload.documentKind === "notice"
          ? "Send notice to Clerk"
          : "Send invoice to Clerk",
      kind: "clerk",
      route: "/clerk",
      detail: `Source: ${payload.sourceType}`,
    });
    createCase.mutate(
      { data: payload },
      {
        onSuccess: (kase) =>
          updateOperation(operationKey, operation?.id, {
            status: kase.status === "failed" ? "partial" : "succeeded",
            detail:
              kase.status === "failed"
                ? (kase.failReason ??
                  "Clerk stored the submission but could not read it.")
                : "The submission is stored and ready for accountant review.",
            savedSummary:
              kase.status === "failed"
                ? "The source submission was saved; no draft was created."
                : "A Clerk case was created. No invoice is created until review.",
          }),
        onError: (error) => {
          const duplicate = errorStatus(error) === 409;
          const outcomeUnknown = errorStatus(error) === undefined;
          updateOperation(operationKey, operation?.id, {
            status: duplicate || outcomeUnknown ? "partial" : "failed",
            detail: duplicate
              ? "A matching live submission already exists; confirmation is required."
              : outcomeUnknown
                ? "The connection ended before Clerk confirmed receipt."
                : "Clerk rejected the submission.",
            savedSummary: duplicate
              ? "No duplicate case was created."
              : outcomeUnknown
                ? "Outcome unconfirmed. Check My submissions before retrying."
                : "No Clerk case was created.",
          });
        },
      },
    );
  };

  const submitBatch = (payload: CreateClerkBatchInput) => {
    const operation = beginOperation(operationKey, {
      title: "Process invoice bundle with Clerk",
      kind: "clerk",
      route: "/clerk",
      detail: `Source: ${payload.sourceType}`,
    });
    createBatch.mutate(
      { data: payload },
      {
        onSuccess: () => {
          setActiveBatchOperationId(operation?.id ?? null);
          updateOperation(operationKey, operation?.id, {
            status: "queued",
            detail: "The bundle is queued for segmentation and extraction.",
            savedSummary:
              "The batch is stored server-side and continues after navigation.",
          });
        },
        onError: (error) => {
          const outcomeUnknown = errorStatus(error) === undefined;
          updateOperation(operationKey, operation?.id, {
            status: outcomeUnknown ? "partial" : "failed",
            detail: outcomeUnknown
              ? "The connection ended before Clerk confirmed the batch."
              : "Clerk rejected the batch.",
            savedSummary: outcomeUnknown
              ? "Outcome unconfirmed. Reopen Send to Clerk before retrying."
              : "No Clerk batch was created.",
          });
        },
      },
    );
  };

  const submitCapture = async () => {
    if (batchMode && activeBatchInFlight) return;
    if (batchMode && batchEligible && (captureFile || captureText.trim())) {
      if (captureFile) {
        const b64 = await fileToBase64(captureFile);
        submitBatch({
          sourceType: "pdf",
          name: captureFile.name,
          pdfBase64: b64,
        });
      } else {
        submitBatch(textPayload());
      }
      return;
    }
    if (captureVoice) {
      const b64 = await fileToBase64(captureVoice);
      submitCase({
        sourceType: "voice",
        audioBase64: b64,
        name: captureVoice.name,
      });
    } else if (captureFile) {
      const b64 = await fileToBase64(captureFile);
      submitCase({
        sourceType: isPdfFile ? "pdf" : "image",
        ...kindFields,
        name: captureFile.name,
        contentType: captureFile.type || undefined,
        ...(isPdfFile ? { pdfBase64: b64 } : { imageBase64: b64 }),
      });
    } else if (captureText.trim()) {
      submitCase({ ...textPayload(), ...kindFields });
    }
  };

  // The source inputs' change handlers, one per control; each drops the
  // duplicate prompt attached to the previous source.
  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    setCaptureFile(e.target.files?.[0] ?? null);
    clearInputResidue();
  };

  const pickVoice = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    clearInputResidue();
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
  };

  const editText = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setCaptureText(e.target.value);
    clearInputResidue();
  };

  const toggleBatch = (e: ChangeEvent<HTMLInputElement>) => {
    setBatchMode(e.target.checked);
  };

  return {
    disabledBanner,
    documentKind,
    switchKind,
    isNotice,
    captureFile,
    pickFile,
    captureVoice,
    pickVoice,
    captureText,
    editText,
    batchEligible,
    batchMode,
    toggleBatch,
    submitCapture,
    createCase,
    createBatch,
    activeBatch,
    activeBatchInFlight,
    pendingDuplicate,
    setPendingDuplicate,
    submitCase,
    isLoading,
    isError,
    refetch,
    sortedCases,
    selectedId,
    setSelectedId,
  };
}

export type CaptureState = ReturnType<typeof useCapture>;
