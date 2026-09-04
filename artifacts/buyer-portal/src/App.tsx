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
const Confirmations = lazyRoute(() =>
  import("@/pages/confirmations").then((module) => ({
    default: module.Confirmations,
  })),
);
const InvoiceRespond = lazyRoute(() =>
  import("@/pages/invoice-respond").then((module) => ({
    default: module.InvoiceRespond,
  })),
);
const Suppliers = lazyRoute(() =>
  import("@/pages/suppliers").then((module) => ({ default: module.Suppliers })),
);
const SupplierDetail = lazyRoute(() =>
  import("@/pages/supplier-detail").then((module) => ({
    default: module.SupplierDetail,
  })),
);
const Scoreboard = lazyRoute(() =>
  import("@/pages/scoreboard").then((module) => ({
    default: module.Scoreboard,
  })),
);
const Notifications = lazyRoute(() =>
  import("@/pages/notifications").then((module) => ({
    default: module.Notifications,
  })),
);
const Today = lazyRoute(() =>
  import("@/pages/today").then((module) => ({ default: module.Today })),
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

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Today} />
        <Route path="/confirmations" component={Confirmations} />
        <Route path="/invoices/:id" component={InvoiceRespond} />
        <Route path="/suppliers" component={Suppliers} />
        <Route path="/suppliers/:id" component={SupplierDetail} />
        <Route path="/scoreboard" component={Scoreboard} />
        <Route path="/notifications" component={Notifications} />
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
            <RequireSession allow={["buyer_user"]}>
              <Router />
            </RequireSession>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </SessionBoundary>
    </QueryClientProvider>
  );
}

export default App;
