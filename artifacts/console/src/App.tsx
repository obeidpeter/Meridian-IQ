import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout";
import { Portfolio } from "@/pages/portfolio";
import { ClientDetail } from "@/pages/client-detail";
import { Pipeline } from "@/pages/pipeline";
import { UnearnedIncomePage } from "@/pages/unearned-income";
import { Billing } from "@/pages/billing";
import { OperatorQueue } from "@/pages/operator-queue";
import { Statements } from "@/pages/statements";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Portfolio} />
        <Route path="/clients/:id" component={ClientDetail} />
        <Route path="/pipeline" component={Pipeline} />
        <Route path="/unearned-income" component={UnearnedIncomePage} />
        <Route path="/billing" component={Billing} />
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
