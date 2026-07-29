import { useState } from "react";
import {
  useGetMe,
  useListBills,
  getListBillsQueryKey,
  useFlagBillPayment,
  useVerifyBillStamp,
  getGetPayablesSummaryQueryKey,
  useGetDoublePaymentCheck,
  getGetDoublePaymentCheckQueryKey,
  useListMissingRecurringBills,
  getListMissingRecurringBillsQueryKey,
} from "@workspace/api-client-react";
import type {
  BillSummary,
  BillVerification,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { AlertTriangle, ChevronDown, Receipt, ShieldCheck } from "lucide-react";
import {
  billPayStatusBadgeClasses,
  billPayStatusLabel,
  canFlagBill,
  formatDate,
  formatAmount,
  formatNaira,
  pillClasses,
} from "@/lib/format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Unpaid" },
  { key: "scheduled", label: "Scheduled" },
  { key: "paid", label: "Paid" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

type FlagStatus = "scheduled" | "paid";

// The confirm copy is the load-bearing promise of this page: a payment flag
// records settlement evidence against the bill, it never mutates the captured
// supplier document.
const FLAG_CONFIRM_MESSAGE =
  "This records payment evidence on the bill — it never edits the document.";

// Double-payment guard (round 16): advisory only — bills the payment
// evidence says were settled twice, and unpaid near-duplicates that would
// become a double payment if both are paid. Renders nothing when there is
// nothing to warn about; a repeated standing charge can legitimately match.
function DoublePaymentAdvisory({ clientPartyId }: { clientPartyId: string }) {
  const { data: check } = useGetDoublePaymentCheck(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetDoublePaymentCheckQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (
    !check ||
    (check.multiPaid.length === 0 && check.duplicateCandidates.length === 0)
  ) {
    return null;
  }
  return (
    <Card
      className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="double-payment-advisory"
    >
      <CardContent className="pt-4 space-y-2 text-sm text-amber-800 dark:text-amber-300">
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Possible double payments
        </p>
        {check.multiPaid.map((b) => (
          <p key={b.invoiceId} data-testid={`multi-paid-${b.invoiceId}`}>
            {b.invoiceNumber} ({b.supplierName},{" "}
            {b.currency === "NGN"
              ? formatNaira(b.grandTotal)
              : `${b.currency} ${b.grandTotal}`}
            ) is matched to {b.evidenceCount} separate bank debits totalling
            more than the bill — {formatDate(b.firstPaidAt)} and again{" "}
            {formatDate(b.lastPaidAt)}.
          </p>
        ))}
        {check.duplicateCandidates.map((p) => (
          <p
            key={`${p.first.invoiceId}-${p.second.invoiceId}`}
            data-testid={`dup-pair-${p.first.invoiceId}`}
          >
            {p.pairKind === "paid_original" ? (
              <>
                {p.first.invoiceNumber} from {p.supplierName} is already paid,
                and {p.second.invoiceNumber} looks like the same bill (
                {p.currency === "NGN"
                  ? formatNaira(p.grandTotal)
                  : `${p.currency} ${p.grandTotal}`}
                , issued {p.daysApart} day{p.daysApart === 1 ? "" : "s"} apart)
                — check it is not a duplicate before paying it.
              </>
            ) : (
              <>
                {p.first.invoiceNumber} and {p.second.invoiceNumber} from{" "}
                {p.supplierName} are both unpaid for the same amount (
                {p.currency === "NGN"
                  ? formatNaira(p.grandTotal)
                  : `${p.currency} ${p.grandTotal}`}
                ), issued {p.daysApart} day{p.daysApart === 1 ? "" : "s"} apart
                — check one is not a duplicate before paying both.
              </>
            )}
          </p>
        ))}
        <p className="text-xs">
          Advisory only, from payment evidence already on file. A recurring
          standing charge can match legitimately — review before acting.
        </p>
      </CardContent>
    </Card>
  );
}

// Missing recurring bills (round 18): vendors whose bill arrives every
// month with nothing captured this cycle — an uncaptured bill is input VAT
// silently lost and a payment about to surprise the cash outlook. Advisory
// only, mined deterministically from the capture history; renders nothing
// when every habit is up to date.
function MissingBillsAdvisory({ clientPartyId }: { clientPartyId: string }) {
  const { data: alerts } = useListMissingRecurringBills(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListMissingRecurringBillsQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!alerts || alerts.length === 0) return null;
  return (
    <Card
      className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="missing-bills-advisory"
    >
      <CardContent className="pt-4 space-y-2 text-sm text-amber-800 dark:text-amber-300">
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Expected vendor bills not captured yet
        </p>
        {alerts.map((a) => (
          <p
            key={`${a.supplierPartyId}-${a.currency}`}
            data-testid={`missing-bill-${a.supplierPartyId}`}
          >
            {a.supplierName} has billed about{" "}
            {formatAmount(a.medianAmount, a.currency)} roughly every{" "}
            {a.medianGapDays} days ({a.count} bills on record, last{" "}
            {formatDate(a.lastIssueDate)}) — this cycle's bill was expected by{" "}
            {formatDate(a.expectedByDate)} and has not been captured.
          </p>
        ))}
        <p className="text-xs">
          Advisory only, from your own capture history. An uncaptured bill
          means unclaimed input VAT — if the vendor arrangement has ended,
          you can ignore this.
        </p>
      </CardContent>
    </Card>
  );
}

function billAmount(bill: BillSummary): string {
  return bill.currency === "NGN"
    ? formatNaira(bill.grandTotal)
    : `${bill.currency} ${bill.grandTotal}`;
}

// Inline IRN+CSID verification against the national record. Local state on
// purpose: collapsing a row discards a half-typed form, and each row keeps its
// own last result. The list chip refreshes via the parent's invalidation.
function VerifyStampForm({
  bill,
  isPending,
  onVerify,
}: {
  bill: BillSummary;
  isPending: boolean;
  onVerify: (irn: string, csid: string) => Promise<BillVerification>;
}) {
  const [irn, setIrn] = useState("");
  const [csid, setCsid] = useState("");
  const [result, setResult] = useState<BillVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await onVerify(irn.trim(), csid.trim()));
    } catch (e) {
      setError(serverErrorMessage(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck
          className="w-4 h-4 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">Verify stamp</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`verify-irn-${bill.invoiceId}`} className="text-xs">
            IRN
          </Label>
          <Input
            id={`verify-irn-${bill.invoiceId}`}
            value={irn}
            maxLength={120}
            onChange={(e) => setIrn(e.target.value)}
            data-testid={`input-verify-irn-${bill.invoiceId}`}
          />
        </div>
        <div>
          <Label htmlFor={`verify-csid-${bill.invoiceId}`} className="text-xs">
            CSID
          </Label>
          <Input
            id={`verify-csid-${bill.invoiceId}`}
            value={csid}
            maxLength={120}
            onChange={(e) => setCsid(e.target.value)}
            data-testid={`input-verify-csid-${bill.invoiceId}`}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        From the supplier&apos;s stamped invoice
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void submit()}
        disabled={!irn.trim() || !csid.trim() || isPending}
        data-testid={`button-verify-bill-${bill.invoiceId}`}
      >
        {isPending ? "Checking…" : "Verify stamp"}
      </Button>
      {result && (
        <p
          className={`text-sm font-medium ${
            result.valid
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-destructive"
          }`}
          data-testid={`text-verify-result-${bill.invoiceId}`}
        >
          {result.valid ? "Valid stamp" : "Not found on the national record"}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" data-testid="text-verify-error">
          {error}
        </p>
      )}
    </div>
  );
}

function BillRow({
  bill,
  expanded,
  onToggle,
  onFlag,
  flagPending,
  verifyPending,
  onVerify,
}: {
  bill: BillSummary;
  expanded: boolean;
  onToggle: () => void;
  onFlag: (status: FlagStatus) => void;
  flagPending: boolean;
  verifyPending: boolean;
  onVerify: (irn: string, csid: string) => Promise<BillVerification>;
}) {
  return (
    <Card data-testid={`row-bill-${bill.invoiceId}`}>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="w-full flex items-center justify-between gap-3 p-4 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid={`button-expand-bill-${bill.invoiceId}`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold truncate">
                {bill.invoiceNumber}
              </span>
              <span className={billPayStatusBadgeClasses(bill.payStatus)}>
                {billPayStatusLabel(bill.payStatus)}
              </span>
              {bill.lastVerification && (
                <span
                  className={pillClasses(
                    bill.lastVerification.valid ? "emerald" : "red",
                  )}
                  data-testid={`chip-verification-${bill.invoiceId}`}
                >
                  {bill.lastVerification.valid
                    ? "Stamp valid"
                    : "Stamp not found"}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {bill.supplierName} · Issued {formatDate(bill.issueDate)}
              {bill.dueDate ? ` · Due ${formatDate(bill.dueDate)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-semibold tabular-nums">
              {billAmount(bill)}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          </div>
        </button>
        {expanded && (
          <div className="border-t px-4 py-4 space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onFlag("scheduled")}
                  disabled={
                    !canFlagBill(bill.payStatus, "scheduled") || flagPending
                  }
                  data-testid={`button-flag-scheduled-${bill.invoiceId}`}
                >
                  Mark payment scheduled
                </Button>
                <Button
                  size="sm"
                  onClick={() => onFlag("paid")}
                  disabled={!canFlagBill(bill.payStatus, "paid") || flagPending}
                  data-testid={`button-flag-paid-${bill.invoiceId}`}
                >
                  Mark paid
                </Button>
              </div>
              {bill.payStatus === "paid" && (
                <p className="text-xs text-muted-foreground">
                  Payment recorded — nothing more to flag on this bill.
                </p>
              )}
            </div>
            <VerifyStampForm
              bill={bill}
              isPending={verifyPending}
              onVerify={onVerify}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Bills() {
  usePageTitle("Supplier bills");
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const clientPartyId = me?.clientPartyId || "";

  const {
    data: bills,
    isLoading,
    isError,
    refetch,
  } = useListBills(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListBillsQueryKey({ clientPartyId }),
      },
    },
  );

  const flagPayment = useFlagBillPayment();
  const verifyStamp = useVerifyBillStamp();

  const [filter, setFilter] = useState<FilterKey>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The confirm step for a payment flag: null = no dialog. Confirming fires
  // the mutation; the dialog's copy is the evidence-not-edit promise.
  const [pendingFlag, setPendingFlag] = useState<{
    bill: BillSummary;
    status: FlagStatus;
  } | null>(null);

  const all = bills ?? [];
  const countFor = (key: FilterKey) =>
    key === "all" ? all.length : all.filter((b) => b.payStatus === key).length;
  const rows =
    filter === "all" ? all : all.filter((b) => b.payStatus === filter);

  const refreshBills = () => {
    // Prefix keys: every param variant of the list and the dashboard's
    // payables card go stale together.
    void queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: getGetPayablesSummaryQueryKey(),
    });
  };

  const runFlag = async () => {
    if (!pendingFlag) return;
    const { bill, status } = pendingFlag;
    setPendingFlag(null);
    try {
      await flagPayment.mutateAsync({
        id: bill.invoiceId,
        data: { status },
      });
      refreshBills();
      toast({
        title: status === "paid" ? "Marked paid" : "Payment scheduled",
        description: `Payment evidence recorded on ${bill.invoiceNumber}.`,
      });
    } catch (e) {
      toast({
        title: "Couldn't record the payment flag",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const runVerify = async (
    bill: BillSummary,
    irn: string,
    csid: string,
  ): Promise<BillVerification> => {
    const result = await verifyStamp.mutateAsync({
      id: bill.invoiceId,
      data: { irn, csid },
    });
    // The row chip and the list's lastVerification refresh from the server's
    // stored result.
    refreshBills();
    return result;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier bills"
        description="Documents you captured where your business is the buyer — money going out."
      />

      <RequireClientScope thing="supplier bills list">
        <div className="space-y-6">
          <DoublePaymentAdvisory clientPartyId={clientPartyId} />
          <MissingBillsAdvisory clientPartyId={clientPartyId} />
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => {
              const isActive = filter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  aria-pressed={isActive}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border min-h-9 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    isActive
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card text-foreground hover:bg-muted"
                  }`}
                  data-testid={`filter-bills-${f.key}`}
                >
                  {f.label}
                  {bills ? ` · ${countFor(f.key)}` : ""}
                </button>
              );
            })}
          </div>

          {isLoading ? (
            <SkeletonList count={5} itemClassName="h-20" />
          ) : isError ? (
            <QueryError thing="your supplier bills" onRetry={() => refetch()} />
          ) : all.length === 0 ? (
            <Card>
              <EmptyState
                icon={Receipt}
                title="No supplier bills yet"
                description="Documents you send to Clerk where you are the buyer will show up here."
              />
            </Card>
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={Receipt}
                title="No matches"
                description="No bills match this filter."
              >
                <Button
                  variant="outline"
                  className="mt-2"
                  onClick={() => setFilter("all")}
                >
                  Show all bills
                </Button>
              </EmptyState>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((bill) => (
                <BillRow
                  key={bill.invoiceId}
                  bill={bill}
                  expanded={expandedId === bill.invoiceId}
                  onToggle={() =>
                    setExpandedId((prev) =>
                      prev === bill.invoiceId ? null : bill.invoiceId,
                    )
                  }
                  onFlag={(status) => setPendingFlag({ bill, status })}
                  flagPending={flagPayment.isPending}
                  verifyPending={verifyStamp.isPending}
                  onVerify={(irn, csid) => runVerify(bill, irn, csid)}
                />
              ))}
            </div>
          )}
        </div>
      </RequireClientScope>

      <AlertDialog
        open={!!pendingFlag}
        onOpenChange={(open) => {
          if (!open) setPendingFlag(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingFlag?.status === "paid"
                ? `Mark ${pendingFlag.bill.invoiceNumber} paid?`
                : `Mark payment scheduled for ${
                    pendingFlag?.bill.invoiceNumber ?? "this bill"
                  }?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {FLAG_CONFIRM_MESSAGE}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void runFlag()}
              data-testid="button-confirm-flag"
            >
              {pendingFlag?.status === "paid"
                ? "Mark paid"
                : "Mark scheduled"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
