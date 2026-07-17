import { useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import {
  useGetInvoice,
  useListSubmissionAttempts,
  useGetInvoiceStamp,
  useListEscalations,
  useGetErrorCatalogueEntry,
  useGetMe,
  useValidateInvoice,
  useSubmitInvoice,
  useUpdateInvoice,
  useExplainInvoiceFailure,
  useDraftPaymentChaser,
  useRecordChaseReminder,
  useListPaymentBehaviour,
  getListPaymentBehaviourQueryKey,
  useEscalateInvoice,
  useCancelInvoice,
  useCreditNoteInvoice,
  useListConfirmations,
  useCreateConfirmation,
  useListSettlements,
  useGetInvoiceStatusLight,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStampQueryKey,
  getListEscalationsQueryKey,
  getGetErrorCatalogueEntryQueryKey,
  getListConfirmationsQueryKey,
  getListSettlementsQueryKey,
  getGetInvoiceStatusLightQueryKey,
} from "@workspace/api-client-react";
import type {
  Confirmation,
  Escalation,
  Invoice,
  SettlementEvent,
  StatusLight,
  StatusLightLight,
  SubmissionAttempt,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { isFeatureDisabled, errorStatus, serverErrorMessage } from "@/lib/errors";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { DRAFT_KEY, type DraftState } from "@/pages/invoice-new";
import { LineItemRow } from "@/components/line-item-row";
import { FieldError } from "@/components/field-error";
import {
  emptyLine,
  lineTotals,
  todayIsoDate,
  toInvoiceLineInputs,
  updateLineAt,
  type LineDraft,
} from "@/lib/invoice-lines";
import { ERROR_FOCUS } from "@/lib/error-focus";
import {
  ArrowLeft,
  ShieldCheck,
  Send,
  AlertTriangle,
  LifeBuoy,
  CheckCircle2,
  Clock,
  XCircle,
  MailCheck,
  Banknote,
  Ban,
  Undo2,
  FileQuestion,
  FilePlus,
  Sparkles,
  Wrench,
  Plus,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  formatDateTime,
  formatPct,
  statusLabel,
  badgeClasses,
  statusTone,
  humanize,
  pillClasses,
  confirmationLabel,
  confirmationBadgeClasses,
} from "@/lib/format";

// AI Feature Brief §3.3: deterministic green/amber/red light with plain-language
// reasons and ONE recommended action. Icon + word pair with the colour so the
// colour is never the only signal.
const LIGHT_META: Record<
  StatusLightLight,
  {
    label: string;
    Icon: typeof CheckCircle2;
    dot: string;
    text: string;
  }
> = {
  green: {
    label: "Green",
    Icon: CheckCircle2,
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  amber: {
    label: "Amber",
    Icon: AlertTriangle,
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  red: {
    label: "Red",
    Icon: XCircle,
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
  },
};

const SETTLEMENT_SOURCE_LABELS: Record<string, string> = {
  statement_match: "Statement match",
  buyer_flag: "Buyer flag",
  collection_account: "Collection account",
  uploaded_evidence: "Uploaded evidence",
};

// Deterministic status-light card: skeleton while loading, the light with its
// reasons and recommended action once it resolves, nothing on failure.
function ComplianceStatusCard({
  statusLight,
  isLoading,
}: {
  statusLight: StatusLight | undefined;
  isLoading: boolean;
}) {
  const lightMeta = statusLight ? LIGHT_META[statusLight.light] : null;
  const LightIcon = lightMeta?.Icon;

  if (isLoading) {
    return (
      <Card data-testid="card-compliance-status">
        <CardHeader>
          <CardTitle className="text-base">Compliance status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </CardContent>
      </Card>
    );
  }

  if (statusLight && lightMeta && LightIcon) {
    return (
      <Card data-testid="card-compliance-status">
        <CardHeader>
          <CardTitle className="text-base">Compliance status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${lightMeta.dot}`}
              aria-hidden="true"
            />
            <LightIcon
              className={`w-4 h-4 ${lightMeta.text}`}
              aria-hidden="true"
            />
            <span
              className={`font-semibold ${lightMeta.text}`}
              data-testid="text-status-light"
            >
              {lightMeta.label}
            </span>
          </div>
          {statusLight.reasons.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
              {statusLight.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <p data-testid="text-recommended-action">
            <span className="font-medium">Recommended action:</span>{" "}
            <span className="text-muted-foreground">
              {statusLight.recommendedAction}
            </span>
          </p>
        </CardContent>
      </Card>
    );
  }

  return null;
}

// Reason-first cancel / credit-note dialog. Controlled by the parent, which
// owns the kind/reason state, the mutations, and their toasts/invalidations.
function AdjustDialog({
  kind,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
  isPending,
}: {
  kind: "cancel" | "credit" | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "cancel" ? "Cancel this invoice" : "Issue a credit note"}
          </DialogTitle>
          <DialogDescription>
            {kind === "cancel"
              ? "Cancellation is a recorded lifecycle event. A cancelled invoice can never be presented as eligible again."
              : "A credit note referencing this invoice is created and submitted for stamping. Once stamped, this invoice becomes Credited — a terminal, recorded state."}
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="adjust-reason" className="sr-only">
            Reason
          </Label>
          <Textarea
            id="adjust-reason"
            placeholder="Reason (required — it is recorded on the ledger)"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            data-testid="input-adjust-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep invoice
          </Button>
          <Button
            variant={kind === "cancel" ? "destructive" : "default"}
            disabled={!reason.trim() || isPending}
            onClick={onConfirm}
            data-testid="button-confirm-adjust"
          >
            {isPending
              ? "Working…"
              : kind === "cancel"
                ? "Cancel invoice"
                : "Issue credit note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Buyer-confirmation card: request button plus the confirmation timeline. The
// parent keeps the mutation and the can-request lifecycle predicate.
function ConfirmationCard({
  invoice,
  timeline,
  featureDisabled,
  canRequest,
  onRequest,
  isPending,
}: {
  invoice: Invoice;
  timeline: Confirmation[];
  featureDisabled: boolean;
  canRequest: boolean;
  onRequest: () => void;
  isPending: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <MailCheck className="w-4 h-4" aria-hidden="true" /> Buyer confirmation
        </CardTitle>
        {canRequest && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRequest}
            disabled={isPending}
          >
            <Send className="w-4 h-4 mr-2" aria-hidden="true" />
            {isPending ? "Requesting…" : "Request confirmation"}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {featureDisabled ? (
          <p className="text-sm text-muted-foreground">
            Buyer confirmations are not yet enabled for this organization. Ask your
            operator to enable it.
          </p>
        ) : timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No confirmation activity yet.
            {invoice.status === "stamped"
              ? " Request a confirmation so your buyer acknowledges this invoice."
              : " Confirmations open up once the invoice is stamped."}
          </p>
        ) : (
          <div>
            {timeline.map((c, i) => (
              <div key={c.id} className="relative pl-6 pb-4 last:pb-0">
                {i < timeline.length - 1 && (
                  <span className="absolute left-[5px] top-4 bottom-0 w-px bg-border" />
                )}
                <span
                  className={`absolute left-0 top-1.5 w-3 h-3 rounded-full border-2 border-background ${
                    c.state === "confirmed"
                      ? "bg-emerald-500"
                      : c.state === "rejected"
                        ? "bg-red-500"
                        : c.state === "queried"
                          ? "bg-blue-500"
                          : "bg-amber-500"
                  }`}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={confirmationBadgeClasses(c.state)}>
                    {confirmationLabel(c.state)}
                  </span>
                  {c.method && (
                    <span className="text-xs text-muted-foreground">
                      via {humanize(c.method)}
                    </span>
                  )}
                  {c.noSetOff && (
                    <span className={pillClasses("slate")}>No set-off</span>
                  )}
                </div>
                {c.note && (
                  <p className="text-sm text-muted-foreground mt-1">{c.note}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDateTime(c.createdAt)}
                  {c.confirmingUserId && (
                    <>
                      {" "}
                      · by <span className="font-mono">{c.confirmingUserId}</span>
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SettlementsCard({ settlements }: { settlements: SettlementEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="w-4 h-4" aria-hidden="true" /> Settlement events
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {settlements.map((s) => (
          <div key={s.id} className="text-sm border rounded-md px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={pillClasses("slate")}>
                  {SETTLEMENT_SOURCE_LABELS[s.source] || humanize(s.source)}
                </span>
                {s.paymentStatus && (
                  <span
                    className={pillClasses(
                      s.paymentStatus === "paid" ? "emerald" : "amber",
                    )}
                  >
                    {humanize(s.paymentStatus)}
                  </span>
                )}
              </div>
              <span className="font-semibold tabular-nums">{formatNaira(s.amount)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formatDateTime(s.occurredAt)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SubmissionTimeline({ attempts }: { attempts: SubmissionAttempt[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Submission timeline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {[...attempts]
          .sort((a, b) => a.attemptNo - b.attemptNo)
          .map((a) => (
            <div key={a.id} className="flex items-start gap-3 text-sm">
              {a.status === "rejected" || a.status === "error" ? (
                <XCircle className="w-4 h-4 text-destructive mt-0.5" aria-hidden="true" />
              ) : a.status === "accepted" ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5" aria-hidden="true" />
              ) : (
                <Clock className="w-4 h-4 text-muted-foreground mt-0.5" aria-hidden="true" />
              )}
              <div>
                <p>
                  Attempt {a.attemptNo} · {humanize(a.status)}{" "}
                  <span className="text-muted-foreground uppercase text-xs">({a.rail})</span>
                </p>
                {a.errorCode && (
                  <p className="text-xs text-destructive font-mono">{a.errorCode}</p>
                )}
                <p className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</p>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function EscalationsCard({ escalations }: { escalations: Escalation[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Escalations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {escalations.map((e) => (
          <div key={e.id} className="text-sm border rounded-md px-3 py-2">
            <div className="flex justify-between">
              <span className="font-medium">{humanize(e.status)}</span>
              <span className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
            </div>
            <p className="text-muted-foreground">{e.reason}</p>
            {e.operatorReply && (
              <div
                className="mt-2 rounded-md bg-muted/60 px-3 py-2"
                data-testid={`escalation-reply-${e.id}`}
              >
                <p className="text-xs font-medium text-muted-foreground">
                  Compliance Desk replied
                  {e.repliedAt ? ` · ${formatDate(e.repliedAt)}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{e.operatorReply}</p>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// Payment-chaser draft (round-9 idea #2): a "chase this" button on an
// outstanding receivable. The letter is drafted server-side from stored
// facts (digest posture — template always answers) and NEVER sent by the
// platform: the client copies it into their own email. The buyer's mined
// payment rhythm renders alongside so the client knows whether this buyer is
// late for THEM before chasing at all.
function PaymentReminderCard({ invoice }: { invoice: Invoice }) {
  const [copied, setCopied] = useState(false);
  const draft = useDraftPaymentChaser();
  // Chase ladder (round-14 idea #3): copying the draft records it as a SENT
  // reminder, so the NEXT draft escalates its tone. Logged on copy only —
  // drafting alone records nothing.
  const logReminder = useRecordChaseReminder();
  const [loggedStage, setLoggedStage] = useState<number | null>(null);
  const { data: behaviour } = useListPaymentBehaviour(
    { clientPartyId: invoice.supplierPartyId },
    {
      query: {
        queryKey: getListPaymentBehaviourQueryKey({
          clientPartyId: invoice.supplierPartyId,
        }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const buyerBehaviour = behaviour?.find(
    (b) => b.buyerPartyId === invoice.buyerPartyId,
  );

  const copyDraft = async () => {
    if (!draft.data) return;
    try {
      await navigator.clipboard.writeText(
        `${draft.data.subject}\n\n${draft.data.body}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Best-effort ladder log: a failure here never blocks the copy. Only
      // the first copy of a given draft logs (loggedStage guards repeats).
      if (loggedStage !== draft.data.stage) {
        logReminder.mutate(
          { invoiceId: invoice.id },
          { onSuccess: (s) => setLoggedStage(s.stage) },
        );
      }
    } catch {
      // Clipboard denied: the text stays on screen to copy by hand.
    }
  };

  return (
    <Card data-testid="payment-reminder">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4" aria-hidden="true" /> Awaiting payment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {buyerBehaviour && (
          <p className="text-muted-foreground" data-testid="payment-rhythm">
            {buyerBehaviour.buyerName} usually pays in about{" "}
            {buyerBehaviour.medianDaysToPay} day(s) (from{" "}
            {buyerBehaviour.settledCount} matched payments).
          </p>
        )}
        {draft.data ? (
          <div className="rounded-lg border bg-background p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium">{draft.data.subject}</p>
              <span
                className={pillClasses(
                  draft.data.source === "clerk" ? "blue" : "slate",
                )}
              >
                {draft.data.source === "clerk" ? "Clerk-phrased" : "Template"}
              </span>
              <span className={pillClasses("slate")} data-testid="chaser-stage">
                Reminder #{draft.data.stage}
              </span>
            </div>
            {draft.data.previousReminders.count > 0 && (
              <p className="text-xs text-muted-foreground">
                {draft.data.previousReminders.count} earlier reminder
                {draft.data.previousReminders.count === 1 ? "" : "s"} logged
                {draft.data.previousReminders.lastAt
                  ? ` — last on ${formatDate(draft.data.previousReminders.lastAt)}`
                  : ""}
                .
              </p>
            )}
            <p className="whitespace-pre-wrap text-muted-foreground">
              {draft.data.body}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyDraft}
                data-testid="button-copy-chaser"
              >
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => draft.mutate({ data: { invoiceId: invoice.id } })}
                disabled={draft.isPending}
              >
                {draft.isPending ? "Redrafting…" : "Redraft"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Review before sending — you send this from your own email;
              nothing is sent for you.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => draft.mutate({ data: { invoiceId: invoice.id } })}
              disabled={draft.isPending}
              data-testid="button-draft-chaser"
            >
              <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
              {draft.isPending ? "Drafting…" : "Draft a payment reminder"}
            </Button>
            {draft.isError && (
              <p className="text-xs text-muted-foreground">
                Couldn&apos;t draft a reminder just now — try again in a
                moment.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InvoiceDetail() {
  const [, params] = useRoute("/invoices/:id");
  const id = params?.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id) },
  });
  const invoice = data?.invoice;
  usePageTitle(invoice ? invoice.invoiceNumber : "Invoice");
  const tone = invoice ? statusTone(invoice.status) : "draft";
  // Settled/credited invoices were stamped first, so keep their stamp visible.
  const stampedFamily =
    tone === "stamped" || tone === "settled" || tone === "credited";

  const { data: attempts } = useListSubmissionAttempts(id, {
    query: { enabled: !!id, queryKey: getListSubmissionAttemptsQueryKey(id) },
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
  const { data: confirmations, error: confirmationsError } = useListConfirmations(id, {
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
      },
    });

  const latestFailed = (attempts || [])
    .filter((a) => (a.status === "rejected" || a.status === "error") && a.errorCode)
    .sort((a, b) => b.attemptNo - a.attemptNo)[0];
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

  const [reason, setReason] = useState("");
  const [showEscalate, setShowEscalate] = useState(false);
  // "Fix & resubmit" (fix-and-retry): an editable copy of the failed
  // invoice's content, seeded when the form opens. Null = form closed.
  const [fix, setFix] = useState<{
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    lines: LineDraft[];
  } | null>(null);
  const [showFixErrors, setShowFixErrors] = useState(false);
  // CORE-09 adjustment dialog: cancel or credit-note, both reason-first.
  const [adjustKind, setAdjustKind] = useState<"cancel" | "credit" | null>(null);
  const [adjustReason, setAdjustReason] = useState("");
  // "New from this invoice" overwrite guard: only shown when the stored
  // invoice-form draft already holds real work.
  const [confirmNewFrom, setConfirmNewFrom] = useState(false);

  const closeAdjust = () => {
    setAdjustKind(null);
    setAdjustReason("");
  };

  const handleSubmit = async () => {
    if (!invoice) return;
    // A new attempt makes any fetched explanation stale: if this submission
    // fails again the error may be different, and yesterday's explanation
    // must not sit next to today's catalogue entry.
    explainFailure.reset();
    try {
      if (invoice.status === "draft") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          // Not awaited: a background refetch rejection must not mask the real
          // validation-failed message below with a generic submission error.
          queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
          queryClient.invalidateQueries({
            queryKey: getListSubmissionAttemptsQueryKey(id),
          });
          toast({
            title: "Validation failed",
            description: res.errors[0]?.message || "Fix the issues and try again.",
            variant: "destructive",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
      queryClient.invalidateQueries({
        queryKey: getListSubmissionAttemptsQueryKey(id),
      });
      toast({
        title: "Submitted for stamping",
        description: "We'll notify you once it clears the rail.",
      });
    } catch (e) {
      toast({
        title: "Submission error",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  // Seed the fix form from what the invoice holds right now. vatRate is
  // normalised through String(Number(...)) ("0.0750" → "0.075") so the VAT
  // select recognises the stored value.
  const openFix = () => {
    if (!invoice) return;
    setFix({
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
      if (!l.description.trim())
        fixErrors[`line-${i}-desc`] = "Description required.";
      if (!(Number(l.quantity) > 0)) fixErrors[`line-${i}-qty`] = "Qty must be > 0.";
      if (!(Number(l.unitPrice) >= 0) || l.unitPrice === "")
        fixErrors[`line-${i}-price`] = "Price required.";
    });
  }

  const handleFixResubmit = async () => {
    if (!fix) return;
    setShowFixErrors(true);
    if (Object.keys(fixErrors).length > 0) return;
    // Same staleness rule as handleSubmit: the explanation belonged to the
    // failure being fixed, not to whatever this resubmission produces.
    explainFailure.reset();
    try {
      await updateInvoice.mutateAsync({
        id,
        data: {
          invoiceNumber: fix.invoiceNumber.trim(),
          issueDate: fix.issueDate,
          dueDate: fix.dueDate || null,
          lines: toInvoiceLineInputs(fix.lines),
        },
      });
      await submit.mutateAsync({ id });
      setFix(null);
      queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
      queryClient.invalidateQueries({
        queryKey: getListSubmissionAttemptsQueryKey(id),
      });
      toast({
        title: "Corrected and resubmitted",
        description: "We'll notify you once it clears the rail.",
      });
    } catch (e) {
      // The PATCH may have landed even when the resubmit failed — refresh so
      // the page shows whatever state the server actually reached.
      queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
      queryClient.invalidateQueries({
        queryKey: getListSubmissionAttemptsQueryKey(id),
      });
      toast({
        title: "Could not resubmit",
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
      queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey(id) });
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
      queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
      queryClient.invalidateQueries({
        queryKey: getListSubmissionAttemptsQueryKey(id),
      });
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
      queryClient.invalidateQueries({ queryKey: getListConfirmationsQueryKey(id) });
      toast({
        title: "Confirmation requested",
        description: "Your buyer will be asked to confirm receipt of this invoice.",
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
      lines: lines.length > 0 ? lines : [emptyLine()],
    };
  };

  // A stored draft with an invoice number, a picked customer, or any
  // filled-in line is real work — ask before replacing it. A corrupt draft
  // reads as empty (the form ignores it too).
  const storedDraftHasWork = (): boolean => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw) as DraftState;
      return Boolean(
        d.invoiceNumber?.trim() ||
          d.buyerPartyId ||
          (d.lines ?? []).some((l) => l.description.trim() || l.unitPrice.trim()),
      );
    } catch {
      return false;
    }
  };

  const startNewFromInvoice = () => {
    const draft = buildDraftFromInvoice();
    if (!draft || !invoice) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
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
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to vault
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
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to vault
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
  const canCancel = ["draft", "validated", "failed", "stamped", "confirmed"].includes(
    invoice.status,
  );
  const canCredit =
    invoice.kind === "invoice" &&
    ["stamped", "confirmed", "settled"].includes(invoice.status);
  const confirmationsDark = isFeatureDisabled(confirmationsError);
  const confirmationTimeline = [...(confirmations || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const latestConfirmation = confirmationTimeline[confirmationTimeline.length - 1];
  const canRequestConfirmation =
    !confirmationsDark &&
    invoice.status === "stamped" &&
    (!latestConfirmation ||
      (latestConfirmation.state !== "requested" &&
        latestConfirmation.state !== "confirmed"));

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
            <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
              {invoice.invoiceNumber}
            </h1>
            <span className={badgeClasses(invoice.status)}>
              {statusLabel(invoice.status)}
            </span>
          </div>
          <p className="text-muted-foreground mt-1">
            Issued {formatDate(invoice.issueDate)} · Due {formatDate(invoice.dueDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSubmit && (
            <Button onClick={handleSubmit} disabled={validate.isPending || submit.isPending}>
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              {validate.isPending || submit.isPending
                ? "Submitting…"
                : invoice.status === "failed"
                  ? "Retry transmission"
                  : "Submit for stamping"}
            </Button>
          )}
          {canCredit && (
            <Button
              variant="outline"
              onClick={() => setAdjustKind("credit")}
              data-testid="button-credit-note"
            >
              <Undo2 className="w-4 h-4 mr-2" aria-hidden="true" /> Issue credit note
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

      <ComplianceStatusCard statusLight={statusLight} isLoading={statusLightLoading} />

      {stampedFamily && stamp && (
        <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
              <ShieldCheck className="w-4 h-4" aria-hidden="true" /> FIRS stamped
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">IRN</span>
              <span className="font-mono text-xs break-all text-right">{stamp.irn}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">CSID</span>
              <span className="font-mono text-xs break-all text-right">{stamp.csid}</span>
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
              <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Submission failed
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
                    Reference code: <span className="font-mono">{errorCode}</span>
                    {catalogue.retriable ? " · retriable" : " · not retriable"}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                This invoice was rejected{errorCode ? ` (code ${errorCode})` : ""}. Escalate to your
                firm for hands-on help.
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
                        explainFailure.data.source === "clerk" ? "blue" : "slate",
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
                    onClick={() => explainFailure.mutate({ data: { invoiceId: id } })}
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
                      Clerk couldn&apos;t add anything — the guidance above still
                      applies.
                    </p>
                  )}
                </div>
              ))}

            {/* Fix & resubmit: edit the failed invoice's content in place
                (PATCH keeps it failed), then resubmit (failed → submitted). */}
            {fix ? (
              <div className="rounded-lg border bg-background p-3 space-y-3" data-testid="fix-form">
                <p className="font-medium">
                  Correct the flagged details, then resubmit
                </p>
                {focus.includes("parties") && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-2 text-amber-800 dark:text-amber-300">
                    The rail rejected a TIN. TINs live on the business and
                    customer records, not on this invoice — ask your firm to
                    correct the record (or escalate below), then retry the
                    transmission.
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="fix-invoice-number" className="flex items-center gap-2">
                      Invoice number
                      {focus.includes("invoiceNumber") && (
                        <span className={pillClasses("amber")}>flagged</span>
                      )}
                    </Label>
                    <Input
                      id="fix-invoice-number"
                      value={fix.invoiceNumber}
                      onChange={(e) =>
                        setFix((f) => f && { ...f, invoiceNumber: e.target.value })
                      }
                      className="mt-1"
                    />
                    {showFixErrors && fixErrors.invoiceNumber && (
                      <FieldError id="fix-invoice-number-error">
                        {fixErrors.invoiceNumber}
                      </FieldError>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="fix-issue-date" className="flex items-center gap-2">
                      Issue date
                      {focus.includes("invoice") && (
                        <span className={pillClasses("amber")}>flagged</span>
                      )}
                    </Label>
                    <Input
                      id="fix-issue-date"
                      type="date"
                      value={fix.issueDate}
                      onChange={(e) =>
                        setFix((f) => f && { ...f, issueDate: e.target.value })
                      }
                      className="mt-1"
                    />
                    {showFixErrors && fixErrors.issueDate && (
                      <FieldError id="fix-issue-date-error">
                        {fixErrors.issueDate}
                      </FieldError>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="fix-due-date">Due date (optional)</Label>
                    <Input
                      id="fix-due-date"
                      type="date"
                      value={fix.dueDate}
                      onChange={(e) =>
                        setFix((f) => f && { ...f, dueDate: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    Line items
                    {focus.includes("lines") && (
                      <span className={pillClasses("amber")}>flagged</span>
                    )}
                  </p>
                  {fix.lines.map((line, i) => (
                    <LineItemRow
                      key={i}
                      index={i}
                      line={line}
                      onPatch={(patch) =>
                        setFix((f) => f && { ...f, lines: updateLineAt(f.lines, i, patch) })
                      }
                      removable={fix.lines.length > 1}
                      onRemove={() =>
                        setFix(
                          (f) =>
                            f && { ...f, lines: f.lines.filter((_, j) => j !== i) },
                        )
                      }
                      errors={
                        showFixErrors
                          ? {
                              description: fixErrors[`line-${i}-desc`],
                              quantity: fixErrors[`line-${i}-qty`],
                              unitPrice: fixErrors[`line-${i}-price`],
                            }
                          : undefined
                      }
                      showTotal
                    />
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setFix((f) => f && { ...f, lines: [...f.lines, emptyLine()] })
                    }
                  >
                    <Plus className="w-4 h-4 mr-2" aria-hidden="true" /> Add line
                  </Button>
                  <p className="text-right text-muted-foreground tabular-nums">
                    Total {formatNaira(lineTotals(fix.lines).net + lineTotals(fix.lines).vat)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleFixResubmit}
                    disabled={updateInvoice.isPending || submit.isPending}
                    data-testid="button-fix-resubmit"
                  >
                    {updateInvoice.isPending || submit.isPending
                      ? "Resubmitting…"
                      : "Save & resubmit"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFix(null)}
                    disabled={updateInvoice.isPending || submit.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {!showEscalate ? (
              <div className="flex flex-wrap gap-2">
                {!fix && (
                  <Button size="sm" onClick={openFix} data-testid="button-open-fix">
                    <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Fix &
                    resubmit
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setShowEscalate(true)}>
                  <LifeBuoy className="w-4 h-4 mr-2" aria-hidden="true" /> Escalate to my firm
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
                  <Button size="sm" onClick={handleEscalate} disabled={escalate.isPending || !reason.trim()}>
                    {escalate.isPending ? "Sending…" : "Send to firm"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowEscalate(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data?.lines.map((l) => (
            <div key={l.id} className="flex justify-between text-sm border-b last:border-0 py-2">
              <div>
                <p className="font-medium">{l.description}</p>
                <p className="text-muted-foreground text-xs">
                  {l.quantity} × {formatNaira(l.unitPrice)} · VAT{" "}
                  {formatPct(l.vatRate)}
                </p>
              </div>
              <span className="font-medium tabular-nums">
                {formatNaira(Number(l.lineExtension) + Number(l.vatAmount))}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatNaira(invoice.grandTotal)}</span>
          </div>
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
