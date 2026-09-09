import { webSession, lazyRoute, SessionBoundary } from "@workspace/web-ui";
import { Switch, Route, Router as WouterRouter } from "wouter";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
const NotFound = lazyRoute(() => import("@/pages/not-found"));
import { errorStatus } from "@/lib/errors";

import { Layout } from "@/components/layout";
import { RequireSession } from "@/components/require-session";
import { RequireConsentCapture } from "@/components/require-consent-capture";
const Dashboard = lazyRoute(() =>
  import("@/pages/dashboard").then((module) => ({ default: module.Dashboard })),
);
const BusinessDetails = lazyRoute(() => import("@/pages/business-details"));
const Invoices = lazyRoute(() =>
  import("@/pages/invoices").then((module) => ({ default: module.Invoices })),
);
const InvoiceNew = lazyRoute(() =>
  import("@/pages/invoice-new").then((module) => ({
    default: module.InvoiceNew,
  })),
);
const InvoiceDetail = lazyRoute(() =>
  import("@/pages/invoice-detail").then((module) => ({
    default: module.InvoiceDetail,
  })),
);
const Bills = lazyRoute(() =>
  import("@/pages/bills").then((module) => ({ default: module.Bills })),
);
const Vat = lazyRoute(() =>
  import("@/pages/vat").then((module) => ({ default: module.Vat })),
);
const Recurring = lazyRoute(() =>
  import("@/pages/recurring").then((module) => ({ default: module.Recurring })),
);
const Import = lazyRoute(() =>
  import("@/pages/import").then((module) => ({ default: module.Import })),
);
const Reconciliation = lazyRoute(() =>
  import("@/pages/reconciliation").then((module) => ({
    default: module.Reconciliation,
  })),
);
const B2cReports = lazyRoute(() =>
  import("@/pages/b2c").then((module) => ({ default: module.B2cReports })),
);
const Obligations = lazyRoute(() =>
  import("@/pages/obligations").then((module) => ({
    default: module.Obligations,
  })),
);
const Filings = lazyRoute(() =>
  import("@/pages/filings").then((module) => ({ default: module.Filings })),
);
const Wht = lazyRoute(() =>
  import("@/pages/wht").then((module) => ({ default: module.Wht })),
);
const Calendar = lazyRoute(() =>
  import("@/pages/calendar").then((module) => ({ default: module.Calendar })),
);
const Alerts = lazyRoute(() =>
  import("@/pages/alerts").then((module) => ({ default: module.Alerts })),
);
const Consent = lazyRoute(() =>
  import("@/pages/consent").then((module) => ({ default: module.Consent })),
);
const ClerkCapture = lazyRoute(() =>
  import("@/pages/clerk-capture").then((module) => ({
    default: module.ClerkCapture,
  })),
);
const ClerkAsk = lazyRoute(() =>
  import("@/pages/clerk-ask").then((module) => ({ default: module.ClerkAsk })),
);
const MonthEnd = lazyRoute(() =>
  import("@/pages/month-end").then((module) => ({ default: module.MonthEnd })),
);
const Collections = lazyRoute(() =>
  import("@/pages/collections").then((module) => ({
    default: module.Collections,
  })),
);
const Analytics = lazyRoute(() =>
  import("@/pages/analytics").then((module) => ({ default: module.Analytics })),
);
const Notifications = lazyRoute(() =>
  import("@/pages/notifications").then((module) => ({
    default: module.Notifications,
  })),
);
const Help = lazyRoute(() =>
  import("@/pages/help").then((module) => ({ default: module.Help })),
);
const ActivityPage = lazyRoute(() =>
  import("@/pages/activity").then((module) => ({
    default: module.ActivityPage,
  })),
);
const loadTodayWorkspace = () => import("@/pages/today");
const Today = lazyRoute(() =>
  loadTodayWorkspace().then((module) => ({ default: module.Today })),
);
const WorkPage = lazyRoute(() =>
  loadTodayWorkspace().then((module) => ({ default: module.WorkPage })),
);
const InvoiceRooms = lazyRoute(() =>
  import("@/pages/invoice-rooms").then((module) => ({
    default: module.InvoiceRooms,
  })),
);

// A 401 must not retry-spin — the session guard redirects to the portal instead.
const queryClient = new QueryClient({
  mutationCache: new MutationCache(webSession.mutationCacheOptions),
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
        <Route path="/" component={Today} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/business" component={BusinessDetails} />
        <Route path="/work" component={WorkPage} />
        <Route path="/month-end" component={MonthEnd} />
        <Route path="/collections" component={Collections} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/notifications" component={Notifications} />
        <Route path="/activity" component={ActivityPage} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/invoices/new" component={InvoiceNew} />
        <Route path="/invoices/:id" component={InvoiceDetail} />
        <Route path="/invoice-rooms" component={InvoiceRooms} />
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
        <Route path="/help" component={Help} />
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
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <RequireSession>
              {/* CORE-03 first landing (D15): a business decides on its
                consent layers once, before the workspace ever renders. */}
              <RequireConsentCapture>
                <Router />
              </RequireConsentCapture>
            </RequireSession>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </SessionBoundary>
    </QueryClientProvider>
  );
}

export default App;
