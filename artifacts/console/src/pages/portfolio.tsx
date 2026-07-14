import { Link } from "wouter";
import {
  getGetFirmReceivablesQueryKey,
  useGetFirmReceivables,
  useGetMe,
  useGetPortfolio,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import {
  AlertTriangle,
  Users,
  FileWarning,
  Clock,
  ChevronRight,
  Upload,
  GitBranch,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  riskBadgeClasses,
  riskLabel,
} from "@/lib/format";
import { usePageTitle } from "@/hooks/use-page-title";

// Receivables amounts arrive as decimal strings. NGN rows use the shared
// naira formatter; anything else gets a plain grouped number plus its
// currency code so a foreign-currency row never masquerades as naira.
function formatMoney(value: string, currency: string): string {
  if (currency === "NGN") return formatNaira(value);
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `${new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)} ${currency}`;
}

// Firm-level receivables: one row per client per currency, worst-first from
// the API. Loads independently of the portfolio query so a failure here
// never blanks the risk view above it.
function ReceivablesCard() {
  const { data, isLoading, error, refetch } = useGetFirmReceivables({
    query: { queryKey: getGetFirmReceivablesQueryKey() },
  });

  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-receivables"
    >
      <CardHeader>
        <CardTitle className="text-base">Receivables</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : error || !data ? (
          <QueryError thing="receivables" onRetry={() => refetch()} />
        ) : data.clients.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables across the book.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      Client
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Outstanding
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Invoices
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      90+ days
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Oldest due
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr
                      key={`${c.clientPartyId}-${c.currency}`}
                      className="border-b last:border-0"
                      data-testid={`row-receivable-${c.clientPartyId}-${c.currency}`}
                    >
                      <td className="py-2.5 font-medium">
                        <Link
                          href={`/clients/${c.clientPartyId}`}
                          className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {c.clientName}
                        </Link>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatMoney(c.outstandingTotal, c.currency)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {c.invoiceCount}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {Number(c.overdue90Amount) > 0 ? (
                          <span className="font-medium text-red-500 dark:text-red-400">
                            {formatMoney(c.overdue90Amount, c.currency)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground tabular-nums">
                        {formatDate(c.oldestDueDate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.topDebtors.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  Top debtors
                </h3>
                <div className="divide-y">
                  {data.topDebtors.map((d) => (
                    <div
                      key={`${d.buyerPartyId}-${d.currency}`}
                      className="flex items-center justify-between gap-4 py-2"
                      data-testid={`row-debtor-${d.buyerPartyId}-${d.currency}`}
                    >
                      <p className="text-sm font-medium truncate">
                        {d.buyerName}
                      </p>
                      <p className="text-sm text-muted-foreground shrink-0 tabular-nums">
                        {formatMoney(d.outstanding, d.currency)} ·{" "}
                        {d.invoiceCount} invoice
                        {d.invoiceCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Mirrors the loaded page: header, four stat tiles, then a card of rows.
// Also used by App.tsx while /me resolves so the front door never goes blank.
export function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function PortfolioHeader({
  description,
  canImport,
}: {
  description: string;
  canImport: boolean;
}) {
  return (
    <div className="flex flex-col justify-between gap-5 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <p className="text-[11px] font-extrabold uppercase text-teal-700">
          Firm overview
        </p>
        <h1
          className="mt-2 text-2xl font-extrabold text-slate-950 md:text-3xl dark:text-foreground"
          data-testid="text-page-title"
        >
          Client portfolio
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" asChild>
          <Link href="/pipeline">
            <GitBranch className="size-4" aria-hidden="true" />
            Onboarding
          </Link>
        </Button>
        {canImport && (
          <Button asChild>
            <Link href="/clients/import">
              <Upload className="size-4" aria-hidden="true" />
              Import clients
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function Portfolio() {
  usePageTitle("Client portfolio");
  const { data: me } = useGetMe();
  const { data, isLoading, error, refetch } = useGetPortfolio();
  const canImport = (me?.capabilities ?? []).includes("clients.import");

  if (isLoading) {
    return <PortfolioSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Penalty exposure, filing deadlines and receivables across your client book."
          canImport={canImport}
        />
        <QueryError thing="your portfolio" onRetry={() => refetch()} />
      </div>
    );
  }

  const clients = [...data.clients].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.penaltyRisk] - order[b.penaltyRisk];
  });

  // First-run empty state: the query succeeded but the book is empty — show
  // the way in (bulk import / pipeline) instead of a wall of zeros.
  if (clients.length === 0) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Set up the client book to start tracking risk, deadlines and receivables."
          canImport={canImport}
        />
        <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <Users
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-empty">
              Import your client book
            </p>
            <p className="text-sm text-muted-foreground max-w-md">
              Clients appear here once they're on the platform. Bring your book
              across from a practice-management export, or track prospects
              through onboarding.
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {canImport && (
                <Button asChild data-testid="button-empty-import">
                  <Link href="/clients/import">
                    <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                    Bulk import clients
                  </Link>
                </Button>
              )}
              <Button
                variant="outline"
                asChild
                data-testid="button-empty-pipeline"
              >
                <Link href="/pipeline">Open the onboarding pipeline</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortfolioHeader
        description={`Penalty risk, deadlines and receivables across ${data.clientCount} client${
          data.clientCount === 1 ? "" : "s"
        }.`}
        canImport={canImport}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Clients"
          value={String(data.clientCount)}
          icon={Users}
          testId="stat-clients"
        />
        <StatTile
          label="High-risk clients"
          value={String(data.highRiskCount)}
          icon={AlertTriangle}
          iconTone="danger"
          testId="stat-high-risk"
        />
        <StatTile
          label="Unsubmitted invoices"
          value={String(data.totalUnsubmittedCount)}
          detail={`${formatNaira(data.totalUnsubmittedValue)} awaiting submission`}
          icon={FileWarning}
          iconTone="warning"
          testId="stat-unsubmitted"
        />
        <StatTile
          label="Overdue deadlines"
          value={String(data.totalOverdueCount)}
          icon={Clock}
          iconTone="danger"
          testId="stat-overdue"
        />
      </div>

      <Card className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-4 text-base">
            <span>Clients by penalty risk</span>
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">
              {data.clientCount} total
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <div className="divide-y">
            {clients.map((c) => (
              <Link
                key={c.clientPartyId}
                href={`/clients/${c.clientPartyId}`}
                data-testid={`row-client-${c.clientPartyId}`}
                className="-mx-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_1rem] sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900 dark:text-foreground">
                    {c.legalName}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {c.totalInvoices} invoices · {c.failedCount} failed ·{" "}
                    {c.pendingCount} pending
                    {c.nextDeadline
                      ? ` · next: ${c.nextDeadline.title} ${formatDate(c.nextDeadline.dueDate)}`
                      : ""}
                    {c.unsubmittedCount > 0 && (
                      <span className="sm:hidden tabular-nums">
                        {" "}
                        · {formatNaira(c.unsubmittedValue)} unsubmitted
                      </span>
                    )}
                  </p>
                </div>
                {c.unsubmittedCount > 0 && (
                  <div className="hidden sm:block text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {formatNaira(c.unsubmittedValue)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.unsubmittedCount} unsubmitted
                    </p>
                  </div>
                )}
                <span
                  className={riskBadgeClasses(c.penaltyRisk)}
                  data-testid={`badge-risk-${c.clientPartyId}`}
                >
                  {riskLabel(c.penaltyRisk)}
                </span>
                <ChevronRight
                  className="hidden size-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <ReceivablesCard />
    </div>
  );
}
