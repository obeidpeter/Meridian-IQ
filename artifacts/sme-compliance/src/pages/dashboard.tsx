import {
  useGetMe,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetReceivablesSummary,
  getGetReceivablesSummaryQueryKey,
} from "@workspace/api-client-react";
import type { ReceivablesBucket, ReceivablesSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Activity,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import {
  formatDate,
  formatNaira,
  statusLabel,
  badgeClasses,
  severityLabel,
  severityBadgeClasses,
} from "@/lib/format";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  href,
  danger,
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Clock;
  href: string;
  danger?: boolean;
}) {
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card
        className={`h-full transition-colors hover:border-primary/50 ${
          danger ? "border-destructive/50 bg-destructive/5" : ""
        }`}
      >
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            </div>
            <Icon
              className={`w-8 h-8 ${danger ? "text-destructive" : "text-primary"}`}
              aria-hidden="true"
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function AgingBucketRow({
  label,
  bucket,
  tone,
}: {
  label: string;
  bucket: ReceivablesBucket;
  tone?: "warning" | "danger";
}) {
  // The late buckets only take their warning/danger tone once something is
  // actually sitting in them.
  const nonZero = bucket.count > 0 || Number(bucket.amount) > 0;
  const toneClass =
    nonZero && tone === "danger"
      ? "text-destructive"
      : nonZero && tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${toneClass}`}>
        {formatNaira(bucket.amount)}
        <span className="text-xs text-muted-foreground font-normal">
          {" "}
          · {bucket.count}
        </span>
      </span>
    </div>
  );
}

function ReceivablesCard({
  summary,
  isLoading,
  isError,
  clientPartyId,
  onRetry,
}: {
  summary: ReceivablesSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  clientPartyId: string;
  onRetry: () => void;
}) {
  const primary = summary?.groups[0];

  // CSV of the per-invoice rows behind this aging summary, as a plain browser
  // navigation (no query hook): the endpoint answers with a Content-Disposition
  // attachment and auth rides the session cookie.
  const exportCsv = () => {
    window.location.assign(
      `/api/dashboard/receivables/export?clientPartyId=${encodeURIComponent(clientPartyId)}`,
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Receivables
        </CardTitle>
        {!!clientPartyId && !!primary && (
          <Button
            variant="ghost"
            size="sm"
            onClick={exportCsv}
            data-testid="button-export-receivables-csv"
          >
            <Download className="w-4 h-4 mr-1.5" aria-hidden="true" />
            Export CSV
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <QueryError thing="your receivables" onRetry={onRetry} />
        ) : !summary || !primary ? (
          <div
            className="text-sm text-muted-foreground text-center py-4"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables.
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p
                className="text-2xl font-bold tabular-nums"
                data-testid="text-receivables-total"
              >
                {formatNaira(primary.outstandingTotal)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Outstanding across {primary.invoiceCount} invoice
                {primary.invoiceCount === 1 ? "" : "s"}
                {summary.groups.length > 1
                  ? ` · +${summary.groups.length - 1} more ${
                      summary.groups.length === 2 ? "currency" : "currencies"
                    }`
                  : ""}
              </p>
            </div>
            <div className="space-y-2">
              <AgingBucketRow
                label="Current (≤30d)"
                bucket={primary.buckets.current}
              />
              <AgingBucketRow
                label="31–60 days"
                bucket={primary.buckets.days31to60}
              />
              <AgingBucketRow
                label="61–90 days"
                bucket={primary.buckets.days61to90}
                tone="warning"
              />
              <AgingBucketRow
                label="90+ days"
                bucket={primary.buckets.days90plus}
                tone="danger"
              />
            </div>
            {summary.topDebtors.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Top debtors
                </p>
                <div className="space-y-2">
                  {summary.topDebtors.map((debtor) => (
                    <div
                      key={debtor.buyerPartyId}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate">{debtor.buyerName}</span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatNaira(debtor.outstanding)}
                        <span className="text-xs text-muted-foreground font-normal">
                          {" "}
                          · {debtor.invoiceCount} inv
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  usePageTitle("Dashboard");
  const { data: me } = useGetMe();
  const {
    data: summary,
    isLoading,
    isError,
    refetch,
  } = useGetDashboardSummary(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetDashboardSummaryQueryKey({
          clientPartyId: me?.clientPartyId || "",
        }),
      },
    },
  );
  const {
    data: receivables,
    isLoading: receivablesLoading,
    isError: receivablesError,
    refetch: refetchReceivables,
  } = useGetReceivablesSummary(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetReceivablesSummaryQueryKey({
          clientPartyId: me?.clientPartyId || "",
        }),
      },
    },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Compliance overview
          </h1>
          <p className="text-muted-foreground mt-1">
            Stay ahead of your filing deadlines.
          </p>
        </div>
        <Button asChild>
          <Link href="/invoices/new">New invoice</Link>
        </Button>
      </div>

      <RequireClientScope thing="compliance summary">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError ? (
          <QueryError thing="your compliance summary" onRetry={() => refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Pending invoices"
                value={String(summary?.pendingCount ?? 0)}
                sub="Awaiting stamp"
                icon={Clock}
                href="/invoices"
              />
              <StatCard
                label="Stamped & valid"
                value={String(summary?.stampedCount ?? 0)}
                sub={`${formatNaira(summary?.stampedValue)} total value`}
                icon={CheckCircle}
                href="/invoices"
              />
              <StatCard
                label="Drafts"
                value={String(summary?.draftCount ?? 0)}
                sub="Needs completion"
                icon={FileText}
                href="/invoices"
              />
              <StatCard
                label="At risk"
                value={String(summary?.atRiskCount ?? 0)}
                sub="Needs attention"
                icon={AlertTriangle}
                href="/calendar"
                danger={!!summary?.atRiskCount}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="w-5 h-5" aria-hidden="true" /> Recent activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summary?.recentActivity && summary.recentActivity.length > 0 ? (
                    <div className="space-y-4">
                      {summary.recentActivity.map((activity) => (
                        <div
                          key={activity.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {activity.label}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(activity.at)}
                            </p>
                          </div>
                          {activity.status && (
                            <span className={badgeClasses(activity.status)}>
                              {statusLabel(activity.status)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No recent activity
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5" aria-hidden="true" /> Next deadline
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summary?.nextDeadline ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">
                          {summary.nextDeadline.title}
                        </span>
                        <span
                          className={severityBadgeClasses(
                            summary.nextDeadline.severity,
                          )}
                        >
                          {severityLabel(summary.nextDeadline.severity)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(summary.nextDeadline.dueDate)}
                      </p>
                      <Link
                        href="/calendar"
                        className="text-primary text-sm mt-2 hover:underline"
                      >
                        View calendar
                      </Link>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No upcoming deadlines
                    </div>
                  )}
                </CardContent>
              </Card>

              <ReceivablesCard
                summary={receivables}
                isLoading={receivablesLoading}
                isError={receivablesError}
                clientPartyId={me?.clientPartyId || ""}
                onRetry={() => refetchReceivables()}
              />
            </div>
          </>
        )}
      </RequireClientScope>
    </div>
  );
}
