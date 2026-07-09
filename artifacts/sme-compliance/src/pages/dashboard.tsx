import {
  useGetMe,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
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
  FileText,
  Activity,
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
        {Array.from({ length: 2 }).map((_, i) => (
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
            </div>
          </>
        )}
      </RequireClientScope>
    </div>
  );
}
