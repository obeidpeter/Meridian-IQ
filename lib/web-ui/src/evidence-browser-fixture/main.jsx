import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnsavedWorkProvider } from "../unsaved-work";
import ConsoleEvidence, {
  EvidenceWorkspace as ConsoleWorkspace,
} from "../../../../artifacts/console/src/pages/evidence";
import SmeEvidence, {
  EvidenceWorkspace as SmeWorkspace,
} from "../../../../artifacts/sme-compliance/src/pages/evidence";
import "../../../../artifacts/console/src/index.css";

const params = new URLSearchParams(location.search);
const Page = params.get("app") === "sme" ? SmeEvidence : ConsoleEvidence;
const Embedded = params.get("app") === "sme" ? SmeWorkspace : ConsoleWorkspace;
const cache = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={cache}>
    <UnsavedWorkProvider>
      <main className="mx-auto min-w-0 max-w-6xl p-4">
        <a href="?left=1" className="sr-only focus:not-sr-only">
          Leave fixture
        </a>
        {params.has("invoice") ? (
          <Embedded
            invoiceId="00000000-0000-4000-8000-000000000004"
            client={{
              id: "00000000-0000-4000-8000-000000000003",
              label: "Example Client Ltd",
            }}
            embedded
          />
        ) : (
          <Page />
        )}
      </main>
    </UnsavedWorkProvider>
  </QueryClientProvider>,
);
