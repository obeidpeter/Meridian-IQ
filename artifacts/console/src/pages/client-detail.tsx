import { Link, useParams } from "wouter";
import { useGetClientPortfolio } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { InvoiceStatusLight } from "@/components/status-light";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  severityBadgeClasses,
  humanize,
} from "@/lib/format";
import { usePageTitle } from "@/hooks/use-page-title";

export function ClientDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data, isLoading, error, refetch } = useGetClientPortfolio(id);
  usePageTitle(data?.client.legalName ?? "Client detail");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-40" />
        <div>
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-4 w-48 mt-2" />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          data-testid="link-back"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to portfolio
        </Link>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Client detail
        </h1>
        <QueryError thing="this client" onRetry={() => refetch()} />
      </div>
    );
  }

  const { client, invoices, deadlines } = data;
  const failingIds = new Set(client.failingInvoiceIds);

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to portfolio
      </Link>

      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-client-name"
        >
          {client.legalName}
        </h1>
        <p className="text-muted-foreground mt-1">
          {client.totalInvoices} invoices · {humanize(client.penaltyRisk)}{" "}
          penalty risk
        </p>
      </div>

      {client.failingInvoiceIds.length > 0 && (
        <Card className="border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="w-5 h-5 text-red-500 dark:text-red-400 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium text-red-800 dark:text-red-300">
                  {client.failingInvoiceIds.length} invoice
                  {client.failingInvoiceIds.length === 1 ? "" : "s"} need
                  attention
                </p>
                <p className="text-sm text-red-700 dark:text-red-400 mt-1">
                  Failed or overdue submissions are marked "Needs action" below.
                  The client resolves them in their MeridianIQ workspace;
                  escalated failures also land in the operator queue with a
                  playbook.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices yet.</p>
            ) : (
              <div className="divide-y">
                {invoices.map((inv) => {
                  const failing = inv.failing || failingIds.has(inv.id);
                  return (
                    <div
                      key={inv.id}
                      data-testid={`row-invoice-${inv.id}`}
                      className={`flex items-center gap-3 py-3 -mx-2 px-2 rounded-md ${
                        failing ? "bg-red-50 dark:bg-red-950/40" : ""
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {inv.invoiceNumber}
                          {failing && (
                            <span
                              className="ml-2 text-xs text-red-700 dark:text-red-400 font-semibold"
                              data-testid={`flag-failing-${inv.id}`}
                            >
                              NEEDS ACTION
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {inv.buyerName} · {inv.category} ·{" "}
                          {formatDate(inv.issueDate)}
                          <span className="sm:hidden tabular-nums">
                            {" "}
                            · {formatNaira(inv.grandTotal)}
                          </span>
                        </p>
                      </div>
                      <p className="text-sm font-medium hidden sm:block tabular-nums">
                        {formatNaira(inv.grandTotal)}
                      </p>
                      <span className={badgeClasses(inv.status)}>
                        {statusLabel(inv.status)}
                      </span>
                      <InvoiceStatusLight invoiceId={inv.id} />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deadlines</CardTitle>
          </CardHeader>
          <CardContent>
            {deadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No upcoming deadlines.
              </p>
            ) : (
              <div className="space-y-3">
                {deadlines.map((d) => (
                  <div
                    key={d.id}
                    data-testid={`row-deadline-${d.id}`}
                    className="border rounded-md p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm">{d.title}</p>
                      <span className={severityBadgeClasses(d.severity)}>
                        {humanize(d.status)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Due {formatDate(d.dueDate)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
