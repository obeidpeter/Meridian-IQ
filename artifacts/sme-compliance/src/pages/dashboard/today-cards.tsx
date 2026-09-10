// The Today view's queue block and the recent-activity card (R126 moved
// them out of the page shell). The queue is either the first-run setup
// block (a zero-invoice book) or the work queue; the activity card lists
// the summary's recent lifecycle events.
import type { DashboardSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Activity, FileText } from "lucide-react";
import { Link } from "wouter";
import { WorkQueue, type WorkQueueItem } from "@workspace/web-ui";
import { formatDate, statusLabel, badgeClasses } from "@/lib/format";

export function TodayQueue({
  firstRun,
  workItems,
}: {
  firstRun: boolean;
  workItems: WorkQueueItem[];
}) {
  return firstRun ? (
    <Card data-testid="card-first-run">
      <CardContent className="pt-6">
        <EmptyState
          icon={FileText}
          title="Set up your compliance workspace"
          description="You haven't raised any invoices yet. Create your first invoice, or import the ones you've already issued, and the dashboard starts tracking stamping, deadlines and receivables for you."
          testId="text-first-run"
        >
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/invoices/new" data-testid="link-first-run-create">
                Create your first invoice
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/import" data-testid="link-first-run-import">
                Import existing invoices
              </Link>
            </Button>
          </div>
        </EmptyState>
      </CardContent>
    </Card>
  ) : (
    <WorkQueue
      title="What needs attention"
      description="Ordered by statutory risk, failed work and cash collection age."
      items={workItems}
      emptyTitle="Today is clear"
      emptyDescription="There are no urgent submissions, failures or aged receivables."
    />
  );
}

export function RecentActivityCard({
  summary,
}: {
  summary: DashboardSummary | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span className="mi-card-icon">
            <Activity aria-hidden="true" />
          </span>
          Recent activity
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
  );
}
