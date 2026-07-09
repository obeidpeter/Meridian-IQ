import { Link } from "wouter";
import { useGetMe, useGetPortfolio } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import {
  AlertTriangle,
  Users,
  FileWarning,
  Clock,
  ChevronRight,
  Upload,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  riskBadgeClasses,
  riskLabel,
} from "@/lib/format";
import { usePageTitle } from "@/hooks/use-page-title";

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: string;
  icon: typeof Users;
  tone?: "danger" | "warning";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
          </div>
          <Icon
            aria-hidden="true"
            className={`w-8 h-8 ${
              tone === "danger"
                ? "text-red-500 dark:text-red-400"
                : tone === "warning"
                  ? "text-amber-500 dark:text-amber-400"
                  : "text-primary"
            }`}
          />
        </div>
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
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Client portfolio
          </h1>
          <p className="text-muted-foreground mt-1">
            Penalty risk across your client book.
          </p>
        </div>
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
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Client portfolio
          </h1>
          <p className="text-muted-foreground mt-1">
            Penalty risk across your client book.
          </p>
        </div>
        <Card>
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
              <Button variant="outline" asChild data-testid="button-empty-pipeline">
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
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Client portfolio
        </h1>
        <p className="text-muted-foreground mt-1">
          Penalty risk across {data.clientCount} client
          {data.clientCount === 1 ? "" : "s"}. Click a client to reach any
          failing invoice.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Clients"
          value={String(data.clientCount)}
          icon={Users}
          testId="stat-clients"
        />
        <StatCard
          label="High-risk clients"
          value={String(data.highRiskCount)}
          icon={AlertTriangle}
          tone="danger"
          testId="stat-high-risk"
        />
        <StatCard
          label="Unsubmitted invoices"
          value={`${data.totalUnsubmittedCount} · ${formatNaira(data.totalUnsubmittedValue)}`}
          icon={FileWarning}
          tone="warning"
          testId="stat-unsubmitted"
        />
        <StatCard
          label="Overdue deadlines"
          value={String(data.totalOverdueCount)}
          icon={Clock}
          tone="danger"
          testId="stat-overdue"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Clients by penalty risk</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {clients.map((c) => (
              <Link
                key={c.clientPartyId}
                href={`/clients/${c.clientPartyId}`}
                data-testid={`row-client-${c.clientPartyId}`}
                className="flex items-center gap-4 py-3 hover:bg-muted/50 -mx-2 px-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.legalName}</p>
                  <p className="text-xs text-muted-foreground">
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
                  className="w-4 h-4 text-muted-foreground shrink-0"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
