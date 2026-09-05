import {
  webSession,
  lazyRoute,
  SessionBoundary,
  RouteLoading,
} from "@workspace/web-ui";
import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
const NotFound = lazyRoute(() => import("@/pages/not-found"));
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { RequireSession } from "@/components/require-session";
import { CapabilityGate, RoleGate } from "@/components/capability-gate";
const Portfolio = lazyRoute(() =>
  import("@/pages/portfolio").then((module) => ({ default: module.Portfolio })),
);
const ClientDetail = lazyRoute(() =>
  import("@/pages/client-detail").then((module) => ({
    default: module.ClientDetail,
  })),
);
const ClientImport = lazyRoute(() =>
  import("@/pages/client-import").then((module) => ({
    default: module.ClientImport,
  })),
);
const Pipeline = lazyRoute(() =>
  import("@/pages/pipeline").then((module) => ({ default: module.Pipeline })),
);
const UnearnedIncomePage = lazyRoute(() =>
  import("@/pages/unearned-income").then((module) => ({
    default: module.UnearnedIncomePage,
  })),
);
const Billing = lazyRoute(() =>
  import("@/pages/billing").then((module) => ({ default: module.Billing })),
);
const OperatorQueue = lazyRoute(() =>
  import("@/pages/operator-queue").then((module) => ({
    default: module.OperatorQueue,
  })),
);
const PlatformOps = lazyRoute(() =>
  import("@/pages/platform-ops").then((module) => ({
    default: module.PlatformOps,
  })),
);
const FeatureFlags = lazyRoute(() =>
  import("@/pages/feature-flags").then((module) => ({
    default: module.FeatureFlags,
  })),
);
const Statements = lazyRoute(() =>
  import("@/pages/statements").then((module) => ({
    default: module.Statements,
  })),
);
const WhiteLabel = lazyRoute(() =>
  import("@/pages/whitelabel").then((module) => ({
    default: module.WhiteLabel,
  })),
);
const Certification = lazyRoute(() =>
  import("@/pages/certification").then((module) => ({
    default: module.Certification,
  })),
);
const Advisory = lazyRoute(() =>
  import("@/pages/advisory").then((module) => ({ default: module.Advisory })),
);
const Integrations = lazyRoute(() =>
  import("@/pages/integrations").then((module) => ({
    default: module.Integrations,
  })),
);
const ApiAccess = lazyRoute(() =>
  import("@/pages/api-access").then((module) => ({
    default: module.ApiAccess,
  })),
);
const Catalogue = lazyRoute(() =>
  import("@/pages/catalogue").then((module) => ({ default: module.Catalogue })),
);
const AuditEvidence = lazyRoute(() =>
  import("@/pages/audit-evidence").then((module) => ({
    default: module.AuditEvidence,
  })),
);
const ControlCentre = lazyRoute(() =>
  import("@/pages/control-centre").then((module) => ({
    default: module.ControlCentre,
  })),
);
const Parties = lazyRoute(() =>
  import("@/pages/parties").then((module) => ({ default: module.Parties })),
);
const Invitations = lazyRoute(() =>
  import("@/pages/invitations").then((module) => ({
    default: module.Invitations,
  })),
);
const AccessReview = lazyRoute(() =>
  import("@/pages/access-review").then((module) => ({
    default: module.AccessReview,
  })),
);
const ClerkClaims = lazyRoute(() =>
  import("@/pages/clerk-claims").then((module) => ({
    default: module.ClerkClaims,
  })),
);
const ClerkWorkspace = lazyRoute(() =>
  import("@/pages/clerk").then((module) => ({
    default: module.ClerkWorkspace,
  })),
);
const ClerkAskPage = lazyRoute(() =>
  import("@/pages/clerk-ask").then((module) => ({
    default: module.ClerkAskPage,
  })),
);
const ClerkHealthPage = lazyRoute(() =>
  import("@/pages/clerk-health").then((module) => ({
    default: module.ClerkHealthPage,
  })),
);
const Notifications = lazyRoute(() =>
  import("@/pages/notifications").then((module) => ({
    default: module.Notifications,
  })),
);
const Help = lazyRoute(() =>
  import("@/pages/help").then((module) => ({ default: module.Help })),
);
const FilingDesk = lazyRoute(() =>
  import("@/pages/filing-desk").then((module) => ({
    default: module.FilingDesk,
  })),
);
const CollectionsDesk = lazyRoute(() =>
  import("@/pages/collections-desk").then((module) => ({
    default: module.CollectionsDesk,
  })),
);
const PracticeAnalytics = lazyRoute(() =>
  import("@/pages/analytics").then((module) => ({
    default: module.PracticeAnalytics,
  })),
);
const ActivityPage = lazyRoute(() =>
  import("@/pages/activity").then((module) => ({
    default: module.ActivityPage,
  })),
);
const Today = lazyRoute(() =>
  import("@/pages/today").then((module) => ({ default: module.Today })),
);
const WorkPage = lazyRoute(() =>
  import("@/pages/today").then((module) => ({ default: module.WorkPage })),
);
import { ClerkShell } from "@/components/clerk-shell";
const BankDataRoom = lazyRoute(() =>
  import("@/pages/bank-data-room").then((module) => ({
    default: module.BankDataRoom,
  })),
);

// Feature-gated routes answer 404 while dark — retrying will not light them
// up, so fail fast to the "not yet enabled" card instead of spinning.
const queryClient = new QueryClient({
  mutationCache: new MutationCache(webSession.mutationCacheOptions),
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

// The console front door is role-aware: firm principals land on Meridian
// Today, operators on activation evidence, and auditors on the evidence
// surface they signed in to inspect.
function Home() {
  const { data: me } = useGetMe();
  // While /me resolves, reuse the established portfolio skeleton instead of
  // flashing a blank pane before the role redirect resolves.
  if (!me) return <RouteLoading />;
  if (me.role === "operator") {
    return <Redirect to="/control-centre/activation" replace />;
  }
  if (me.role === "auditor") {
    return <Redirect to="/audit" replace />;
  }
  if (me.role === "bank_user") {
    return <Redirect to="/data-room" replace />;
  }
  return <Redirect to="/today" replace />;
}

function Router() {
  return (
    <Switch>
      {/* The Clerk AI workspace is its own product surface: these routes
          render full-bleed inside the ClerkShell (dark rail) instead of the
          standard console Layout. Static sub-routes register before the bare
          /clerk route. Claims reads are gated on claims.read; everything else
          on clerk.use — the server enforces the write capabilities. */}
      <Route path="/clerk/claims">
        <ClerkShell>
          <CapabilityGate capability="claims.read">
            <ClerkClaims />
          </CapabilityGate>
        </ClerkShell>
      </Route>
      <Route path="/clerk/ask">
        <ClerkShell>
          <CapabilityGate capability="clerk.use">
            <ClerkAskPage />
          </CapabilityGate>
        </ClerkShell>
      </Route>
      <Route path="/clerk/health">
        <ClerkShell>
          <CapabilityGate capability="clerk.use">
            <ClerkHealthPage />
          </CapabilityGate>
        </ClerkShell>
      </Route>
      <Route path="/clerk">
        <ClerkShell>
          <CapabilityGate capability="clerk.use">
            <ClerkWorkspace />
          </CapabilityGate>
        </ClerkShell>
      </Route>
      <Route>
        <ConsoleRoutes />
      </Route>
    </Switch>
  );
}

function ConsoleRoutes() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/today">
          <CapabilityGate capability="console.portfolio.read">
            <Today />
          </CapabilityGate>
        </Route>
        <Route path="/portfolio">
          <CapabilityGate capability="console.portfolio.read">
            <Portfolio />
          </CapabilityGate>
        </Route>
        <Route path="/work">
          <CapabilityGate capability="work.read">
            <WorkPage />
          </CapabilityGate>
        </Route>
        <Route path="/notifications" component={Notifications} />
        <Route path="/activity" component={ActivityPage} />
        <Route path="/help" component={Help} />
        <Route path="/data-room">
          <CapabilityGate capability="credit.data_room.read">
            <BankDataRoom />
          </CapabilityGate>
        </Route>
        <Route path="/filing-desk">
          <CapabilityGate capability="filing.read">
            <FilingDesk />
          </CapabilityGate>
        </Route>
        <Route path="/collections">
          <CapabilityGate capability="console.portfolio.read">
            <CollectionsDesk />
          </CapabilityGate>
        </Route>
        <Route path="/analytics">
          <CapabilityGate capability="console.portfolio.read">
            <PracticeAnalytics />
          </CapabilityGate>
        </Route>
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
        <Route path="/invitations">
          <CapabilityGate capability="invitation.write">
            <Invitations />
          </CapabilityGate>
        </Route>
        <Route path="/access-review">
          <CapabilityGate capability="access.review">
            <AccessReview />
          </CapabilityGate>
        </Route>
        <Route path="/integrations">
          <CapabilityGate capability="connector.read">
            <Integrations />
          </CapabilityGate>
        </Route>
        {/* API keys/webhooks are firm-level administration: the server gates
            on the explicit firm_admin role (not a capability), so the route
            mirrors that with RoleGate. */}
        <Route path="/api-access">
          <RoleGate role="firm_admin">
            <ApiAccess />
          </RoleGate>
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
        <Route path="/platform-ops">
          <CapabilityGate capability="operator.queue.read">
            <PlatformOps />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/activation">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="activation" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/buyers">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="buyers" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/cases">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="cases" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/reliability">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="reliability" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/evidence">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="evidence" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/clerk">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="clerk" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre/credit">
          <CapabilityGate capability="operator.queue.read">
            <ControlCentre section="credit" />
          </CapabilityGate>
        </Route>
        <Route path="/control-centre">
          <Redirect to="/control-centre/activation" replace />
        </Route>
        <Route path="/gate-metrics">
          <Redirect to="/control-centre/activation" replace />
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
        {/* The register used to live at /claims — keep old links working.
            (/clerk/* itself is routed above, outside this Layout.) */}
        <Route path="/claims">
          <Redirect to="/clerk/claims" replace />
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
      <SessionBoundary client={queryClient}>
        <TooltipProvider>
          <RequireSession
            allowedRoles={[
              "firm_admin",
              "operator",
              "firm_staff",
              "auditor",
              "bank_user",
            ]}
          >
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
          </RequireSession>
          <Toaster />
        </TooltipProvider>
      </SessionBoundary>
    </QueryClientProvider>
  );
}

export default App;
