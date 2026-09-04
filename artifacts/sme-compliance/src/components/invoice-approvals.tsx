import {
  useApproveInvoice,
  useListInvoiceApprovals,
  getListInvoiceApprovalsQueryKey,
  getGetInvoiceQueryKey,
  type InvoiceApproval,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { UserCheck } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { formatDateTime, pillClasses } from "@/lib/format";
import { QueryError } from "@/components/query-error";
import { useRef } from "react";

export function canApproveInvoice(
  role: string | undefined,
  status: string,
): boolean {
  const firmRole = role === "firm_admin" || role === "firm_staff";
  return firmRole && ["draft", "validated", "failed"].includes(status);
}

export function ApprovalsCard({
  invoiceId,
  role,
  status,
  contentRevision,
}: {
  invoiceId: string;
  role: string | undefined;
  status: string;
  contentRevision: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const approvalsQuery = useListInvoiceApprovals(invoiceId, {
    query: {
      enabled: !!invoiceId,
      queryKey: getListInvoiceApprovalsQueryKey(invoiceId),
      retry: false,
    },
  });
  const approve = useApproveInvoice();
  const approvalInFlight = useRef(false);
  const canApprove = canApproveInvoice(role, status);
  const approvals = approvalsQuery.data;

  if (approvalsQuery.isError)
    return (
      <QueryError
        thing="invoice approvals"
        onRetry={() => void approvalsQuery.refetch()}
      />
    );
  if (approvalsQuery.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading invoice approvals...
      </p>
    );
  // An empty ledger is actionable only for someone who can add an approval.
  if (!approvalsQuery.isSuccess || !approvals) return null;
  if (approvals.length === 0 && !canApprove) return null;

  const handleApprove = async () => {
    if (approvalInFlight.current || approve.isPending) return;
    approvalInFlight.current = true;
    try {
      await approve.mutateAsync({
        id: invoiceId,
        data: { expectedRevision: contentRevision },
      });
      queryClient.invalidateQueries({
        queryKey: getListInvoiceApprovalsQueryKey(invoiceId),
      });
      toast({
        title: "Approval recorded",
        description:
          "This invoice now carries your submission approval — the submitter must be someone else.",
      });
    } catch (e) {
      if (errorStatus(e) === 409) {
        void queryClient.invalidateQueries({
          queryKey: getGetInvoiceQueryKey(invoiceId),
        });
      }
      toast({
        title: "Could not record approval",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      approvalInFlight.current = false;
    }
  };

  return (
    <Card data-testid="card-approvals">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="w-4 h-4" aria-hidden="true" /> Approvals
        </CardTitle>
        {canApprove && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleApprove()}
            disabled={approve.isPending}
            data-testid="button-approve-invoice"
          >
            {approve.isPending ? "Approving…" : "Approve for submission"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {approvals.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-approvals"
          >
            No approvals recorded yet. If your firm requires a second approver
            before submission, record yours here.
          </p>
        ) : (
          approvals.map((a: InvoiceApproval) => (
            <div
              key={a.id}
              className="text-sm border rounded-md px-3 py-2"
              data-testid={`row-approval-${a.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
                  {a.approvedByName ?? a.approvedByUserId}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {a.contentRevision
                      ? `Version ${a.contentRevision}`
                      : "Legacy approval"}
                  </span>
                  {a.revokedAt && (
                    <span
                      className={pillClasses("red")}
                      data-testid={`pill-approval-revoked-${a.id}`}
                    >
                      Revoked
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </span>
                </span>
              </div>
              {a.note && (
                <p className="text-muted-foreground mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {a.note}
                </p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
