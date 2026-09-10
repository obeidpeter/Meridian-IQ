// The invoice detail page's writes (R126 moved them out of the page shell):
// the submit / fix-and-resubmit flow and the escalate / adjust /
// confirmation / new-from-invoice flow, each with the mutations, the local
// state and the handlers it owns. Every handler is the same per-render
// closure it was in the shell, over values the shell hands in — nothing is
// memoised and nothing is re-derived here. Only use-invoice-detail.ts calls
// these hooks.
import { useState } from "react";
import {
  useValidateInvoice,
  useSubmitInvoice,
  useUpdateInvoice,
  useExplainInvoiceFailure,
  useEscalateInvoice,
  useCancelInvoice,
  useCreditNoteInvoice,
  useCreateConfirmation,
  getListEscalationsQueryKey,
  getListConfirmationsQueryKey,
  type FieldError as ApiFieldError,
  type Invoice,
  type InvoiceDetail as InvoiceDetailData,
  type Me,
} from "@workspace/api-client-react";
import type { QueryClient } from "@tanstack/react-query";
import type { useToast } from "@/hooks/use-toast";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import {
  draftStorageKey,
  saveInvoiceDraft,
  storedInvoiceDraftHasWork,
  type DraftState,
} from "@/lib/invoice-draft";
import type { FixDraft } from "./fix-form";
import {
  emptyLine,
  invoiceLineErrors,
  todayIsoDate,
  toInvoiceLineInputs,
} from "@/lib/invoice-lines";
import { beginOperation, updateOperation } from "@workspace/web-ui";
import { formatAmount, type statusTone } from "@/lib/format";
import { submitErrorTitle, submittedToastDescription } from "./helpers";

type Toast = ReturnType<typeof useToast>["toast"];

export function useSubmitFlow({
  id,
  data,
  invoice,
  tone,
  me,
  toast,
  refetch,
  refreshInvoiceState,
  operationKey,
}: {
  id: string;
  data: InvoiceDetailData | undefined;
  invoice: Invoice | undefined;
  tone: ReturnType<typeof statusTone>;
  me: Me | undefined;
  toast: Toast;
  refetch: () => Promise<unknown>;
  refreshInvoiceState: () => void;
  operationKey: string | null;
}) {
  const validate = useValidateInvoice();
  const submit = useSubmitInvoice();
  const updateInvoice = useUpdateInvoice();
  const explainFailure = useExplainInvoiceFailure();

  // "Fix & resubmit" (fix-and-retry): an editable copy of the failed
  // invoice's content, seeded when the form opens. Null = form closed.
  const [fix, setFix] = useState<FixDraft | null>(null);
  const [fixConflict, setFixConflict] = useState(false);
  const [showFixErrors, setShowFixErrors] = useState(false);
  // Held validation failures from the last submit attempt: the full list
  // survives the toast. Cleared on the next submit and on a successful
  // fix-and-submit.
  const [validationErrors, setValidationErrors] = useState<ApiFieldError[]>([]);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const handleSubmit = async () => {
    if (!invoice) return;
    const operation = beginOperation(operationKey, {
      title: `Submit ${invoice.invoiceNumber} for stamping`,
      kind: "submission",
      route: `/invoices/${id}`,
      detail: `${formatAmount(invoice.grandTotal, invoice.currency)} total`,
    });
    // A new attempt makes any fetched explanation stale: if this submission
    // fails again the error may be different, and yesterday's explanation
    // must not sit next to today's catalogue entry.
    explainFailure.reset();
    setValidationErrors([]);
    try {
      if (invoice.status === "draft") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          updateOperation(operationKey, operation?.id, {
            status: "failed",
            detail: `${res.errors.length} validation issue${res.errors.length === 1 ? "" : "s"} must be fixed before transmission.`,
            savedSummary: "The invoice remains a draft; nothing was sent.",
          });
          setValidationErrors(res.errors);
          refreshInvoiceState();
          toast({
            title: "Validation failed",
            description: `${res.errors.length} issue${res.errors.length === 1 ? "" : "s"} to fix — the full list is on this page.`,
            variant: "destructive",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      updateOperation(operationKey, operation?.id, {
        status: "succeeded",
        detail:
          "The transmission request was accepted and is awaiting the rail result.",
        savedSummary: "A submission attempt was recorded for this invoice.",
      });
      refreshInvoiceState();
      toast({
        title: "Submitted for stamping",
        description: submittedToastDescription(me?.features),
      });
    } catch (e) {
      const outcomeUnknown = errorStatus(e) === undefined;
      updateOperation(operationKey, operation?.id, {
        status: outcomeUnknown ? "partial" : "failed",
        detail: outcomeUnknown
          ? "The connection ended before the submission response arrived."
          : "The submission was rejected before it could be accepted.",
        savedSummary: outcomeUnknown
          ? "Outcome unconfirmed. Reopen this invoice and inspect its attempt history before retrying."
          : "No new accepted submission was recorded.",
      });
      toast({
        title: outcomeUnknown
          ? "Submission outcome not confirmed"
          : submitErrorTitle(errorStatus(e)),
        description: outcomeUnknown
          ? "Check the attempt history on this invoice before retrying."
          : serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  // Seed the fix form from what the invoice holds right now. vatRate is
  // normalised through String(Number(...)) ("0.0750" → "0.075") so the VAT
  // select recognises the stored value.
  const openFix = () => {
    if (!invoice) return;
    setFixConflict(false);
    setFix({
      expectedRevision: invoice.contentRevision,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate ?? "",
      lines: (data?.lines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatRate: String(Number(l.vatRate)),
      })),
    });
    setShowFixErrors(false);
  };

  const fixErrors: Record<string, string> = {};
  if (fix) {
    if (!fix.invoiceNumber.trim())
      fixErrors.invoiceNumber = "Invoice number is required.";
    if (!fix.issueDate) fixErrors.issueDate = "Issue date is required.";
    fix.lines.forEach((l, i) => {
      const errors = invoiceLineErrors(l);
      if (errors.description) fixErrors[`line-${i}-desc`] = errors.description;
      if (errors.quantity) fixErrors[`line-${i}-qty`] = errors.quantity;
      if (errors.unitPrice) fixErrors[`line-${i}-price`] = errors.unitPrice;
    });
  }

  const handleFixResubmit = async () => {
    if (
      !fix ||
      fixConflict ||
      updateInvoice.isPending ||
      validate.isPending ||
      submit.isPending
    )
      return;
    setShowFixErrors(true);
    if (Object.keys(fixErrors).length > 0) return;
    // Same staleness rule as handleSubmit: the explanation belonged to the
    // failure being fixed, not to whatever this resubmission produces.
    explainFailure.reset();
    let contentSaved = false;
    try {
      const updated = await updateInvoice.mutateAsync({
        id,
        data: {
          expectedRevision: fix.expectedRevision,
          invoiceNumber: fix.invoiceNumber.trim(),
          issueDate: fix.issueDate,
          dueDate: fix.dueDate || null,
          lines: toInvoiceLineInputs(fix.lines),
        },
      });
      setFix((current) =>
        current
          ? { ...current, expectedRevision: updated.invoice.contentRevision }
          : null,
      );
      contentSaved = true;
      // A failed invoice retries the transmission directly (failed → submitted
      // is the legal transition); an edited draft — a validated invoice reverts
      // to draft on edit — must re-validate first, because draft → submitted is
      // not a legal transition.
      if (updated.invoice.status !== "failed") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          setValidationErrors(res.errors);
          refreshInvoiceState();
          toast({
            title: "Validation failed",
            description: `${res.errors.length} issue${res.errors.length === 1 ? "" : "s"} to fix — the full list is on this page.`,
            variant: "destructive",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      setFix(null);
      setValidationErrors([]);
      refreshInvoiceState();
      toast({
        title:
          tone === "failed"
            ? "Corrected and resubmitted"
            : "Submitted for stamping",
        description: submittedToastDescription(me?.features),
      });
    } catch (e) {
      // The PATCH may have landed even when the resubmit failed — refresh so
      // the page shows whatever state the server actually reached.
      refreshInvoiceState();
      if (!contentSaved && errorStatus(e) === 409) {
        await refetch();
        setFixConflict(true);
      }
      toast({
        title: contentSaved
          ? "Changes saved; submission incomplete"
          : "Could not save changes",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  return {
    validate,
    submit,
    updateInvoice,
    explainFailure,
    fix,
    setFix,
    fixConflict,
    setFixConflict,
    showFixErrors,
    validationErrors,
    confirmSubmit,
    setConfirmSubmit,
    fixErrors,
    handleSubmit,
    openFix,
    handleFixResubmit,
  };
}

export function useAdjustFlow({
  id,
  data,
  invoice,
  me,
  errorCode,
  toast,
  queryClient,
  refreshInvoiceState,
  navigate,
}: {
  id: string;
  data: InvoiceDetailData | undefined;
  invoice: Invoice | undefined;
  me: Me | undefined;
  errorCode: string | undefined;
  toast: Toast;
  queryClient: QueryClient;
  refreshInvoiceState: () => void;
  navigate: (to: string) => void;
}) {
  const escalate = useEscalateInvoice();
  const cancelInvoice = useCancelInvoice();
  const creditNote = useCreditNoteInvoice();
  const createConfirmation = useCreateConfirmation();

  const [reason, setReason] = useState("");
  const [showEscalate, setShowEscalate] = useState(false);
  // CORE-09 adjustment dialog: cancel or credit-note, both reason-first.
  const [adjustKind, setAdjustKind] = useState<"cancel" | "credit" | null>(
    null,
  );
  const [adjustReason, setAdjustReason] = useState("");
  // "New from this invoice" overwrite guard: only shown when the stored
  // invoice-form draft already holds real work.
  const [confirmNewFrom, setConfirmNewFrom] = useState(false);

  const closeAdjust = () => {
    setAdjustKind(null);
    setAdjustReason("");
  };

  const handleEscalate = async () => {
    if (!reason.trim()) return;
    try {
      await escalate.mutateAsync({
        id,
        data: { reason: reason.trim(), errorCode },
      });
      setReason("");
      setShowEscalate(false);
      queryClient.invalidateQueries({
        queryKey: getListEscalationsQueryKey(id),
      });
      toast({
        title: "Escalated to your firm",
        description: "An operator will pick this up.",
      });
    } catch (e) {
      toast({
        title: "Could not escalate",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const handleAdjust = async () => {
    if (!adjustKind || !adjustReason.trim()) return;
    try {
      if (adjustKind === "cancel") {
        await cancelInvoice.mutateAsync({
          id,
          data: { reason: adjustReason.trim() },
        });
        toast({
          title: "Invoice cancelled",
          description: "The cancellation is recorded on the lifecycle ledger.",
        });
      } else {
        const cn = await creditNote.mutateAsync({
          id,
          data: { reason: adjustReason.trim() },
        });
        toast({
          title: `Credit note ${cn.invoiceNumber} submitted`,
          description:
            "This invoice becomes Credited when the credit note is stamped.",
        });
      }
      setAdjustKind(null);
      setAdjustReason("");
      refreshInvoiceState();
    } catch (e) {
      toast({
        title:
          adjustKind === "cancel"
            ? "Could not cancel invoice"
            : "Could not issue credit note",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const handleRequestConfirmation = async () => {
    if (!invoice) return;
    try {
      await createConfirmation.mutateAsync({
        id,
        data: { buyerPartyId: invoice.buyerPartyId, state: "requested" },
      });
      queryClient.invalidateQueries({
        queryKey: getListConfirmationsQueryKey(id),
      });
      toast({
        title: "Confirmation requested",
        description:
          "Your customer will be asked to confirm receipt of this invoice.",
      });
    } catch (e) {
      toast({
        title: "Could not request confirmation",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  // "New from this invoice": seed the invoice form's offline draft (the same
  // DRAFT_KEY the form autosaves to) with this invoice's customer and lines,
  // leaving the number blank so a fresh one is assigned. Quantities and prices
  // are wire strings already, so they map 1:1; vatRate is normalised to the
  // form's canonical fraction ("0.075" / "0") so the VAT select matches.
  const buildDraftFromInvoice = (): DraftState | null => {
    if (!invoice) return null;
    const lines = (data?.lines ?? []).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vatRate: String(Number(l.vatRate)),
    }));
    return {
      invoiceNumber: "",
      buyerPartyId: invoice.buyerPartyId,
      issueDate: todayIsoDate(),
      dueDate: "",
      currency: invoice.currency || "NGN",
      fxRateToNgn: invoice.fxRateToNgn ?? "",
      // Deliberately NOT copied: the WHT category is a per-document,
      // human-picked fact (never pre-selected), so the new draft starts at
      // "No WHT" even when this invoice carries a category.
      whtCategory: "",
      lines: lines.length > 0 ? lines : [emptyLine()],
    };
  };

  // A stored draft with real work must be asked about before replacing.
  // The form's draft lives in localStorage (with a pre-move sessionStorage
  // fallback) — check BOTH homes, or a durable draft gets silently shadowed.
  // The shared parser applies the form's own work threshold and removes
  // expired or corrupt records before this replacement decision is made.
  const storedDraftHasWork = (): boolean => {
    if (!me) return false;
    return storedInvoiceDraftHasWork(draftStorageKey(me.userId, me.firmId));
  };

  const startNewFromInvoice = () => {
    const draft = buildDraftFromInvoice();
    if (!draft || !invoice || !me) return;
    const key = draftStorageKey(me.userId, me.firmId);
    // Seed through the same expiring envelope that the form autosaves.
    if (!saveInvoiceDraft(key, draft)) {
      toast({
        title: "Could not create a local draft",
        description:
          "Your browser blocked device storage. Allow site storage, then try again.",
        variant: "destructive",
      });
      return;
    }
    toast({
      title: "New invoice drafted",
      description: `Copied from ${invoice.invoiceNumber} — give it a new invoice number.`,
    });
    navigate("/invoices/new");
  };

  const handleNewFromInvoice = () => {
    if (storedDraftHasWork()) {
      setConfirmNewFrom(true);
      return;
    }
    startNewFromInvoice();
  };

  return {
    escalate,
    cancelInvoice,
    creditNote,
    createConfirmation,
    reason,
    setReason,
    showEscalate,
    setShowEscalate,
    adjustKind,
    setAdjustKind,
    adjustReason,
    setAdjustReason,
    confirmNewFrom,
    setConfirmNewFrom,
    closeAdjust,
    handleEscalate,
    handleAdjust,
    handleRequestConfirmation,
    buildDraftFromInvoice,
    storedDraftHasWork,
    startNewFromInvoice,
    handleNewFromInvoice,
  };
}
