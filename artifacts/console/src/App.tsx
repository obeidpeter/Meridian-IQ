import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { Portfolio } from "@/pages/portfolio";
import { ClientDetail } from "@/pages/client-detail";
import { ClientImport } from "@/pages/client-import";
import { Pipeline } from "@/pages/pipeline";
import { UnearnedIncomePage } from "@/pages/unearned-income";
import { Billing } from "@/pages/billing";
import { OperatorQueue } from "@/pages/operator-queue";
import { Statements } from "@/pages/statements";
import { WhiteLabel } from "@/pages/whitelabel";
import { Certification } from "@/pages/certification";

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

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Portfolio} />
        {/* Static /clients/import must register before the /clients/:id param route. */}
        <Route path="/clients/import" component={ClientImport} />
        <Route path="/clients/:id" component={ClientDetail} />
        <Route path="/pipeline" component={Pipeline} />
        <Route path="/unearned-income" component={UnearnedIncomePage} />
        <Route path="/billing" component={Billing} />
        <Route path="/whitelabel" component={WhiteLabel} />
        <Route path="/certification" component={Certification} />
        <Route path="/operator-queue" component={OperatorQueue} />
        <Route path="/statements" component={Statements} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
