import { Link, useParams } from "wouter";
import { useGetClientPortfolio } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
} from "@/lib/format";

export function ClientDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data, isLoading, error } = useGetClientPortfolio(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-primary"
          data-testid="link-back"
        >
          <ArrowLeft className="w-4 h-4" /> Back to portfolio
        </Link>
        <p className="text-destructive" data-testid="text-error">
          Unable to load this client.
        </p>
      </div>
    );
  }

  const { client, invoices, deadlines } = data;
  const failingIds = new Set(client.failingInvoiceIds);

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-primary"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" /> Back to portfolio
      </Link>

      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-client-name"
        >
          {client.legalName}
        </h1>
        <p className="text-muted-foreground mt-1">
          {client.totalInvoices} invoices · {client.penaltyRisk} penalty risk
        </p>
      </div>

      {client.failingInvoiceIds.length > 0 && (
        <Card className="border-red-200 bg-red-50/60">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-red-800">
                  {client.failingInvoiceIds.length} invoice
                  {client.failingInvoiceIds.length === 1 ? "" : "s"} need
                  attention
                </p>
                <p className="text-sm text-red-700 mt-1">
                  Failed or overdue submissions are highlighted below. Open one
                  to review the issue.
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
                        failing ? "bg-red-50" : ""
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {inv.invoiceNumber}
                          {failing && (
                            <span
                              className="ml-2 text-xs text-red-700 font-semibold"
                              data-testid={`flag-failing-${inv.id}`}
                            >
                              NEEDS ACTION
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {inv.buyerName} · {inv.category} ·{" "}
                          {formatDate(inv.issueDate)}
                        </p>
                      </div>
                      <p className="text-sm font-medium hidden sm:block">
                        {formatNaira(inv.grandTotal)}
                      </p>
                      <span
                        className={`text-xs font-medium px-2.5 py-1 rounded-full border ${badgeClasses(inv.status)}`}
                      >
                        {statusLabel(inv.status)}
                      </span>
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
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${
                          d.severity === "critical"
                            ? "bg-red-100 text-red-800 border-red-200"
                            : d.severity === "warning"
                              ? "bg-amber-100 text-amber-800 border-amber-200"
                              : "bg-blue-100 text-blue-800 border-blue-200"
                        }`}
                      >
                        {d.status.replace("_", " ")}
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
