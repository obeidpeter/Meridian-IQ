// Shared page-test render harness (not *.test.tsx, so vitest never collects
// it as a suite). Each test file's renderPage collapses to
// `renderWithClient(<Page />)` — the per-file vi.mock blocks stay put.
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Render `ui` inside a fresh QueryClient with retries off, so error paths
 * settle immediately instead of retrying into the assertion window.
 */
export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
