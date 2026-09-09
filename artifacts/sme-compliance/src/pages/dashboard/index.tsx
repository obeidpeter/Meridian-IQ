// The SME Today dashboard (R120 split the 2,005-line file into this shell,
// one module per card, the layout pieces and the pure helpers). The route
// (App.tsx), the unit suites (dashboard*.test.*) and the month-end and
// collections pages keep importing "@/pages/dashboard" / "./dashboard":
// this module is the page's surface.

import {
  useGetMe,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetReceivablesSummary,
  getGetReceivablesSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { lagosDayDiff } from "@workspace/format";
import { Button } from "@/components/ui/button";
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import { AtRiskInfo } from "@/components/at-risk-info";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  FileText,
  Activity,
  CalendarCheck,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkQueue,
  WorkspaceHeader,
  type WorkQueueItem,
  useUrlTab,
} from "@workspace/web-ui";
import {
  formatDate,
  formatLagosDate,
  formatNaira,
  statusLabel,
  badgeClasses,
} from "@/lib/format";
import { UnbilledIncomeCard } from "./unbilled-income-card";
import { PayablesCard } from "./payables-card";
import { ReceivablesCard } from "./receivables-card";
import { UnmatchedCreditsCard } from "./unmatched-credits-card";
import { NetPositionCard } from "./net-position-card";
import { DASHBOARD_VIEWS, showFirstInvoiceCta } from "./helpers";
import type { DashboardView } from "./helpers";
import { CashflowCard } from "./cashflow-card";
import { DashboardSkeleton, NextDeadlineCard } from "./layout";
import { ChaseListCard } from "./chase-list-card";
import {
  AdvisoryBriefCard,
  AskClerkCard,
  ClerkDigestCard,
} from "./clerk-cards";
import { ClientStatementCard } from "./client-statement-card";
import { MonthEndCloseCard } from "./month-end-close-card";
import { PenaltyExposureCard } from "./penalty-exposure-card";

export function Dashboard() {
  usePageTitle("Today");
  const [view, setView] = useUrlTab<DashboardView>(
    "view",
    "today",
    DASHBOARD_VIEWS,
  );
  const { data: me } = useGetMe();
  // Dual gate, mirroring layout.tsx's nav links and ClerkDock: the
  // capability says this role may ask, the clerk_ai feature says the
  // platform is lit. Capability alone left the tab visible at launch with
  // every card on it dark.
  const canAskClerk =
    !!me?.capabilities.includes("clerk.ask") &&
    !!me?.features.includes("clerk_ai");
  // The monthly statement belongs to the client whose month it is (capture,
  // not ask), so a client_user sees it even though it never sees the digest.
  const canSeeStatement = !!me?.capabilities.includes("clerk.capture");
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

  const agedReceivableCount =
    receivables?.groups.reduce(
      (total, group) => total + group.buckets.days90plus.count,
      0,
    ) ?? 0;
  const workItems: WorkQueueItem[] = [];
  if (summary?.atRiskCount) {
    workItems.push({
      id: "at-risk-invoices",
      title: `${summary.atRiskCount} invoice${summary.atRiskCount === 1 ? " is" : "s are"} at risk`,
      // Must state the server's actual rule (overdue deadlines + failed
      // submissions) — a merely-closing window does not count here.
      description:
        "A statutory submission deadline has passed, or a submission failed.",
      tone: "critical",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="destructive">
          <Link href="/calendar">Review risk</Link>
        </Button>
      ),
    });
  }
  if (summary?.failedCount) {
    workItems.push({
      id: "failed-submissions",
      title: `${summary.failedCount} failed submission${summary.failedCount === 1 ? "" : "s"}`,
      description:
        "Review the rejection reason before sending the invoice again.",
      tone: "critical",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Resolve</Link>
        </Button>
      ),
    });
  }
  if (summary?.draftCount) {
    workItems.push({
      id: "draft-invoices",
      title: `${summary.draftCount} draft invoice${summary.draftCount === 1 ? " needs" : "s need"} completion`,
      description: "Finish, validate and submit the paper already in progress.",
      tone: "warning",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Open drafts</Link>
        </Button>
      ),
    });
  }
  if (agedReceivableCount > 0) {
    workItems.push({
      id: "aged-receivables",
      title: `${agedReceivableCount} receivable${agedReceivableCount === 1 ? " is" : "s are"} more than 90 days old`,
      description: "Prioritize the oldest balances in the collection queue.",
      tone: "warning",
      icon: <Wallet className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={() => setView("money")}>
          Open money view
        </Button>
      ),
    });
  }
  if (summary?.nextDeadline) {
    workItems.push({
      id: `deadline-${summary.nextDeadline.id}`,
      title: summary.nextDeadline.title,
      description: `Due ${formatLagosDate(summary.nextDeadline.dueDate)}.`,
      tone:
        summary.nextDeadline.severity === "critical"
          ? "critical"
          : summary.nextDeadline.severity === "warning"
            ? "warning"
            : "info",
      icon: <CalendarCheck className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar">View deadline</Link>
        </Button>
      ),
    });
  }

  // First-run: a zero-invoice book gets a setup block in place of the work
  // queue — "Today is clear" is earned by an active book, not an empty one.
  // Same gate as the receivables card's inline nudge (undefined = loading or
  // failed summary keeps the normal queue rather than guessing).
  const firstRun = showFirstInvoiceCta(summary?.totalInvoices);

  // The header says what today amounts to (R70): the queue length and the
  // next statutory day, both from the same summary the cards below render,
  // so the sentence can never disagree with the page.
  const deadlineDays = lagosDayDiff(summary?.nextDeadline?.dueDate);
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const todaySummary = summary
    ? [
        workItems.length === 0
          ? "Nothing needs your attention right now"
          : `${plural(workItems.length, "item")} need${workItems.length === 1 ? "s" : ""} your attention`,
        deadlineDays === null
          ? null
          : deadlineDays < 0
            ? `a statutory deadline passed ${plural(-deadlineDays, "day")} ago`
            : deadlineDays === 0
              ? "a statutory deadline is due today"
              : `the next statutory deadline is in ${plural(deadlineDays, "day")}`,
      ]
        .filter(Boolean)
        .join("; ") + "."
    : "Your compliance work, in one place: what needs attention, money in motion and filing readiness.";

  const dashboardViews: Array<{
    value: DashboardView;
    label: string;
    count?: number;
  }> = [
    { value: "today", label: "Today", count: workItems.length },
    { value: "money", label: "Money", count: agedReceivableCount },
    {
      value: "compliance",
      label: "Compliance",
      count: summary?.upcomingDeadlineCount ?? 0,
    },
  ];
  if (canAskClerk) {
    dashboardViews.push({ value: "clerk", label: "Clerk" });
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Business workspace"
        title="Today"
        description={todaySummary}
        actions={
          <Button asChild>
            <Link href="/invoices/new">New invoice</Link>
          </Button>
        }
      />

      <RequireClientScope thing="compliance summary">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError ? (
          <QueryError
            thing="your compliance summary"
            onRetry={() => refetch()}
          />
        ) : (
          <>
            <MetricStrip label="Business compliance summary">
              <Metric
                label="Awaiting stamp"
                value={String(summary?.pendingCount ?? 0)}
                detail="Submitted, not yet stamped"
                icon={<Clock className="size-4" aria-hidden="true" />}
                tone={(summary?.pendingCount ?? 0) > 0 ? "info" : "default"}
              />
              <Metric
                label="Stamped & valid"
                value={String(summary?.stampedCount ?? 0)}
                detail={`${formatNaira(summary?.stampedValue)} total value`}
                icon={<CheckCircle className="size-4" aria-hidden="true" />}
                tone="positive"
                action={
                  <Link
                    href="/invoices?filter=stamped"
                    className="text-xs font-bold text-primary hover:underline"
                    data-testid="link-open-vault"
                  >
                    Open vault
                  </Link>
                }
              />
              <Metric
                label="Drafts"
                value={String(summary?.draftCount ?? 0)}
                detail="Needs completion"
                icon={<FileText className="size-4" aria-hidden="true" />}
                tone={(summary?.draftCount ?? 0) > 0 ? "warning" : "default"}
              />
              <Metric
                label="At risk"
                value={String(summary?.atRiskCount ?? 0)}
                detail="Needs attention"
                icon={<AlertTriangle className="size-4" aria-hidden="true" />}
                tone={(summary?.atRiskCount ?? 0) > 0 ? "critical" : "default"}
                action={<AtRiskInfo />}
              />
            </MetricStrip>

            <SegmentedControl<DashboardView>
              items={dashboardViews}
              value={view}
              onChange={setView}
              label="Dashboard view"
            />

            {view === "today" &&
              (firstRun ? (
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
                          <Link
                            href="/invoices/new"
                            data-testid="link-first-run-create"
                          >
                            Create your first invoice
                          </Link>
                        </Button>
                        <Button asChild variant="outline">
                          <Link
                            href="/import"
                            data-testid="link-first-run-import"
                          >
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
              ))}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {view === "today" && !firstRun && (
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
                    {summary?.recentActivity &&
                    summary.recentActivity.length > 0 ? (
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
              )}

              {/* The deadline card stays mounted first-run: statutory
                  deadlines exist even for a zero-invoice book. The empty
                  activity card and the Month-end "All clear" card have
                  nothing to say until paper exists. */}
              {view === "today" && (
                <NextDeadlineCard deadline={summary?.nextDeadline} />
              )}

              {view === "today" && !firstRun && me?.clientPartyId && (
                <MonthEndCloseCard clientPartyId={me.clientPartyId} />
              )}

              {(view === "today" || view === "money") && (
                <ReceivablesCard
                  summary={receivables}
                  isLoading={receivablesLoading}
                  isError={receivablesError}
                  clientPartyId={me?.clientPartyId || ""}
                  totalInvoices={summary?.totalInvoices}
                  onRetry={() => refetchReceivables()}
                />
              )}

              {view === "money" && me?.clientPartyId && (
                <PayablesCard clientPartyId={me.clientPartyId} />
              )}

              {view === "clerk" && canAskClerk && <ClerkDigestCard />}

              {view === "compliance" && (
                <NextDeadlineCard deadline={summary?.nextDeadline} />
              )}

              {view === "compliance" &&
                canSeeStatement &&
                me?.clientPartyId && (
                  <>
                    <ClientStatementCard clientPartyId={me.clientPartyId} />
                    <AdvisoryBriefCard clientPartyId={me.clientPartyId} />
                  </>
                )}

              {view === "compliance" && me?.clientPartyId && (
                <PenaltyExposureCard clientPartyId={me.clientPartyId} />
              )}

              {view === "clerk" && canAskClerk && me?.clientPartyId && (
                <ClerkActionsCard clientPartyId={me.clientPartyId} />
              )}

              {view === "clerk" && canAskClerk && <AskClerkCard />}

              {view === "money" && me?.clientPartyId && (
                <UnbilledIncomeCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <UnmatchedCreditsCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <CashflowCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <NetPositionCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <ChaseListCard clientPartyId={me.clientPartyId} />
              )}
            </div>
          </>
        )}
      </RequireClientScope>
    </div>
  );
}

// The unit suites and the month-end and collections pages pin these through
// this module, so the split keeps the page's import path as its surface.
export {
  showFirstInvoiceCta,
  dueLaterBucket,
  planPolicyStatusLine,
} from "./helpers";
export { ReceivablesCard } from "./receivables-card";
export { PayablesCard } from "./payables-card";
export { MonthEndCloseCard } from "./month-end-close-card";
export { MonthlyAutomationStrip } from "./monthly-automation-strip";
export { UnmatchedCreditsCard } from "./unmatched-credits-card";
export { CashflowCard } from "./cashflow-card";
export { ChaseListCard } from "./chase-list-card";
// Proposed actions (round 21): the "Clerk suggests" card lives in
// components/clerk-actions-card.tsx (mirroring its console twin's
// placement). Re-exported here so the card's existing import sites —
// dashboard-clerk-actions.test.tsx pins it from this page module — keep
// working unchanged.
export { ClerkActionsCard } from "@/components/clerk-actions-card";
