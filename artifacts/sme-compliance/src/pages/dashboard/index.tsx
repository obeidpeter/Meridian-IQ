// The SME Today dashboard (R120 split the 2,005-line file into this shell,
// one module per card, the layout pieces and the pure helpers; R126 moved
// the state and queries into use-dashboard-workspace.tsx and the view
// blocks into their own modules). The route (App.tsx), the unit suites
// (dashboard*.test.*) and the month-end and collections pages keep
// importing "@/pages/dashboard" / "./dashboard": this module is the page's
// surface.

import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { Link } from "wouter";
import { SegmentedControl, WorkspaceHeader } from "@workspace/web-ui";
import { ReceivablesCard } from "./receivables-card";
import type { DashboardView } from "./helpers";
import { DashboardSkeleton } from "./layout";
import { useDashboardWorkspace } from "./use-dashboard-workspace";
import { DashboardMetricStrip } from "./summary-strip";
import { TodayQueue } from "./today-cards";
import {
  ClerkPanel,
  CompliancePanel,
  MoneyPanel,
  TodayPanel,
} from "./view-panels";

export function Dashboard() {
  const state = useDashboardWorkspace();
  const {
    view,
    setView,
    me,
    summary,
    isLoading,
    isError,
    refetch,
    receivables,
    receivablesLoading,
    receivablesError,
    refetchReceivables,
    workItems,
    firstRun,
    todaySummary,
    dashboardViews,
  } = state;

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
            <DashboardMetricStrip summary={summary} />

            <SegmentedControl<DashboardView>
              items={dashboardViews}
              value={view}
              onChange={setView}
              label="Dashboard view"
            />

            {view === "today" && (
              <TodayQueue firstRun={firstRun} workItems={workItems} />
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {view === "today" && <TodayPanel state={state} />}

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

              {view === "money" && <MoneyPanel state={state} />}

              {view === "clerk" && <ClerkPanel state={state} />}

              {view === "compliance" && <CompliancePanel state={state} />}
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
