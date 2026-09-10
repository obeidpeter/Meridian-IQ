// The per-view card groups of the dashboard grid (R126 moved them out of
// the page shell). Each panel renders its view's cards in the shell's
// original sibling order; the shell hoists the `view === "…"` test and
// keeps the ReceivablesCard as a direct grid child because it is the one
// card mounted in two views (today and money). Panels receive the shell's
// state bag and call no query, tab or storage hook of their own.
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import type { DashboardWorkspaceState } from "./use-dashboard-workspace";
import { RecentActivityCard } from "./today-cards";
import { NextDeadlineCard } from "./layout";
import { MonthEndCloseCard } from "./month-end-close-card";
import { PayablesCard } from "./payables-card";
import { UnbilledIncomeCard } from "./unbilled-income-card";
import { UnmatchedCreditsCard } from "./unmatched-credits-card";
import { CashflowCard } from "./cashflow-card";
import { NetPositionCard } from "./net-position-card";
import { ChaseListCard } from "./chase-list-card";
import { ClientStatementCard } from "./client-statement-card";
import { PenaltyExposureCard } from "./penalty-exposure-card";
import {
  AdvisoryBriefCard,
  AskClerkCard,
  ClerkDigestCard,
} from "./clerk-cards";

export function TodayPanel({ state }: { state: DashboardWorkspaceState }) {
  const { firstRun, summary, me } = state;
  return (
    <>
      {!firstRun && <RecentActivityCard summary={summary} />}

      {/* The deadline card stays mounted first-run: statutory
          deadlines exist even for a zero-invoice book. The empty
          activity card and the Month-end "All clear" card have
          nothing to say until paper exists. */}
      <NextDeadlineCard deadline={summary?.nextDeadline} />

      {!firstRun && me?.clientPartyId && (
        <MonthEndCloseCard clientPartyId={me.clientPartyId} />
      )}
    </>
  );
}

export function MoneyPanel({ state }: { state: DashboardWorkspaceState }) {
  const { me } = state;
  return (
    <>
      {me?.clientPartyId && <PayablesCard clientPartyId={me.clientPartyId} />}

      {me?.clientPartyId && (
        <UnbilledIncomeCard clientPartyId={me.clientPartyId} />
      )}

      {me?.clientPartyId && (
        <UnmatchedCreditsCard clientPartyId={me.clientPartyId} />
      )}

      {me?.clientPartyId && <CashflowCard clientPartyId={me.clientPartyId} />}

      {me?.clientPartyId && (
        <NetPositionCard clientPartyId={me.clientPartyId} />
      )}

      {me?.clientPartyId && <ChaseListCard clientPartyId={me.clientPartyId} />}
    </>
  );
}

export function CompliancePanel({ state }: { state: DashboardWorkspaceState }) {
  const { summary, canSeeStatement, me } = state;
  return (
    <>
      <NextDeadlineCard deadline={summary?.nextDeadline} />

      {canSeeStatement && me?.clientPartyId && (
        <>
          <ClientStatementCard clientPartyId={me.clientPartyId} />
          <AdvisoryBriefCard clientPartyId={me.clientPartyId} />
        </>
      )}

      {me?.clientPartyId && (
        <PenaltyExposureCard clientPartyId={me.clientPartyId} />
      )}
    </>
  );
}

export function ClerkPanel({ state }: { state: DashboardWorkspaceState }) {
  const { canAskClerk, me } = state;
  return (
    <>
      {canAskClerk && <ClerkDigestCard />}

      {canAskClerk && me?.clientPartyId && (
        <ClerkActionsCard clientPartyId={me.clientPartyId} />
      )}

      {canAskClerk && <AskClerkCard />}
    </>
  );
}
