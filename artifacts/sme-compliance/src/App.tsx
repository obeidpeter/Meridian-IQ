import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { RequireSession } from "@/components/require-session";
import { Dashboard } from "@/pages/dashboard";
import { Invoices } from "@/pages/invoices";
import { InvoiceNew } from "@/pages/invoice-new";
import { InvoiceDetail } from "@/pages/invoice-detail";
import { Bills } from "@/pages/bills";
import { Vat } from "@/pages/vat";
import { Recurring } from "@/pages/recurring";
import { Import } from "@/pages/import";
import { Reconciliation } from "@/pages/reconciliation";
import { B2cReports } from "@/pages/b2c";
import { Obligations } from "@/pages/obligations";
import { Filings } from "@/pages/filings";
import { Wht } from "@/pages/wht";
import { Calendar } from "@/pages/calendar";
import { Alerts } from "@/pages/alerts";
import { Consent } from "@/pages/consent";
import { ClerkCapture } from "@/pages/clerk-capture";
import { ClerkAsk } from "@/pages/clerk-ask";
import { MonthEnd } from "@/pages/month-end";
import { Collections } from "@/pages/collections";
import { Analytics } from "@/pages/analytics";
import { Notifications } from "@/pages/notifications";

// A 401 must not retry-spin — the session guard redirects to the portal instead.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err: unknown) => {
        const status = errorStatus(err);
        if (status && status >= 400 && status < 500) return false;
        return count < 2;
      },
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/month-end" component={MonthEnd} />
        <Route path="/collections" component={Collections} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/notifications" component={Notifications} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/invoices/new" component={InvoiceNew} />
        <Route path="/invoices/:id" component={InvoiceDetail} />
        <Route path="/bills" component={Bills} />
        <Route path="/vat" component={Vat} />
        <Route path="/recurring" component={Recurring} />
        <Route path="/import" component={Import} />
        {/* Both pages self-gate on their capability (clerk.capture /
            clerk.ask), so a direct URL hit by the wrong role gets an
            explanation instead of 403s. */}
        <Route path="/clerk" component={ClerkCapture} />
        <Route path="/clerk/ask" component={ClerkAsk} />
        <Route path="/reconciliation" component={Reconciliation} />
        <Route path="/b2c" component={B2cReports} />
        <Route path="/obligations" component={Obligations} />
        <Route path="/filings" component={Filings} />
        <Route path="/wht" component={Wht} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/consent" component={Consent} />
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
          <RequireSession>
            <Router />
          </RequireSession>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
