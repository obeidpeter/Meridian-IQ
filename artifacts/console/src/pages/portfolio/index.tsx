// The console portfolio page (R117 split the 2,791-line file into this
// shell, one module per card family, the client workbench, the layout
// pieces and the pure helpers). The route (App.tsx), the unit suite
// (portfolio.test.ts) and the collections desk keep importing
// "@/pages/portfolio" / "./portfolio": this module is the page's surface.

import { useEffect, useRef } from "react";
import { useGetMe, useGetPortfolio } from "@workspace/api-client-react";
import { AutomationRollupCard } from "@/components/automation-rollup-card";
import { AutomationEvidenceCard } from "@/components/automation-evidence-card";
import { BillingStatementCard } from "@/components/billing-statement-card";
import { ClerkWeeklyDigestCard } from "@/components/clerk-digest-card";
import { GovernanceCard } from "@/components/governance-card";
import { VatPositionsCard } from "@/components/vat-positions-card";
import { FilingMatrixCard } from "@/components/filing-matrix-card";
import { StaffNotificationPrefsCard } from "@/components/staff-notification-prefs-card";
import { StatementConnectionsCard } from "@/components/statement-connections-card";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  SegmentedControl,
  WorkQueue,
  useUrlParam,
  useUrlTab,
  useSavedViews,
  type SavedView,
} from "@workspace/web-ui";
import { canImportClients } from "./helpers";
import { VatPackCard, VatPositionCard, VatSettlementCard } from "./vat-cards";
import {
  PortfolioHeader,
  PortfolioSection,
  PortfolioSkeleton,
  PortfolioSummaryStrip,
} from "./layout";
import {
  CLIENT_RISK_FILTERS,
  CLIENT_SCOPES,
  CLIENT_SORTS,
  PORTFOLIO_VIEWS,
  defaultClientScope,
  scopeClients,
} from "./client-scope";
import type {
  ClientRiskFilter,
  ClientScope,
  ClientSort,
  PortfolioView,
} from "./client-scope";
import {
  ComplianceCalendarCard,
  RejectionPatternsCard,
} from "./compliance-cards";
import { ReceivablesCard } from "./receivables-card";
import { ClientWorkbenchTable, SavedViewsBar } from "./client-workbench";
import { ClerkAdoptionCard, ComplianceScorecardCard } from "./scorecard-cards";
import { GettingStartedCard } from "./getting-started-card";
import { EmptyBookCard } from "./empty-book-card";
import { firmPriorities } from "./priorities";
import { QuarterlyReviewCard } from "./quarterly-review-card";
import { useGettingStarted } from "./use-getting-started";
import { usePortfolioOccupancy } from "./use-portfolio-occupancy";

export function Portfolio() {
  usePageTitle("Client portfolio");
  const { toast } = useToast();
  const [view, setView] = useUrlTab<PortfolioView>(
    "view",
    "today",
    PORTFOLIO_VIEWS,
  );
  const [clientSearch, setClientSearch] = useUrlParam("q");
  const [clientRisk, setClientRisk] = useUrlTab<ClientRiskFilter>(
    "risk",
    "all",
    CLIENT_RISK_FILTERS,
  );
  const [clientSort, setClientSort] = useUrlTab<ClientSort>(
    "sort",
    "risk",
    CLIENT_SORTS,
  );
  const [requestedAction, setRequestedAction] = useUrlParam("action");
  const { data: me } = useGetMe();
  const savedPortfolioViews = useSavedViews(
    me ? `meridianiq:saved-view-portfolio:${me.userId}` : null,
  );
  const { data, isLoading, error, refetch } = useGetPortfolio();
  const [clientScope, setClientScope] = useUrlTab<ClientScope>(
    "scope",
    "all",
    CLIENT_SCOPES,
  );
  // useUrlTab latches its fallback on first render, and the data-driven
  // default ("mine" for staff with assignments) is only knowable once the
  // portfolio and /me have loaded — so apply it once, and only when the URL
  // carries no explicit scope, so a deliberate switch back to "all" sticks.
  const scopeDefaulted = useRef(false);
  useEffect(() => {
    if (scopeDefaulted.current || !data || !me) return;
    scopeDefaulted.current = true;
    const explicit = new URLSearchParams(window.location.search).get("scope");
    if (explicit) return;
    if (defaultClientScope(me.role, data.clients, me.userId) === "mine") {
      setClientScope("mine");
    }
  }, [data, me, setClientScope]);
  const canImport = canImportClients(me);

  const applySavedView = (saved: SavedView) => {
    setView("clients");
    setClientSearch(saved.params.q ?? "");
    setClientRisk(
      CLIENT_RISK_FILTERS.includes(saved.params.risk as ClientRiskFilter)
        ? (saved.params.risk as ClientRiskFilter)
        : "all",
    );
    setClientSort(
      CLIENT_SORTS.includes(saved.params.sort as ClientSort)
        ? (saved.params.sort as ClientSort)
        : "risk",
    );
  };

  const savePortfolioView = (name: string) => {
    const saved = savedPortfolioViews.save(name, {
      q: clientSearch,
      risk: clientRisk,
      sort: clientSort,
    });
    if (saved) {
      toast({ title: `Saved view “${saved.name}”` });
    }
  };

  const {
    steps,
    showGettingStarted,
    handleDismissGettingStarted,
    openAddClient,
    addClientDialog,
  } = useGettingStarted({ data, requestedAction, setRequestedAction });

  const hasBook = !!data && data.clients.length > 0;
  const { complianceOccupied, connectionsOccupied } = usePortfolioOccupancy({
    hasBook,
    role: me?.role,
  });

  if (isLoading) {
    return <PortfolioSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Review penalty risks, filing deadlines and unpaid invoices across your clients."
          canImport={canImport}
          onAddClient={openAddClient}
        />
        <QueryError thing="your portfolio" onRetry={() => refetch()} />
        {addClientDialog}
      </div>
    );
  }

  const clients = [...data.clients].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.penaltyRisk] - order[b.penaltyRisk];
  });

  const clientNeedle = clientSearch.trim().toLowerCase();
  const scopedClients = scopeClients(clients, clientScope, me?.userId);
  const scopeCounts = {
    mine: scopeClients(clients, "mine", me?.userId).length,
    all: clients.length,
  };
  const visibleClients = scopedClients
    .filter(
      (client) =>
        (clientRisk === "all" || client.penaltyRisk === clientRisk) &&
        (!clientNeedle ||
          client.legalName.toLowerCase().includes(clientNeedle)),
    )
    .sort((a, b) => {
      if (clientSort === "name") return a.legalName.localeCompare(b.legalName);
      if (clientSort === "unsubmitted") {
        return Number(b.unsubmittedValue) - Number(a.unsubmittedValue);
      }
      if (clientSort === "deadline") {
        const aDate = a.nextDeadline?.dueDate ?? "9999-12-31";
        const bDate = b.nextDeadline?.dueDate ?? "9999-12-31";
        return aDate.localeCompare(bDate);
      }
      const order = { high: 0, medium: 1, low: 2 } as const;
      return order[a.penaltyRisk] - order[b.penaltyRisk];
    });
  const attentionClients = scopedClients
    .filter((client) => client.penaltyRisk !== "low")
    .slice(0, 6);
  const workItems = firmPriorities(data, {
    reviewClients: () => {
      setClientRisk("high");
      setView("clients");
    },
    openClients: () => setView("clients"),
    openCompliance: () => setView("compliance"),
    openMoney: () => setView("money"),
  });

  const portfolioViews: Array<{
    value: PortfolioView;
    label: string;
    count?: number;
  }> = [
    { value: "today", label: "Today", count: workItems.length },
    { value: "clients", label: "Clients", count: data.clientCount },
    { value: "money", label: "Money", count: data.totalUnsubmittedCount },
    {
      value: "compliance",
      label: "Compliance",
      count: data.totalOverdueCount,
    },
    { value: "automation", label: "Automation" },
  ];
  if (connectionsOccupied) {
    portfolioViews.push({ value: "connections", label: "Connections" });
  }

  // First-run empty state: the query succeeded but the book is empty — show
  // the way in (bulk import / pipeline) instead of a wall of zeros.
  if (clients.length === 0) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Add clients to start tracking risks, deadlines and unpaid invoices."
          canImport={canImport}
          onAddClient={openAddClient}
        />
        {showGettingStarted && (
          <GettingStartedCard
            steps={steps}
            onAddClient={openAddClient}
            onDismiss={handleDismissGettingStarted}
          />
        )}
        <EmptyBookCard canImport={canImport} onAddClient={openAddClient} />
        {addClientDialog}
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
        onAddClient={openAddClient}
      />

      {showGettingStarted && (
        <GettingStartedCard
          steps={steps}
          onAddClient={openAddClient}
          onDismiss={handleDismissGettingStarted}
        />
      )}

      <PortfolioSummaryStrip data={data} />

      <SegmentedControl<PortfolioView>
        items={portfolioViews}
        value={view}
        onChange={setView}
        label="Portfolio view"
      />

      {view === "today" && (
        <>
          <WorkQueue
            title="Firm priorities"
            description="Ordered by client risk, failures, statutory deadlines and unsubmitted value."
            items={workItems}
            emptyTitle="The firm queue is clear"
            emptyDescription="No high-risk clients, failures or overdue deadlines need action."
          />
          {attentionClients.length > 0 && (
            <ClientWorkbenchTable
              clients={attentionClients}
              totalClients={data.clientCount}
              scope={clientScope}
              onScopeChange={setClientScope}
              scopeCounts={scopeCounts}
              search={clientSearch}
              onSearchChange={setClientSearch}
              risk={clientRisk}
              onRiskChange={setClientRisk}
              sort={clientSort}
              onSortChange={setClientSort}
              compact
            />
          )}
        </>
      )}

      {(view === "clients" || view === "automation") && (
        <PortfolioSection
          id={view === "clients" ? "clients" : "automation"}
          label={view === "clients" ? "Clients" : "Automation & Clerk"}
        >
          {view === "clients" && (
            <ClientWorkbenchTable
              toolbar={
                <SavedViewsBar
                  views={savedPortfolioViews.views}
                  onApply={applySavedView}
                  onSave={savePortfolioView}
                  onRemove={(saved) => {
                    savedPortfolioViews.remove(saved.id);
                    toast({ title: `Deleted view “${saved.name}”` });
                  }}
                />
              }
              clients={visibleClients}
              totalClients={data.clientCount}
              scope={clientScope}
              onScopeChange={setClientScope}
              scopeCounts={scopeCounts}
              search={clientSearch}
              onSearchChange={setClientSearch}
              risk={clientRisk}
              onRiskChange={setClientRisk}
              sort={clientSort}
              onSortChange={setClientSort}
            />
          )}
          {view === "clients" && <ComplianceScorecardCard />}
          {view === "automation" && <ClerkAdoptionCard />}
          {/* The firm's standing-automation posture (round 33) sits with the
          adoption card — both answer "what is Clerk doing across our
          clients". Self-gating: renders only with an automation footprint. */}
          {view === "automation" && <AutomationRollupCard />}
          {/* The backtest evidence (round 36) sits directly under the rollup:
          the rollup says what standing automation IS doing, the evidence
          says what the dark kinds WOULD have done — the pair a firm reads
          before lighting a flag. Self-gating on ledger footprint. */}
          {view === "automation" && <AutomationEvidenceCard />}
        </PortfolioSection>
      )}

      {view === "money" && (
        <PortfolioSection id="money" label="Money">
          <ReceivablesCard />
          <BillingStatementCard />
        </PortfolioSection>
      )}

      {/* The two all-self-gating sections render only when at least one
          member card will show — otherwise a role or server build that hides
          every card would leave a bare heading behind a dead anchor chip. */}
      {view === "compliance" && complianceOccupied && (
        <PortfolioSection id="compliance" label="Compliance">
          <ComplianceCalendarCard />
          <VatPackCard />
          <VatPositionsCard />
          {/* The filing cockpit (Filing Desk phase 3) sits with the VAT
              positions it acts on: on the 21st of the month the partner
              needs one grid of who has filed and who hasn't — every
              client's VAT return and PAYE remittance for the period.
              Self-gating render-on-success; the section's occupancy is
              already carried by the other lifted compliance queries, so
              this card's query is not lifted. */}
          <FilingMatrixCard />
          <VatSettlementCard />

          <VatPositionCard />
          <QuarterlyReviewCard />
          <RejectionPatternsCard />
          {/* Practice governance lives with the compliance surfaces it
              shapes — the maker-checker rule gates stamping submissions. */}
          <GovernanceCard />
        </PortfolioSection>
      )}

      {view === "connections" && connectionsOccupied && (
        <PortfolioSection id="connections" label="Connections & delivery">
          {/* Bank-feed connections sit with the delivery surfaces. Render-on-
              success: servers without the rail (older build, feature dark →
              404) show nothing at all. */}
          <StatementConnectionsCard
            clients={clients.map((c) => ({
              clientPartyId: c.clientPartyId,
              legalName: c.legalName,
            }))}
          />
          <ClerkWeeklyDigestCard />
          {/* Digest delivery is what these preferences control, so they live
              beside the digest itself. Firm members only — the card self-gates
              on role, mirroring the server's 403 for everyone else. */}
          <StaffNotificationPrefsCard />
        </PortfolioSection>
      )}

      {addClientDialog}
    </div>
  );
}

// The unit suite (portfolio.test.ts) and the collections desk pin these
// through this module, so the split keeps the page's import path as its
// surface.
export {
  PORTFOLIO_GROUPS,
  calendarHasContent,
  rejectionsHaveContent,
  visiblePortfolioGroups,
  GETTING_STARTED_DISMISS_KEY,
  portfolioInvoiceCount,
  portfolioSubmittedCount,
  hasClientOwnerInvite,
  gettingStartedSteps,
  completedStepCount,
  shouldShowGettingStarted,
  readGettingStartedDismissed,
  writeGettingStartedDismissed,
  canImportClients,
} from "./helpers";
export type { PortfolioGroup, GettingStartedStep } from "./helpers";
export { scopeClients, defaultClientScope } from "./client-scope";
export { ReceivablesCard } from "./receivables-card";
export { PortfolioSkeleton } from "./layout";
