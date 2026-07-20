import { useRef, useState } from "react";
import { Link, useParams } from "wouter";
import {
  useListBuyerInvoices,
  useCreateConfirmation,
  useFlagPayment,
  useGetMe,
  getListBuyerInvoicesQueryKey,
} from "@workspace/api-client-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Banknote,
  CalendarClock,
  FileQuestion,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  confirmationLabel,
  confirmationBadgeClasses,
  stampBadge,
  eligibleBadge,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import {
  RESPONSE_DESCRIPTIONS,
  SUBMIT_LABELS,
  errorDescription,
  noteRequiredFor,
  noteValidationError,
  responseRecordedCopy,
  type ResponseState,
} from "@/lib/respond";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

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
    activeClasses:
      "data-[state=on]:border-emerald-500 data-[state=on]:bg-emerald-50 data-[state=on]:text-emerald-800 dark:data-[state=on]:bg-emerald-950/40 dark:data-[state=on]:text-emerald-300",
  },
  {
    state: "queried",
    label: "Query",
    icon: HelpCircle,
    activeClasses:
      "data-[state=on]:border-blue-500 data-[state=on]:bg-blue-50 data-[state=on]:text-blue-800 dark:data-[state=on]:bg-blue-950/40 dark:data-[state=on]:text-blue-300",
  },
  {
    state: "rejected",
    label: "Reject",
    icon: XCircle,
    activeClasses:
      "data-[state=on]:border-red-500 data-[state=on]:bg-red-50 data-[state=on]:text-red-800 dark:data-[state=on]:bg-red-950/40 dark:data-[state=on]:text-red-300",
  },
];

export function InvoiceRespond() {
  const params = useParams();
  const id = params.id as string;
  const { data: invoices, isLoading, error, refetch } = useListBuyerInvoices();
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [response, setResponse] = useState<ResponseState | null>(null);
  const [method, setMethod] = useState("portal");
  const [note, setNote] = useState("");
  // The note-validation message on screen (null = no complaint yet). Only
  // set on a submit attempt, cleared as soon as the input satisfies it.
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noSetOff, setNoSetOff] = useState(false);
  // Post-action confirmation: which response THIS visit just recorded. The
  // refetched confirmationState alone can't distinguish "you responded just
  // now" from "you responded last week", so keep the moment explicit.
  const [submitted, setSubmitted] = useState<ResponseState | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const confirm = useCreateConfirmation();
  const flag = useFlagPayment();

  const invoice = invoices?.find((i) => i.id === id);
  usePageTitle(invoice ? invoice.invoiceNumber : "Invoice");

  const backLink = (
    <Link
      href="/"
      className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      data-testid="link-back"
    >
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to confirmations
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-4 w-72 max-w-full mt-2" />
          </div>
          <Skeleton className="h-7 w-32 rounded-full" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-40" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !invoices) {
    return (
      <div className="space-y-4">
        {backLink}
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Buyer Rails" />
        ) : (
          <QueryError thing="this invoice" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="space-y-4">
        {backLink}
        <Card data-testid="card-unknown-invoice">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <FileQuestion
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-error">
              We couldn't find this invoice
            </p>
            <p className="text-sm text-muted-foreground max-w-md">
              It may not be addressed to your organization, or the link may be
              out of date. Your confirmation queue lists every invoice you can
              act on.
            </p>
            <Button asChild variant="outline" data-testid="button-back-to-queue">
              <Link href="/">Back to confirmations</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const awaitingResponse = invoice.confirmationState === "requested";
  const noteRequired = noteRequiredFor(response);
  const stamp = stampBadge(invoice.stampValid);
  const eligible = eligibleBadge(invoice.eligible);
  const pendingFlag = flag.isPending
    ? flag.variables?.data.paymentStatus
    : undefined;
  // A `paid` flag settles the invoice server-side; once settled it must not be
  // flagged paid again (a second settlement POST would be a duplicate event).
  const isSettled = invoice.status === "settled";

  const handleSubmit = () => {
    if (!response) return;
    if (!me?.buyerPartyId) {
      toast({
        title: "Buyer identity not resolved yet",
        description: "Try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    const validation = noteValidationError(response, note);
    if (validation !== null) {
      setNoteError(validation);
      noteRef.current?.focus();
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
          setSubmitted(response);
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
    // Financial action: block a double-click from firing a second settlement
    // POST while the first is still in flight, and refuse to re-settle.
    if (flag.isPending) return;
    if (paymentStatus === "paid" && isSettled) return;
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
            data-testid="text-page-title"
          >
            <span data-testid="text-invoice-number">
              {invoice.invoiceNumber}
            </span>
          </h1>
          <p className="text-muted-foreground mt-1">
            {invoice.supplierName} · issued {formatDate(invoice.issueDate)}
          </p>
        </div>
        <span
          className={confirmationBadgeClasses(invoice.confirmationState)}
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
              <p
                className="font-medium tabular-nums"
                data-testid="text-grand-total"
              >
                {formatNaira(invoice.grandTotal)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">VAT</p>
              <p className="font-medium tabular-nums">
                {formatNaira(invoice.vatTotal)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Due date</p>
              <p className="font-medium">{formatDate(invoice.dueDate)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <span className={badgeClasses(invoice.status)}>
                {statusLabel(invoice.status)}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t flex flex-wrap gap-2">
            <span className={stamp.classes} data-testid="badge-stamp">
              {stamp.label}
            </span>
            <span className={eligible.classes} data-testid="badge-eligible">
              {eligible.label}
            </span>
          </div>
        </CardContent>
      </Card>

      {submitted !== null ? (
        // Post-action confirmation: the response this visit just recorded,
        // stated in full — what happened and what happens next.
        <Card data-testid="card-response-recorded">
          <CardContent className="py-10 flex flex-col items-center text-center gap-2">
            <CheckCircle2
              className="w-10 h-10 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-response-recorded">
              {responseRecordedCopy(submitted).title}
            </p>
            <p className="text-sm text-muted-foreground max-w-md">
              {responseRecordedCopy(submitted).description}
            </p>
            <Button
              asChild
              variant="outline"
              className="mt-2"
              data-testid="button-recorded-back"
            >
              <Link href="/">Back to confirmations</Link>
            </Button>
          </CardContent>
        </Card>
      ) : awaitingResponse ? (
        <Card data-testid="card-respond">
          <CardHeader>
            <CardTitle>Respond to confirmation request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ToggleGroup
              type="single"
              value={response ?? ""}
              onValueChange={(v) => {
                setResponse(v === "" ? null : (v as ResponseState));
                setNoteError(null);
              }}
              aria-label="Your response"
              className="grid grid-cols-3 gap-2 w-full"
            >
              {RESPONSE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                return (
                  <ToggleGroupItem
                    key={opt.state}
                    value={opt.state}
                    data-testid={`button-response-${opt.state}`}
                    className={`flex h-auto flex-col items-center gap-1.5 border rounded-md py-3 px-2 text-sm font-medium transition-colors hover:bg-muted ${opt.activeClasses}`}
                  >
                    <Icon className="w-5 h-5" aria-hidden="true" />
                    {opt.label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>

            {/* What the picked action DOES, before it is submitted — the
                one-word toggle labels alone leave the outcome to guesswork. */}
            {response !== null && (
              <p
                className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/40"
                data-testid="text-response-description"
              >
                {RESPONSE_DESCRIPTIONS[response]}
              </p>
            )}

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
                ref={noteRef}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  if (e.target.value.trim() !== "") setNoteError(null);
                }}
                aria-invalid={noteError !== null}
                aria-describedby={noteError !== null ? "note-error" : undefined}
                className={
                  noteError !== null
                    ? "border-destructive focus-visible:ring-destructive"
                    : undefined
                }
                placeholder={
                  noteRequired
                    ? "Explain what needs correcting on this invoice…"
                    : "Anything the supplier should know…"
                }
                data-testid="input-note"
              />
              {noteRequired && noteError === null && (
                <p className="text-xs text-muted-foreground">
                  Required — your note is what the supplier sees.
                </p>
              )}
              {noteError !== null && (
                <p
                  id="note-error"
                  role="alert"
                  className="text-sm text-destructive"
                  data-testid="text-note-error"
                >
                  {noteError}
                </p>
              )}
            </div>

            {response === "confirmed" && (
              <div className="border rounded-md p-3 space-y-1.5">
                <div className="flex items-start gap-2">
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
                <p className="text-xs text-muted-foreground pl-6">
                  Confirming without set-off makes this invoice financeable.
                </p>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={!response || confirm.isPending}
              variant={response === "rejected" ? "destructive" : "default"}
              data-testid="button-submit-response"
            >
              {confirm.isPending ? (
                <>
                  <Spinner className="mr-2 size-4" /> Submitting…
                </>
              ) : response ? (
                SUBMIT_LABELS[response]
              ) : (
                "Choose a response"
              )}
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
              disabled={pendingFlag === "scheduled"}
              data-testid="button-flag-scheduled"
            >
              {pendingFlag === "scheduled" ? (
                <>
                  <Spinner className="mr-2 size-4" /> Marking…
                </>
              ) : (
                <>
                  <CalendarClock className="w-4 h-4 mr-2" aria-hidden="true" />{" "}
                  Mark payment scheduled
                </>
              )}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={pendingFlag === "paid" || isSettled}
                  data-testid="button-flag-paid"
                >
                  {pendingFlag === "paid" ? (
                    <>
                      <Spinner className="mr-2 size-4" /> Marking…
                    </>
                  ) : (
                    <>
                      <Banknote className="w-4 h-4 mr-2" aria-hidden="true" />{" "}
                      Mark paid
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Mark this invoice as paid?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This records a settlement event on the supplier's
                    compliance record and can't be undone. Mark{" "}
                    {formatNaira(invoice.grandTotal)} as paid?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-cancel-paid">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleFlag("paid")}
                    disabled={flag.isPending || isSettled}
                    data-testid="button-confirm-paid"
                  >
                    Mark paid
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
