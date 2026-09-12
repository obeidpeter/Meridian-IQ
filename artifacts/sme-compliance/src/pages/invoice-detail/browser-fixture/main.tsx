import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, useLocation } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InvoiceDetail } from "../index";
import { Invoices } from "../../invoices";
import "../../../index.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Fixture() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location]);
  return (
    <main className="mx-auto min-w-0 max-w-6xl p-4">
      <Switch>
        <Route path="/invoices">
          <Invoices />
        </Route>
        <Route>
          <InvoiceDetail />
        </Route>
      </Switch>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
);
