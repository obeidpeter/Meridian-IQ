import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { RequireSession } from "@/components/require-session";
import { CapabilityGate } from "@/components/capability-gate";
import { Portfolio, PortfolioSkeleton } from "@/pages/portfolio";
import { ClientDetail } from "@/pages/client-detail";
import { ClientImport } from "@/pages/client-import";
import { Pipeline } from "@/pages/pipeline";
import { UnearnedIncomePage } from "@/pages/unearned-income";
import { Billing } from "@/pages/billing";
import { OperatorQueue } from "@/pages/operator-queue";
import { PlatformOps } from "@/pages/platform-ops";
import { FeatureFlags } from "@/pages/feature-flags";
import { Statements } from "@/pages/statements";
import { WhiteLabel } from "@/pages/whitelabel";
import { Certification } from "@/pages/certification";
import { Advisory } from "@/pages/advisory";
import { Integrations } from "@/pages/integrations";
import { Catalogue } from "@/pages/catalogue";
import { AuditEvidence } from "@/pages/audit-evidence";
import { GateMetrics } from "@/pages/gate-metrics";
import { Parties } from "@/pages/parties";
import { Clerk } from "@/pages/clerk";
import { ClerkCase } from "@/pages/clerk-case";
import { ClerkClaims } from "@/pages/clerk-claims";

// Feature-gated routes answer 404 while dark — retrying will not light them
// up, so fail fast to the "not yet enabled" card instead of spinning.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = errorStatus(error);
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

// The console front door is role-aware: firm principals land on the client
// portfolio; the Compliance Desk operator (cross-tenant, no portfolio access)
// lands on the work queue it signed in for.
function Home() {
  const { data: me } = useGetMe();
  // While /me resolves, mirror the most likely destination (the portfolio)
  // instead of a blank pane.
  if (!me) return <PortfolioSkeleton />;
  const caps = new Set(me.capabilities);
  if (!caps.has("console.portfolio.read") && caps.has("operator.queue.read")) {
    return <Redirect to="/operator-queue" replace />;
  }
  return (
    <CapabilityGate capability="console.portfolio.read">
      <Portfolio />
    </CapabilityGate>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        {/* Static /clients/import must register before the /clients/:id param route. */}
        <Route path="/clients/import">
          <CapabilityGate capability="clients.import">
            <ClientImport />
          </CapabilityGate>
        </Route>
        <Route path="/clients/:id">
          <CapabilityGate capability="console.portfolio.read">
            <ClientDetail />
          </CapabilityGate>
        </Route>
        <Route path="/pipeline">
          <CapabilityGate capability="console.portfolio.read">
            <Pipeline />
          </CapabilityGate>
        </Route>
        <Route path="/unearned-income">
          <CapabilityGate capability="console.portfolio.read">
            <UnearnedIncomePage />
          </CapabilityGate>
        </Route>
        <Route path="/billing">
          <CapabilityGate capability="billing.read">
            <Billing />
          </CapabilityGate>
        </Route>
        <Route path="/whitelabel">
          <CapabilityGate capability="theme.write">
            <WhiteLabel />
          </CapabilityGate>
        </Route>
        <Route path="/certification">
          <CapabilityGate capability="certification.read">
            <Certification />
          </CapabilityGate>
        </Route>
        <Route path="/advisory">
          <CapabilityGate capability="engagement.write">
            <Advisory />
          </CapabilityGate>
        </Route>
        <Route path="/integrations">
          <CapabilityGate capability="connector.read">
            <Integrations />
          </CapabilityGate>
        </Route>
        <Route path="/operator-queue">
          <CapabilityGate capability="operator.queue.read">
            <OperatorQueue />
          </CapabilityGate>
        </Route>
        <Route path="/parties">
          <CapabilityGate capability="party.merge">
            <Parties />
          </CapabilityGate>
        </Route>
        <Route path="/catalogue">
          <CapabilityGate capability="catalogue.write">
            <Catalogue />
          </CapabilityGate>
        </Route>
        {/* Static /clerk/claims and the param route register before /clerk. */}
        <Route path="/clerk/claims">
          <CapabilityGate capability="clerk.read">
            <ClerkClaims />
          </CapabilityGate>
        </Route>
        <Route path="/clerk/cases/:id">
          <CapabilityGate capability="clerk.read">
            <ClerkCase />
          </CapabilityGate>
        </Route>
        <Route path="/clerk">
          <CapabilityGate capability="clerk.read">
            <Clerk />
          </CapabilityGate>
        </Route>
        <Route path="/platform-ops">
          <CapabilityGate capability="operator.queue.read">
            <PlatformOps />
          </CapabilityGate>
        </Route>
        <Route path="/gate-metrics">
          <CapabilityGate capability="operator.queue.read">
            <GateMetrics />
          </CapabilityGate>
        </Route>
        <Route path="/audit">
          <CapabilityGate capability="audit.read">
            <AuditEvidence />
          </CapabilityGate>
        </Route>
        <Route path="/feature-flags">
          <CapabilityGate capability="flags.read">
            <FeatureFlags />
          </CapabilityGate>
        </Route>
        <Route path="/statements">
          <CapabilityGate capability="billing.read">
            <Statements />
          </CapabilityGate>
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RequireSession
          allowedRoles={["firm_admin", "operator", "firm_staff", "auditor"]}
        >
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </RequireSession>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
