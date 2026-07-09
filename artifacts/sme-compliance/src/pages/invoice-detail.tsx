import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetInvoice,
  useListSubmissionAttempts,
  useGetInvoiceStamp,
  useListEscalations,
  useGetErrorCatalogueEntry,
  useValidateInvoice,
  useSubmitInvoice,
  useEscalateInvoice,
  useCancelInvoice,
  useCreditNoteInvoice,
  useListConfirmations,
  useCreateConfirmation,
  useListSettlements,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStampQueryKey,
  getListEscalationsQueryKey,
  getGetErrorCatalogueEntryQueryKey,
  getListConfirmationsQueryKey,
  getListSettlementsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  statusLabel,
  badgeClasses,
  statusTone,
} from "@/lib/format";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const CONFIRMATION_BADGES: Record<string, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  confirmed: "bg-emerald-100 text-emerald-800 border-emerald-200",
  queried: "bg-blue-100 text-blue-800 border-blue-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
};

const SETTLEMENT_SOURCE_LABELS: Record<string, string> = {
  statement_match: "Statement match",
  buyer_flag: "Buyer flag",
  collection_account: "Collection account",
  uploaded_evidence: "Uploaded evidence",
};

export function InvoiceDetail() {
  const [, params] = useRoute("/invoices/:id");
  const id = params?.id || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id) },
  });
  const invoice = data?.invoice;
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
  const escalate = useEscalateInvoice();
  const cancelInvoice = useCancelInvoice();
  const creditNote = useCreditNoteInvoice();
  const createConfirmation = useCreateConfirmation();

  const [reason, setReason] = useState("");
  const [showEscalate, setShowEscalate] = useState(false);
  // CORE-09 adjustment dialog: cancel or credit-note, both reason-first.
  const [adjustKind, setAdjustKind] = useState<"cancel" | "credit" | null>(null);
  const [adjustReason, setAdjustReason] = useState("");

  const handleSubmit = async () => {
    if (!invoice) return;
    try {
      if (invoice.status === "draft") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          await queryClient.invalidateQueries();
          toast({
            title: "Validation failed",
            description: res.errors[0]?.message || "Fix the issues and try again.",
            variant: "destructive",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      await queryClient.invalidateQueries();
      toast({
        title: "Submitted for stamping",
        description: "We'll notify you once it clears the rail.",
      });
    } catch (e) {
      toast({
        title: "Submission error",
        description: e instanceof Error ? e.message : "Please try again.",
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
      await queryClient.invalidateQueries();
      toast({
        title: "Escalated to your firm",
        description: "An operator will pick this up.",
      });
    } catch (e) {
      toast({
        title: "Could not escalate",
        description: e instanceof Error ? e.message : "Please try again.",
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
      await queryClient.invalidateQueries();
    } catch (e) {
      toast({
        title:
          adjustKind === "cancel"
            ? "Could not cancel invoice"
            : "Could not issue credit note",
        description: e instanceof Error ? e.message : "Please try again.",
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
      await queryClient.invalidateQueries();
      toast({
        title: "Confirmation requested",
        description: "Your buyer will be asked to confirm receipt of this invoice.",
      });
    } catch (e) {
      toast({
        title: "Could not request confirmation",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  if (isLoading || !invoice) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const canSubmit = invoice.status === "draft" || invoice.status === "validated";
  // CORE-09: cancellation is allowed from any non-terminal, non-inflight state;
  // a credit note adjusts a stamped/confirmed/settled invoice. Mirrors the
  // server's lifecycle TRANSITIONS map — the server still has the final say.
  const canCancel = ["draft", "validated", "failed", "stamped", "confirmed"].includes(
    invoice.status,
  );
  const canCredit =
    invoice.kind === "invoice" &&
    ["stamped", "confirmed", "settled"].includes(invoice.status);
  const confirmationsDark = isNotFound(confirmationsError);
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
    <div className="space-y-6 animate-in fade-in duration-500">
      <Link
        href="/invoices"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to vault
      </Link>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">
              {invoice.invoiceNumber}
            </h1>
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${badgeClasses(invoice.status)}`}
            >
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
              <Send className="w-4 h-4 mr-2" />
              {validate.isPending || submit.isPending ? "Submitting…" : "Submit for stamping"}
            </Button>
          )}
          {canCredit && (
            <Button
              variant="outline"
              onClick={() => setAdjustKind("credit")}
              data-testid="button-credit-note"
            >
              <Undo2 className="w-4 h-4 mr-2" /> Issue credit note
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setAdjustKind("cancel")}
              data-testid="button-cancel-invoice"
            >
              <Ban className="w-4 h-4 mr-2" /> Cancel invoice
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={adjustKind !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdjustKind(null);
            setAdjustReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {adjustKind === "cancel" ? "Cancel this invoice" : "Issue a credit note"}
            </DialogTitle>
            <DialogDescription>
              {adjustKind === "cancel"
                ? "Cancellation is a recorded lifecycle event. A cancelled invoice can never be presented as eligible again."
                : "A credit note referencing this invoice is created and submitted for stamping. Once stamped, this invoice becomes Credited — a terminal, recorded state."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason (required — it is recorded on the ledger)"
            value={adjustReason}
            onChange={(e) => setAdjustReason(e.target.value)}
            data-testid="input-adjust-reason"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setAdjustKind(null);
                setAdjustReason("");
              }}
            >
              Keep invoice
            </Button>
            <Button
              variant={adjustKind === "cancel" ? "destructive" : "default"}
              disabled={
                !adjustReason.trim() ||
                cancelInvoice.isPending ||
                creditNote.isPending
              }
              onClick={handleAdjust}
              data-testid="button-confirm-adjust"
            >
              {cancelInvoice.isPending || creditNote.isPending
                ? "Working…"
                : adjustKind === "cancel"
                  ? "Cancel invoice"
                  : "Issue credit note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {stampedFamily && stamp && (
        <Card className="border-emerald-200 bg-emerald-50/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-800">
              <ShieldCheck className="w-4 h-4" /> FIRS stamped
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

      {tone === "failed" && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="w-4 h-4" /> Submission failed
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

            {!showEscalate ? (
              <Button variant="outline" size="sm" onClick={() => setShowEscalate(true)}>
                <LifeBuoy className="w-4 h-4 mr-2" /> Escalate to my firm
              </Button>
            ) : (
              <div className="space-y-2">
                <Textarea
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
                  {(Number(l.vatRate) * 100).toFixed(1)}%
                </p>
              </div>
              <span className="font-medium">
                {formatNaira(Number(l.lineExtension) + Number(l.vatAmount))}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 font-semibold">
            <span>Total</span>
            <span>{formatNaira(invoice.grandTotal)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailCheck className="w-4 h-4" /> Buyer confirmation
          </CardTitle>
          {canRequestConfirmation && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRequestConfirmation}
              disabled={createConfirmation.isPending}
            >
              <Send className="w-4 h-4 mr-2" />
              {createConfirmation.isPending ? "Requesting…" : "Request confirmation"}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {confirmationsDark ? (
            <p className="text-sm text-muted-foreground">
              Buyer confirmations are not yet enabled for this firm. Ask your operator to
              enable it.
            </p>
          ) : confirmationTimeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No confirmation activity yet.
              {invoice.status === "stamped"
                ? " Request a confirmation so your buyer acknowledges this invoice."
                : " Confirmations open up once the invoice is stamped."}
            </p>
          ) : (
            <div>
              {confirmationTimeline.map((c, i) => (
                <div key={c.id} className="relative pl-6 pb-4 last:pb-0">
                  {i < confirmationTimeline.length - 1 && (
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
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                        CONFIRMATION_BADGES[c.state] ||
                        "bg-slate-100 text-slate-600 border-slate-200"
                      }`}
                    >
                      {c.state}
                    </span>
                    {c.method && (
                      <span className="text-xs text-muted-foreground capitalize">
                        via {c.method}
                      </span>
                    )}
                    {c.noSetOff && (
                      <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                        No set-off
                      </span>
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

      {settlements && settlements.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="w-4 h-4" /> Settlement events
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {settlements.map((s) => (
              <div key={s.id} className="text-sm border rounded-md px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                      {SETTLEMENT_SOURCE_LABELS[s.source] || s.source}
                    </span>
                    {s.paymentStatus && (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                          s.paymentStatus === "paid"
                            ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                            : "bg-amber-100 text-amber-800 border-amber-200"
                        }`}
                      >
                        {s.paymentStatus}
                      </span>
                    )}
                  </div>
                  <span className="font-semibold">{formatNaira(s.amount)}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDateTime(s.occurredAt)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {attempts && attempts.length > 0 && (
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
                    <XCircle className="w-4 h-4 text-destructive mt-0.5" />
                  ) : a.status === "accepted" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5" />
                  ) : (
                    <Clock className="w-4 h-4 text-muted-foreground mt-0.5" />
                  )}
                  <div>
                    <p>
                      Attempt {a.attemptNo} · <span className="capitalize">{a.status}</span>{" "}
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
      )}

      {escalations && escalations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Escalations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {escalations.map((e) => (
              <div key={e.id} className="text-sm border rounded-md px-3 py-2">
                <div className="flex justify-between">
                  <span className="capitalize font-medium">{e.status}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
                </div>
                <p className="text-muted-foreground">{e.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
