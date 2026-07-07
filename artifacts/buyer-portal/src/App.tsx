import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { Confirmations } from "@/pages/confirmations";
import { InvoiceRespond } from "@/pages/invoice-respond";
import { Suppliers } from "@/pages/suppliers";
import { Scoreboard } from "@/pages/scoreboard";

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
        <Route path="/" component={Confirmations} />
        <Route path="/invoices/:id" component={InvoiceRespond} />
        <Route path="/suppliers" component={Suppliers} />
        <Route path="/scoreboard" component={Scoreboard} />
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
