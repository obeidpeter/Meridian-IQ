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
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStampQueryKey,
  getListEscalationsQueryKey,
  getGetErrorCatalogueEntryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  statusLabel,
  badgeClasses,
  statusTone,
} from "@/lib/format";

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

  const { data: attempts } = useListSubmissionAttempts(id, {
    query: { enabled: !!id, queryKey: getListSubmissionAttemptsQueryKey(id) },
  });
  const { data: stamp } = useGetInvoiceStamp(id, {
    query: {
      enabled: !!id && tone === "stamped",
      queryKey: getGetInvoiceStampQueryKey(id),
    },
  });
  const { data: escalations } = useListEscalations(id, {
    query: { enabled: !!id, queryKey: getListEscalationsQueryKey(id) },
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

  const [reason, setReason] = useState("");
  const [showEscalate, setShowEscalate] = useState(false);

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

  if (isLoading || !invoice) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const canSubmit = invoice.status === "draft" || invoice.status === "validated";

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
        {canSubmit && (
          <Button onClick={handleSubmit} disabled={validate.isPending || submit.isPending}>
            <Send className="w-4 h-4 mr-2" />
            {validate.isPending || submit.isPending ? "Submitting…" : "Submit for stamping"}
          </Button>
        )}
      </div>

      {tone === "stamped" && stamp && (
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
