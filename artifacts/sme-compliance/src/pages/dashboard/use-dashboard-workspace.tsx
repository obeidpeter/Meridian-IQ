import {
  useGetMe,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetReceivablesSummary,
  getGetReceivablesSummaryQueryKey,
  type Me,
} from "@workspace/api-client-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useUrlTab } from "@workspace/web-ui";
import {
  DASHBOARD_VIEWS,
  dashboardViewItems,
  showFirstInvoiceCta,
  todaySummaryLine,
} from "./helpers";
import type { DashboardView } from "./helpers";
import { dashboardWorkItems } from "./work-items";

// Everything the Today dashboard holds and reads (R126 moved it out of the
// page shell): the view tab, the principal's capability gates, the two
// summary queries and the derivations the header, the queue and the view
// chips render from. The shell calls it once and hands the bag to the
// panels, so nothing about hook order or closures changed in the split;
// the shell keeps the loading and error returns.
export function useDashboardWorkspace() {
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
  const summaries = useDashboardSummaries(me);
  const { summary, agedReceivableCount } = summaries;

  const workItems = dashboardWorkItems(summary, agedReceivableCount, setView);

  // First-run: a zero-invoice book gets a setup block in place of the work
  // queue — "Today is clear" is earned by an active book, not an empty one.
  // Same gate as the receivables card's inline nudge (undefined = loading or
  // failed summary keeps the normal queue rather than guessing).
  const firstRun = showFirstInvoiceCta(summary?.totalInvoices);

  const todaySummary = todaySummaryLine(summary, workItems.length);

  const dashboardViews = dashboardViewItems(
    summary,
    agedReceivableCount,
    workItems.length,
    canAskClerk,
  );

  return {
    view,
    setView,
    me,
    canAskClerk,
    canSeeStatement,
    ...summaries,
    workItems,
    firstRun,
    todaySummary,
    dashboardViews,
  };
}

// The two summary queries and the aged-receivable count derived from the
// second. Kept beside the workspace hook, not folded into it: the repeated
// query-option expressions are what the ratchet counts.
function useDashboardSummaries(me: Me | undefined) {
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

  return {
    summary,
    isLoading,
    isError,
    refetch,
    receivables,
    receivablesLoading,
    receivablesError,
    refetchReceivables,
    agedReceivableCount,
  };
}

export type DashboardWorkspaceState = ReturnType<typeof useDashboardWorkspace>;
