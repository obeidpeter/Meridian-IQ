import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout";
import { Dashboard } from "@/pages/dashboard";
import { Invoices } from "@/pages/invoices";
import { InvoiceNew } from "@/pages/invoice-new";
import { InvoiceDetail } from "@/pages/invoice-detail";
import { Import } from "@/pages/import";
import { Reconciliation } from "@/pages/reconciliation";
import { B2cReports } from "@/pages/b2c";
import { Calendar } from "@/pages/calendar";
import { Alerts } from "@/pages/alerts";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/invoices/new" component={InvoiceNew} />
        <Route path="/invoices/:id" component={InvoiceDetail} />
        <Route path="/import" component={Import} />
        <Route path="/reconciliation" component={Reconciliation} />
        <Route path="/b2c" component={B2cReports} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/alerts" component={Alerts} />
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
