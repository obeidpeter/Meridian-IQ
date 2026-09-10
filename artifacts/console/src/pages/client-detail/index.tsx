// The console client page (R126 split the 1,192-line file into this shell,
// the state hook, the layout pieces, the view panels, the three self-gating
// cards, the offboard dialog and the pure helpers). The route (App.tsx) and
// the unit suite (client-detail.test.ts) keep importing "@/pages/client-detail"
// / "./client-detail": this module is the page's surface.

import {
  SegmentedControl,
  WorkQueue,
  WorkspaceHeader,
} from "@workspace/web-ui";
import { humanize, riskBadgeClasses } from "@/lib/format";
import type { ClientView } from "./helpers";
import { useClientDetail } from "./use-client-detail";
import { clientViewItems, clientWorkItems } from "./work-items";
import {
  BackToPortfolioLink,
  ClientDetailErrorState,
  ClientDetailSkeleton,
  ClientHeaderActions,
  ClientSummaryStrip,
} from "./layout";
import { ClientViewPanels } from "./view-panels";
import { OffboardClientDialog } from "./offboard-dialog";

export function ClientDetail() {
  const state = useClientDetail();
  const {
    data,
    isLoading,
    error,
    refetch,
    exportQuery,
    visibleViews,
    activeView,
    setView,
  } = state;

  if (isLoading) {
    return <ClientDetailSkeleton />;
  }

  if (error || !data) {
    return <ClientDetailErrorState onRetry={() => refetch()} />;
  }

  const { client, invoices, deadlines } = data;
  const workItems = clientWorkItems({
    client,
    deadlines,
    visibleViews,
    setView,
  });
  const views = clientViewItems({
    workItems,
    invoices,
    deadlines,
    visibleViews,
  });

  return (
    <div className="space-y-6">
      {/* "/portfolio?view=clients" deep-links the portfolio's clients tab (useUrlTab
          reads the param on mount) so client-hopping doesn't restart triage
          from the Today view. Search/filter/sort are component state and
          reset — the tab restore alone removes most of the cost. */}
      <BackToPortfolioLink />

      <WorkspaceHeader
        eyebrow="Client 360"
        title={client.legalName}
        titleTestId="text-client-name"
        description={`${client.totalInvoices} invoices · ${humanize(client.penaltyRisk)} penalty risk`}
        status={
          <span className={riskBadgeClasses(client.penaltyRisk)}>
            {humanize(client.penaltyRisk)} risk
          </span>
        }
        actions={<ClientHeaderActions state={state} client={client} />}
      />
      <div>
        <span className="sr-only" aria-live="polite">
          {exportQuery.isFetching ? "Preparing the data export…" : ""}
        </span>
      </div>

      <ClientSummaryStrip client={client} deadlines={deadlines} />

      <SegmentedControl<ClientView>
        items={views}
        value={activeView}
        onChange={setView}
        label="Client workspace view"
      />

      {activeView === "today" && (
        <WorkQueue
          title="Client priorities"
          description="Submission failures and statutory deadlines, ordered for action."
          items={workItems}
          emptyTitle="This client is on track"
          emptyDescription="No failed submissions or current deadlines require attention."
        />
      )}

      <ClientViewPanels
        state={state}
        client={client}
        invoices={invoices}
        deadlines={deadlines}
      />

      <OffboardClientDialog state={state} legalName={client.legalName} />
    </div>
  );
}

// The unit suite (client-detail.test.ts) pins these through this module, so
// the split keeps the page's import path as its surface.
export {
  CLIENT_VIEW_FEATURES,
  visibleClientViews,
  exportFilename,
  canOffboardClient,
  offboardConfirmReady,
  OFFBOARD_EXPLANATION,
  offboardErrorNote,
  offboardSummary,
  packPdfFilename,
  currentMonthStart,
} from "./helpers";
