import type { BuyerInvoice } from "@workspace/api-client-react";
import {
  getListBuyerInvoicesQueryKey,
  getGetBuyerInvoiceQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { Banknote, CalendarClock } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { errorDescription } from "@/lib/respond";
import type { InvoiceRespondState } from "./use-invoice-respond";

export function PaymentFlagsCard({
  invoice,
  state,
}: {
  invoice: BuyerInvoice;
  state: InvoiceRespondState;
}) {
  const { flag, queryClient, toast } = state;
  const pendingFlag = flag.isPending
    ? flag.variables?.data.paymentStatus
    : undefined;
  // A `paid` flag settles the invoice server-side; once settled it must not be
  // flagged paid again (a second settlement POST would be a duplicate event).
  const isSettled = invoice.status === "settled";

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
          void queryClient.invalidateQueries({
            queryKey: getGetBuyerInvoiceQueryKey(invoice.id),
          });
          toast({
            title:
              paymentStatus === "scheduled"
                ? "Payment marked as scheduled"
                : "Payment marked as paid",
            description:
              "The supplier can see this payment status in their records. Valo has not moved any money.",
          });
        },
        onError: (err) =>
          toast({
            title: "Could not update the payment status",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-payment-flags">
      <CardHeader>
        <CardTitle>Payment status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Tell the supplier whether payment is scheduled or already made. This
          updates their records; it does not schedule a bank transfer or move
          money.
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
                <AlertDialogTitle>Mark this invoice as paid?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently records the invoice as settled in the
                  supplier&apos;s records and cannot be undone here. It does not
                  move money. Mark {formatNaira(invoice.grandTotal)} as paid?
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
  );
}
