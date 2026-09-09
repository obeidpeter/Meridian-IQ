// The SME invoice detail page (R120 split the 2,157-line file into this
// shell, one module per card, the adjust dialog, the status meta and the
// pure helpers). The route (App.tsx) and the unit suite
// (invoice-detail.test.tsx) keep importing "@/pages/invoice-detail" /
// "./invoice-detail": this module is the page's surface.

import { useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import {
  useGetInvoice,
  useGetParty,
  getGetPartyQueryKey,
  useListSubmissionAttempts,
  useGetInvoiceStamp,
  useListEscalations,
  useGetErrorCatalogueEntry,
  useGetMe,
  useValidateInvoice,
  useSubmitInvoice,
  useUpdateInvoice,
  useExplainInvoiceFailure,
  useEscalateInvoice,
  useCancelInvoice,
  useCreditNoteInvoice,
  useListConfirmations,
  useCreateConfirmation,
  useListSettlements,
  useGetInvoiceStatusLight,
  useGetInvoiceRejectionRisk,
  getGetInvoicePdfUrl,
  getGetInvoiceRejectionRiskQueryKey,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStampQueryKey,
  getListEscalationsQueryKey,
  getGetErrorCatalogueEntryQueryKey,
  getListConfirmationsQueryKey,
  getListSettlementsQueryKey,
  getGetInvoiceStatusLightQueryKey,
  type FieldError as ApiFieldError,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import {
  isFeatureDisabled,
  errorStatus,
  serverErrorMessage,
} from "@/lib/errors";
import { EmptyState } from "@/components/empty-state";
import { RejectionRiskCard } from "@/components/rejection-risk-card";
import { QueryError } from "@/components/query-error";
import {
  draftStorageKey,
  saveInvoiceDraft,
  storedInvoiceDraftHasWork,
  type DraftState,
} from "@/lib/invoice-draft";
import { FixInvoiceForm, type FixDraft } from "./fix-form";
import { InvoiceRoomCard } from "@/components/invoice-room-card";
import { ApprovalsCard } from "@/components/invoice-approvals";
import {
  emptyLine,
  invoiceLineErrors,
  todayIsoDate,
  toInvoiceLineInputs,
} from "@/lib/invoice-lines";
import { ERROR_FOCUS } from "@/lib/error-focus";
import { invoicePdfFilename, triggerDownload } from "@/lib/download";
import {
  beginOperation,
  updateOperation,
  operationSessionKey,
  usePinnedItems,
  useRecordRecentItem,
} from "@workspace/web-ui";
import {
  ArrowLeft,
  ShieldCheck,
  Send,
  AlertTriangle,
  Download,
  LifeBuoy,
  Ban,
  Undo2,
  FileQuestion,
  FilePlus,
  Sparkles,
  Wrench,
  Pin,
} from "lucide-react";
import { whtCategoryLabel } from "@workspace/format/wht-copy";
import { nairaApproxLine } from "@/pages/invoices";
import {
  formatAmount,
  formatDate,
  formatPct,
  statusLabel,
  badgeClasses,
  statusTone,
  pillClasses,
  IRN_EXPANSION,
  CSID_EXPANSION,
} from "@/lib/format";
import { submitErrorTitle, submittedToastDescription } from "./helpers";
import {
  EscalationsCard,
  SettlementsCard,
  SubmissionTimeline,
} from "./history-cards";
import { ComplianceStatusCard } from "./compliance-status-card";
import { PaymentReminderCard } from "./payment-reminder-card";
import { ValidationErrorsCard } from "./validation-errors-card";
import { ConfirmationCard } from "./confirmation-card";
import { AdjustDialog } from "./adjust-dialog";

export function InvoiceDetail() {
  const [, params] = useRoute("/invoices/:id");
  const id = params?.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useGetInvoice(id, {
    query: {
      enabled: !!id,
      queryKey: getGetInvoiceQueryKey(id),
      // A submitted invoice resolves rail-side (stamped or failed) with no
      // user action — poll while pending so the page advances on its own
      // instead of freezing on "Pending stamp" until a manual reload.
      refetchInterval: (query) =>
        query.state.data?.invoice.status === "submitted" ? 15_000 : false,
    },
  });
  const invoice = data?.invoice;
  const { data: buyer } = useGetParty(invoice?.buyerPartyId ?? "", {
    query: {
      enabled: !!invoice?.buyerPartyId,
      queryKey: getGetPartyQueryKey(invoice?.buyerPartyId ?? ""),
      retry: false,
    },
  });
  usePageTitle(invoice ? invoice.invoiceNumber : "Invoice");
  const tone = invoice ? statusTone(invoice.status) : "draft";
  // Settled/credited invoices were stamped first, so keep their stamp visible.
  const stampedFamily =
    tone === "stamped" || tone === "settled" || tone === "credited";

  const { data: attempts } = useListSubmissionAttempts(id, {
    query: {
      enabled: !!id,
      queryKey: getListSubmissionAttemptsQueryKey(id),
      // Same rhythm as the invoice itself: the timeline row for the pending
      // attempt resolves with it.
      refetchInterval: invoice?.status === "submitted" ? 15_000 : false,
    },
  });
  const { data: stamp } = useGetInvoiceStamp(id, {
    query: {
      enabled: !!id && stampedFamily,
      queryKey: getGetInvoiceStampQueryKey(id),
    },
  });
  const { data: escalations } = useListEscalations(id, {
    query: { enabled: !!id, queryKey: getListEscalationsQueryKey(id) },
  });
  const { data: confirmations, error: confirmationsError } =
    useListConfirmations(id, {
      query: {
        enabled: !!id,
        queryKey: getListConfirmationsQueryKey(id),
        retry: false,
      },
    });
  const { data: settlements } = useListSettlements(id, {
    query: {
      enabled: !!id,
      queryKey: getListSettlementsQueryKey(id),
      retry: false,
    },
  });
  // Progressive enhancement: if the light can't load, the card simply doesn't
  // render — it must never break the rest of the page.
  const { data: statusLight, isLoading: statusLightLoading } =
    useGetInvoiceStatusLight(id, {
      query: {
        enabled: !!id,
        queryKey: getGetInvoiceStatusLightQueryKey(id),
        retry: false,
        staleTime: 30_000,
        // Same rhythm as the invoice itself: when the rail answers, the
        // light's story must advance with the badge, not lag a remount.
        refetchInterval: invoice?.status === "submitted" ? 15_000 : false,
      },
    });
  // Draft-time rejection risk (contract 0.36.0): only fetched while the
  // invoice can still be edited before its first submission — once it is on
  // the rail the attempt history speaks for itself. Same posture as the
  // status light: render on success only, any error means no card.
  const riskEligible =
    invoice?.status === "draft" || invoice?.status === "validated";
  const { data: rejectionRisk } = useGetInvoiceRejectionRisk(id, {
    query: {
      enabled: !!id && riskEligible,
      queryKey: getGetInvoiceRejectionRiskQueryKey(id),
      retry: false,
      staleTime: 30_000,
    },
  });

  // The API lists attempts oldest-first; rows of one try share attemptNo
  // and the terminal answer comes LAST (a failover leaves the first rail's
  // error beside the rejection), so among the highest attemptNo keep the
  // later row.
  const latestFailed = (attempts || [])
    .filter(
      (a) => (a.status === "rejected" || a.status === "error") && a.errorCode,
    )
    .reduce<
      (typeof attempts extends (infer T)[] | undefined ? T : never) | undefined
    >((best, a) => (!best || a.attemptNo >= best.attemptNo ? a : best), undefined);
  const errorCode = latestFailed?.errorCode || undefined;
  const { data: catalogue } = useGetErrorCatalogueEntry(errorCode || "", {
    query: {
      enabled: !!errorCode && tone === "failed",
      queryKey: getGetErrorCatalogueEntryQueryKey(errorCode || ""),
    },
  });

  const validate = useValidateInvoice();
  const submit = useSubmitInvoice();
  const updateInvoice = useUpdateInvoice();
  const explainFailure = useExplainInvoiceFailure();
  const escalate = useEscalateInvoice();
  const cancelInvoice = useCancelInvoice();
  const creditNote = useCreditNoteInvoice();
  const createConfirmation = useCreateConfirmation();
  const { data: me } = useGetMe();
  const pinnedInvoices = usePinnedItems(
    me ? `meridianiq:pinned-invoices:${me.userId}` : null,
  );
  const operationKey = operationSessionKey(me);

  // Recognition over recall: the command menu offers the last few invoices
  // this user opened; record this one once it resolves.
  useRecordRecentItem(
    me ? `meridianiq:recent-invoices:${me.userId}` : null,
    invoice
      ? {
          id,
          label: invoice.invoiceNumber,
          detail: statusLabel(invoice.status),
        }
      : null,
  );

  const [reason, setReason] = useState("");
  const [showEscalate, setShowEscalate] = useState(false);
  // "Fix & resubmit" (fix-and-retry): an editable copy of the failed
  // invoice's content, seeded when the form opens. Null = form closed.
  const [fix, setFix] = useState<FixDraft | null>(null);
  const [fixConflict, setFixConflict] = useState(false);
  const [showFixErrors, setShowFixErrors] = useState(false);
  // Held validation failures from the last submit attempt: the full list
  // survives the toast. Cleared on the next submit and on a successful
  // fix-and-submit.
  const [validationErrors, setValidationErrors] = useState<ApiFieldError[]>([]);
  // CORE-09 adjustment dialog: cancel or credit-note, both reason-first.
  const [adjustKind, setAdjustKind] = useState<"cancel" | "credit" | null>(
    null,
  );
  const [adjustReason, setAdjustReason] = useState("");
  // "New from this invoice" overwrite guard: only shown when the stored
  // invoice-form draft already holds real work.
  const [confirmNewFrom, setConfirmNewFrom] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const closeAdjust = () => {
    setAdjustKind(null);
    setAdjustReason("");
  };

  // The invoice and its attempt history refresh together after anything that
  // may have moved the lifecycle. Deliberately NOT awaited at any call site:
  // a background refetch rejection must not mask the toast the handler is
  // about to show, nor turn an already-landed mutation into a false failure.
  const refreshInvoiceState = () => {
    queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
    queryClient.invalidateQueries({
      queryKey: getListSubmissionAttemptsQueryKey(id),
    });
    // The status-light card narrates the same lifecycle ("has not been
    // submitted yet") — left stale it flatly contradicts the badge the
    // instant after submitting (2026-08 cognitive walkthrough, step A9).
    queryClient.invalidateQueries({
      queryKey: getGetInvoiceStatusLightQueryKey(id),
    });
  };

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-9 w-44" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError && errorStatus(error) !== 404) {
    // A fetch failure (network blip, 5xx) is not a missing invoice — show the
    // shared destructive error state with a retry, matching the other apps.
    return (
      <div className="space-y-6">
        <Link
          href="/invoices"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to
          vault
        </Link>
        <QueryError thing="this invoice" onRetry={() => refetch()} />
      </div>
    );
  }

  if (isError || !invoice) {
    // Genuinely missing record (404): neutral not-found card.
    return (
      <div className="space-y-6">
        <Link
          href="/invoices"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to
          vault
        </Link>
        <Card data-testid="card-unknown-invoice">
          <EmptyState
            icon={FileQuestion}
            title="We couldn't find this invoice"
            testId="text-error"
            description="It may have been removed, or the link may be out of date."
          >
            <Button asChild className="mt-2">
              <Link href="/invoices">Back to vault</Link>
            </Button>
          </EmptyState>
        </Card>
      </div>
    );
  }

  // draft/validated submit for the first time; failed retries the transmission
  // (failed → submitted is a legal lifecycle transition — the fix-and-retry
  // flow below is for when the content itself needs correcting first).
  const canSubmit = ["draft", "validated", "failed"].includes(invoice.status);
  // Same capability the explain-failure route checks. The catalogue card
  // renders regardless; only Clerk's rephrasing needs the capability.
  const canClerkExplain = !!me?.capabilities.includes("clerk.capture");
  // Which fields the rail's error code implicates — those inputs get a
  // "flagged" pill so the user knows where to look first.
  const focus = ERROR_FOCUS[errorCode ?? ""] ?? [];
  // CORE-09: cancellation is allowed from any non-terminal, non-inflight state;
  // a credit note adjusts a stamped/confirmed/settled invoice. Mirrors the
  // server's lifecycle TRANSITIONS map — the server still has the final say.
  const canCancel = [
    "draft",
    "validated",
    "failed",
    "stamped",
    "confirmed",
  ].includes(invoice.status);
  const canCredit =
    invoice.kind === "invoice" &&
    ["stamped", "confirmed", "settled"].includes(invoice.status);
  const confirmationsDark = isFeatureDisabled(confirmationsError);
  const confirmationTimeline = [...(confirmations || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const latestConfirmation =
    confirmationTimeline[confirmationTimeline.length - 1];
  const canRequestConfirmation =
    !confirmationsDark &&
    invoice.status === "stamped" &&
    (!latestConfirmation ||
      (latestConfirmation.state !== "requested" &&
        latestConfirmation.state !== "confirmed"));

  const fixForm = fix ? (
    <FixInvoiceForm
      fix={fix}
      setFix={setFix}
      invoice={invoice}
      lines={data?.lines ?? []}
      tone={tone}
      fixConflict={fixConflict}
      setFixConflict={setFixConflict}
      showFixErrors={showFixErrors}
      fixErrors={fixErrors}
      focus={focus}
      onReload={openFix}
      onResubmit={handleFixResubmit}
      pending={
        updateInvoice.isPending || validate.isPending || submit.isPending
      }
    />
  ) : null;

  return (
    <div className="space-y-6">
      <Link
        href="/invoices"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to vault
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1
              className="text-2xl md:text-3xl font-bold"
              data-testid="text-page-title"
            >
              {invoice.invoiceNumber}
            </h1>
            <span className={badgeClasses(invoice.status)}>
              {statusLabel(invoice.status)}
            </span>
          </div>
          <p className="text-muted-foreground mt-1">
            Issued {formatDate(invoice.issueDate)} · Due{" "}
            {formatDate(invoice.dueDate)}
          </p>
          {/* WHT Desk: shown only when a human assigned a category — the
              label wording comes from the shared wht-copy catalogue. */}
          {invoice.whtCategory && (
            <p
              className="text-sm text-muted-foreground mt-1"
              data-testid="text-invoice-wht-category"
            >
              WHT category: {whtCategoryLabel(invoice.whtCategory)}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            <Link
              href="/help#stamping"
              className="font-bold text-teal-800 underline underline-offset-2"
              data-testid="link-help-stamping"
            >
              What does stamping mean?
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={pinnedInvoices.isPinned(id)}
            onClick={() =>
              pinnedInvoices.toggle({
                id,
                label: invoice.invoiceNumber,
                detail: statusLabel(invoice.status),
              })
            }
            data-testid="button-pin-invoice"
          >
            <Pin
              className={`w-4 h-4 mr-2 ${pinnedInvoices.isPinned(id) ? "fill-current" : ""}`}
              aria-hidden="true"
            />
            {pinnedInvoices.isPinned(id) ? "Pinned" : "Pin"}
          </Button>
          {canSubmit && (
            <Button
              onClick={() => setConfirmSubmit(true)}
              disabled={validate.isPending || submit.isPending}
            >
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              {validate.isPending || submit.isPending
                ? "Submitting…"
                : invoice.status === "failed"
                  ? "Retry transmission"
                  : "Submit for stamping"}
            </Button>
          )}
          {(invoice.status === "draft" || invoice.status === "validated") &&
            !fix && (
              <Button
                variant="outline"
                onClick={openFix}
                data-testid="button-edit-invoice"
              >
                <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Edit
                invoice
              </Button>
            )}
          {/* Every invoice has a PDF — the server watermarks unstamped ones —
              so the button is always offered. Same idiom as the vault's CSV
              export: a plain same-origin navigation, auth on the session
              cookie, but via a named-download anchor so the file saves as
              invoice-<number>.pdf. */}
          <Button
            variant="outline"
            onClick={() =>
              triggerDownload(
                getGetInvoicePdfUrl(id),
                invoicePdfFilename(invoice.invoiceNumber),
              )
            }
            data-testid="button-download-pdf"
          >
            <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Download
            PDF
          </Button>
          {canCredit && (
            <Button
              variant="outline"
              onClick={() => setAdjustKind("credit")}
              data-testid="button-credit-note"
            >
              <Undo2 className="w-4 h-4 mr-2" aria-hidden="true" /> Issue credit
              note
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setAdjustKind("cancel")}
              data-testid="button-cancel-invoice"
            >
              <Ban className="w-4 h-4 mr-2" aria-hidden="true" /> Cancel invoice
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleNewFromInvoice}
            data-testid="button-new-from-invoice"
          >
            <FilePlus className="w-4 h-4 mr-2" aria-hidden="true" /> New from
            this invoice
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmSubmit} onOpenChange={setConfirmSubmit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review stamping submission</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm the target and tax totals before this invoice is sent to
              the configured e-invoicing rail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="divide-y rounded-md border bg-muted/25 px-3 text-sm">
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Invoice</dt>
              <dd className="text-right font-medium">
                {invoice.invoiceNumber}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Customer</dt>
              <dd className="max-w-[65%] text-right font-medium">
                {buyer?.legalName ??
                  `Party ${invoice.buyerPartyId.slice(0, 8)}`}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Invoice total</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatAmount(invoice.grandTotal, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">VAT included</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatAmount(invoice.vatTotal, invoice.currency)}
              </dd>
            </div>
          </dl>
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            Once the rail accepts and stamps this invoice, corrections require
            the cancellation or credit-note workflow. Do not submit while the
            customer, amount, currency, or VAT is still being checked.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back and review</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmSubmit(false);
                void handleSubmit();
              }}
              data-testid="button-confirm-submit"
            >
              Confirm and submit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmNewFrom} onOpenChange={setConfirmNewFrom}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your saved draft?</AlertDialogTitle>
            <AlertDialogDescription>
              You already have an unfinished invoice draft. Starting a new
              invoice from {invoice.invoiceNumber} replaces that draft — this
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my draft</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmNewFrom(false);
                startNewFromInvoice();
              }}
              data-testid="button-confirm-new-from-invoice"
            >
              Replace draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AdjustDialog
        kind={adjustKind}
        reason={adjustReason}
        onReasonChange={setAdjustReason}
        onClose={closeAdjust}
        onConfirm={handleAdjust}
        isPending={cancelInvoice.isPending || creditNote.isPending}
      />

      <ComplianceStatusCard
        statusLight={statusLight}
        isLoading={statusLightLoading}
      />

      {/* Maker-checker ledger: informational for client users, actionable
          for firm roles while the invoice is still submittable. */}
      <ApprovalsCard
        invoiceId={id}
        role={me?.role}
        status={invoice.status}
        contentRevision={invoice.contentRevision}
      />

      {/* Advisory only, gated on the same still-editable statuses as the
          query so a cached report never outlives a submission. */}
      {riskEligible && rejectionRisk && (
        <RejectionRiskCard report={rejectionRisk} />
      )}

      {stampedFamily && stamp && (
        <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
              <ShieldCheck className="w-4 h-4" aria-hidden="true" /> FIRS
              stamped
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">
                IRN ({IRN_EXPANSION})
              </span>
              <span className="font-mono text-xs break-all text-right">
                {stamp.irn}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">
                CSID ({CSID_EXPANSION})
              </span>
              <span className="font-mono text-xs break-all text-right">
                {stamp.csid}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Chase-payment card: the receivables definition exactly — issued to
          the buyer, payment not yet observed. Same capability as the other
          Clerk phrasings on this page. */}
      {canClerkExplain &&
        invoice.kind === "invoice" &&
        ["submitted", "stamped", "confirmed"].includes(invoice.status) && (
          <PaymentReminderCard invoice={invoice} />
        )}

      {tone === "failed" && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />{" "}
              Submission failed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {catalogue ? (
              <>
                <div>
                  <p className="font-medium">What went wrong</p>
                  <p className="text-muted-foreground">{catalogue.cause}</p>
                </div>
                <div>
                  <p className="font-medium">How to fix it</p>
                  <p className="text-muted-foreground">{catalogue.fix}</p>
                </div>
                {errorCode && (
                  <p className="text-xs text-muted-foreground">
                    Reference code:{" "}
                    <span className="font-mono">{errorCode}</span>
                    {catalogue.retriable ? " · retriable" : " · not retriable"}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                This invoice was rejected
                {errorCode ? ` (code ${errorCode})` : ""}. Escalate to your firm
                for hands-on help.
              </p>
            )}

            {/* Clerk's plain-language read: button-triggered (never auto —
                a page view must not spend tokens), grounded server-side in
                the same catalogue entry shown above. */}
            {canClerkExplain &&
              (explainFailure.data ? (
                <div className="rounded-lg border bg-background p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium">Clerk&apos;s explanation</p>
                    <span
                      className={pillClasses(
                        explainFailure.data.source === "clerk"
                          ? "blue"
                          : "slate",
                      )}
                    >
                      {explainFailure.data.source === "clerk"
                        ? "Clerk-phrased"
                        : "Catalogue text"}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {explainFailure.data.explanation}
                  </p>
                  <ol className="list-decimal ml-4 space-y-1 text-muted-foreground">
                    {explainFailure.data.nextSteps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : (
                <div className="space-y-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      explainFailure.mutate({ data: { invoiceId: id } })
                    }
                    disabled={explainFailure.isPending}
                    data-testid="button-explain-failure"
                  >
                    <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
                    {explainFailure.isPending
                      ? "Asking Clerk…"
                      : "Explain in plain language"}
                  </Button>
                  {explainFailure.isError && (
                    <p className="text-xs text-muted-foreground">
                      Clerk couldn&apos;t add anything — the guidance above
                      still applies.
                    </p>
                  )}
                </div>
              ))}

            {/* Fix & resubmit: edit the failed invoice's content in place
                (PATCH keeps it failed), then resubmit (failed → submitted). */}
            {fixForm}

            {!showEscalate ? (
              <div className="flex flex-wrap gap-2">
                {!fix && (
                  <Button
                    size="sm"
                    onClick={openFix}
                    data-testid="button-open-fix"
                  >
                    <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Fix &
                    resubmit
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEscalate(true)}
                >
                  <LifeBuoy className="w-4 h-4 mr-2" aria-hidden="true" />{" "}
                  Escalate to my firm
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="escalate-reason" className="sr-only">
                  What you've already tried
                </Label>
                <Textarea
                  id="escalate-reason"
                  placeholder="Describe what you've already tried…"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleEscalate}
                    disabled={escalate.isPending || !reason.trim()}
                  >
                    {escalate.isPending ? "Sending…" : "Send to firm"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowEscalate(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <ValidationErrorsCard
        errors={validationErrors}
        onFix={openFix}
        showFixButton={!fix}
      />

      {tone !== "failed" && fixForm && (
        <Card data-testid="card-edit-invoice">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="w-4 h-4" aria-hidden="true" /> Edit invoice
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{fixForm}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data?.lines.map((l) => (
            <div
              key={l.id}
              className="flex justify-between text-sm border-b last:border-0 py-2"
            >
              <div>
                <p className="font-medium">{l.description}</p>
                <p className="text-muted-foreground text-xs">
                  {l.quantity} × {formatAmount(l.unitPrice, invoice.currency)} ·
                  VAT {formatPct(l.vatRate)}
                </p>
              </div>
              <span className="font-medium tabular-nums">
                {formatAmount(
                  Number(l.lineExtension) + Number(l.vatAmount),
                  invoice.currency,
                )}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">
              {formatAmount(invoice.grandTotal, invoice.currency)}
            </span>
          </div>
          {nairaApproxLine(invoice) && (
            <p
              className="text-right text-xs text-muted-foreground tabular-nums"
              data-testid="text-total-ngn-equivalent"
            >
              {nairaApproxLine(invoice)} at the rate captured when this invoice
              was issued (₦
              {Number(invoice.fxRateToNgn).toLocaleString("en-NG", {
                maximumFractionDigits: 4,
              })}{" "}
              per {invoice.currency})
            </p>
          )}
        </CardContent>
      </Card>

      <ConfirmationCard
        invoice={invoice}
        timeline={confirmationTimeline}
        featureDisabled={confirmationsDark}
        canRequest={canRequestConfirmation}
        onRequest={handleRequestConfirmation}
        isPending={createConfirmation.isPending}
      />

      {me?.features.includes("invoice_room") && stampedFamily && (
        <InvoiceRoomCard
          invoiceId={id}
          invoiceNumber={invoice.invoiceNumber}
          buyerName={buyer?.legalName ?? "Buyer"}
        />
      )}

      {settlements && settlements.length > 0 && (
        <SettlementsCard settlements={settlements} />
      )}

      {attempts && attempts.length > 0 && (
        <SubmissionTimeline attempts={attempts} />
      )}

      {escalations && escalations.length > 0 && (
        <EscalationsCard escalations={escalations} />
      )}
    </div>
  );
}

// The unit suite pins these through this module, so the split keeps the
// page's import path as its surface.
export { PaymentReminderCard } from "./payment-reminder-card";
export { ValidationErrorsCard } from "./validation-errors-card";
export { submitErrorTitle, submittedToastDescription } from "./helpers";
export {
  ApprovalsCard,
  canApproveInvoice,
} from "@/components/invoice-approvals";
