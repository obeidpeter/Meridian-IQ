import { useState } from "react";
import { Link, useParams } from "wouter";
import {
  useListBuyerInvoices,
  useCreateConfirmation,
  useFlagPayment,
  useGetMe,
  getListBuyerInvoicesQueryKey,
} from "@workspace/api-client-react";
import type { ConfirmationInputState } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Banknote,
  CalendarClock,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  confirmationLabel,
  confirmationBadgeClasses,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";

type ResponseState = Extract<
  ConfirmationInputState,
  "confirmed" | "queried" | "rejected"
>;

const RESPONSE_OPTIONS: Array<{
  state: ResponseState;
  label: string;
  icon: typeof CheckCircle2;
  activeClasses: string;
}> = [
  {
    state: "confirmed",
    label: "Confirm",
    icon: CheckCircle2,
    activeClasses: "border-emerald-500 bg-emerald-50 text-emerald-800",
  },
  {
    state: "queried",
    label: "Query",
    icon: HelpCircle,
    activeClasses: "border-blue-500 bg-blue-50 text-blue-800",
  },
  {
    state: "rejected",
    label: "Reject",
    icon: XCircle,
    activeClasses: "border-red-500 bg-red-50 text-red-800",
  },
];

function errorDescription(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function InvoiceRespond() {
  const params = useParams();
  const id = params.id as string;
  const { data: invoices, isLoading, error } = useListBuyerInvoices();
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [response, setResponse] = useState<ResponseState>("confirmed");
  const [method, setMethod] = useState("portal");
  const [note, setNote] = useState("");
  const [noSetOff, setNoSetOff] = useState(false);

  const confirm = useCreateConfirmation();
  const flag = useFlagPayment();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const backLink = (
    <Link
      href="/"
      className="inline-flex items-center gap-2 text-sm text-primary"
      data-testid="link-back"
    >
      <ArrowLeft className="w-4 h-4" /> Back to confirmations
    </Link>
  );

  if (error || !invoices) {
    return (
      <div className="space-y-4">
        {backLink}
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Buyer rails" />
        ) : (
          <p className="text-destructive" data-testid="text-error">
            Unable to load this invoice.
          </p>
        )}
      </div>
    );
  }

  const invoice = invoices.find((i) => i.id === id);

  if (!invoice) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-destructive" data-testid="text-error">
          This invoice is not addressed to your organization.
        </p>
      </div>
    );
  }

  const awaitingResponse = invoice.confirmationState === "requested";
  const noteRequired = response === "queried" || response === "rejected";

  const handleSubmit = () => {
    if (!me?.buyerPartyId) {
      toast({
        title: "Buyer identity not resolved yet",
        description: "Try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    if (noteRequired && note.trim() === "") {
      toast({
        title: `A note is required to ${response === "queried" ? "query" : "reject"} an invoice`,
        description: "Tell the supplier what the problem is.",
        variant: "destructive",
      });
      return;
    }
    confirm.mutate(
      {
        id: invoice.id,
        data: {
          buyerPartyId: me.buyerPartyId,
          state: response,
          method,
          ...(response === "confirmed" ? { noSetOff } : {}),
          ...(note.trim() !== "" ? { note: note.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: `Invoice ${confirmationLabel(response).toLowerCase()}`,
            description: "The supplier has been notified of your response.",
          });
          queryClient.invalidateQueries({
            queryKey: getListBuyerInvoicesQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not record your response",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  const handleFlag = (paymentStatus: "scheduled" | "paid") => {
    flag.mutate(
      { id: invoice.id, data: { paymentStatus } },
      {
        onSuccess: () => {
          // A `paid` flag settles the invoice server-side — refetch so the
          // status badge does not go stale.
          void queryClient.invalidateQueries({
            queryKey: getListBuyerInvoicesQueryKey(),
          });
          toast({
            title:
              paymentStatus === "scheduled"
                ? "Payment marked as scheduled"
                : "Payment marked as paid",
            description:
              "The supplier sees this flag in their reconciliation view.",
          });
        },
        onError: (err) =>
          toast({
            title: "Could not flag the payment",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="space-y-6">
      {backLink}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-invoice-number"
          >
            {invoice.invoiceNumber}
          </h1>
          <p className="text-muted-foreground mt-1">
            {invoice.supplierName} · issued {formatDate(invoice.issueDate)}
          </p>
        </div>
        <span
          className={`text-xs font-medium px-2.5 py-1 rounded-full border ${confirmationBadgeClasses(invoice.confirmationState)}`}
          data-testid="badge-confirmation-state"
        >
          {confirmationLabel(invoice.confirmationState)}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoice details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Amount</p>
              <p className="font-medium" data-testid="text-grand-total">
                {formatNaira(invoice.grandTotal)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">VAT</p>
              <p className="font-medium">{formatNaira(invoice.vatTotal)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Due date</p>
              <p className="font-medium">{formatDate(invoice.dueDate)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <span
                className={`inline-block text-xs font-medium px-2.5 py-1 rounded-full border ${badgeClasses(invoice.status)}`}
              >
                {statusLabel(invoice.status)}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t flex flex-wrap gap-2">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                invoice.stampValid
                  ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                  : "bg-slate-100 text-slate-600 border-slate-200"
              }`}
              data-testid="badge-stamp"
            >
              {invoice.stampValid ? "Stamp valid" : "No valid stamp"}
            </span>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                invoice.eligible
                  ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                  : "bg-amber-100 text-amber-800 border-amber-200"
              }`}
              data-testid="badge-eligible"
            >
              {invoice.eligible
                ? "Eligible for input VAT"
                : "Not yet eligible for input VAT"}
            </span>
          </div>
        </CardContent>
      </Card>

      {awaitingResponse ? (
        <Card data-testid="card-respond">
          <CardHeader>
            <CardTitle>Respond to confirmation request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {RESPONSE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const isActive = response === opt.state;
                return (
                  <button
                    key={opt.state}
                    onClick={() => setResponse(opt.state)}
                    data-testid={`button-response-${opt.state}`}
                    className={`flex flex-col items-center gap-1.5 border rounded-md py-3 px-2 text-sm font-medium transition-colors ${
                      isActive ? opt.activeClasses : "hover:bg-muted"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="method">Method</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger id="method" data-testid="select-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portal">Portal</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="note">
                Note{noteRequired ? " (required)" : " (optional)"}
              </Label>
              <Textarea
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  noteRequired
                    ? "Explain what needs correcting on this invoice…"
                    : "Anything the supplier should know…"
                }
                data-testid="input-note"
              />
            </div>

            {response === "confirmed" && (
              <div className="flex items-start gap-2 border rounded-md p-3">
                <Checkbox
                  id="no-set-off"
                  checked={noSetOff}
                  onCheckedChange={(v) => setNoSetOff(v === true)}
                  data-testid="checkbox-no-set-off"
                />
                <Label
                  htmlFor="no-set-off"
                  className="text-sm font-normal leading-snug"
                >
                  We acknowledge no set-off will be applied against this
                  invoice
                </Label>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={confirm.isPending}
              data-testid="button-submit-response"
            >
              {confirm.isPending ? "Submitting…" : "Submit response"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="card-no-request">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {invoice.confirmationState === "none"
                ? "No confirmation has been requested for this invoice yet. The response form appears here once the supplier requests one."
                : `You have already responded to this invoice (${confirmationLabel(invoice.confirmationState).toLowerCase()}).`}
            </p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-payment-flags">
        <CardHeader>
          <CardTitle>Payment flags</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Let the supplier know where this invoice sits in your payment run.
            Flags feed the supplier's settlement reconciliation — the history
            is kept on their side.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => handleFlag("scheduled")}
              disabled={flag.isPending}
              data-testid="button-flag-scheduled"
            >
              <CalendarClock className="w-4 h-4 mr-2" /> Mark payment scheduled
            </Button>
            <Button
              variant="outline"
              onClick={() => handleFlag("paid")}
              disabled={flag.isPending}
              data-testid="button-flag-paid"
            >
              <Banknote className="w-4 h-4 mr-2" /> Mark paid
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
