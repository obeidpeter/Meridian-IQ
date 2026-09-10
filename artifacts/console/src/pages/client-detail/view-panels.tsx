import type {
  ClientRisk,
  ComplianceDeadline,
  ConsoleInvoice,
} from "@workspace/api-client-react";
import { ClientTeamCard } from "@/components/client-team-card";
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import { ClerkActionEffectivenessCard } from "@/components/clerk-action-effectiveness-card";
import { FilingsCard } from "@/components/filings-card";
import { OnboardingCard } from "@/components/onboarding-card";
import { WhtCard } from "@/components/wht-card";
import { ObligationsCard } from "@/components/obligations-card";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { Landmark } from "lucide-react";
import { AdvisoryBriefCard } from "./advisory-brief-card";
import { CollectionAccountsCard } from "./collection-accounts-card";
import { CompliancePackCard } from "./compliance-pack-card";
import { ClientDeadlinesCard, ClientInvoicesCard } from "./today-cards";
import type { ClientDetailState } from "./use-client-detail";

// The card grid under the view control: every view's cards, each gated on
// the active view and (PL-02) the feature keys the launch profile lights.
export function ClientViewPanels({
  state,
  client,
  invoices,
  deadlines,
}: {
  state: ClientDetailState;
  client: ClientRisk;
  invoices: ConsoleInvoice[];
  deadlines: ComplianceDeadline[];
}) {
  const { id, me, features, activeView, moneyEmpty } = state;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {(activeView === "today" || activeView === "invoices") && (
        <ClientInvoicesCard client={client} invoices={invoices} />
      )}

      {activeView === "today" && <ClientDeadlinesCard deadlines={deadlines} />}

      {activeView === "today" && (
        <ClientTeamCard
          clientPartyId={id}
          canAssign={(me?.capabilities ?? []).includes("client.assign")}
        />
      )}

      {activeView === "money" && (
        <>
          {features.has("collection_accounts") && (
            <CollectionAccountsCard clientPartyId={id} />
          )}
          {features.has("statutory_desks") && <WhtCard clientPartyId={id} />}
          {moneyEmpty && (
            <Card className="lg:col-span-3">
              <EmptyState
                icon={Landmark}
                title="Nothing to reconcile yet"
                description="WHT credits and remittance rows appear here once buyer deductions or WHT-categorised bills are recorded for this client."
                testId="text-money-empty"
              />
            </Card>
          )}
        </>
      )}
      {activeView === "compliance" && (
        <>
          {features.has("client_reports") && (
            <CompliancePackCard clientPartyId={id} />
          )}
          {features.has("statutory_desks") && (
            <>
              <ObligationsCard clientPartyId={id} />
              <FilingsCard clientPartyId={id} />
            </>
          )}
        </>
      )}
      {activeView === "clerk" && (
        <>
          <AdvisoryBriefCard clientPartyId={id} />
          <ClerkActionsCard clientPartyId={id} />
          <ClerkActionEffectivenessCard clientPartyId={id} />
        </>
      )}
      {/* Onboard with Clerk: the evidence-based onboarding checklist —
            steps settle from the record (history, statements, consent,
            duplicates, filings), skips record honest gaps. */}
      {activeView === "setup" && <OnboardingCard clientPartyId={id} />}
    </div>
  );
}
