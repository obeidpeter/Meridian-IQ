// @vitest-environment jsdom
// The supplier drill-down: /suppliers/:id renders the supplier's name +
// TIN/validated pill, the aggregate tiles from BuyerSupplierDetail.supplier,
// and the invoice list where every row links to the respond page. A 404 (a
// supplier that never invoiced this buyer, or a stale link) lands on the
// portal's unknown-entity card, not a retry loop. Network = stubbed global
// fetch; the real generated hook and react-query run.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type {
  BuyerInvoice,
  BuyerSupplierDetail as BuyerSupplierDetailPayload,
} from "@workspace/api-client-react";
import { formatNaira } from "@/lib/format";
import { SupplierDetail } from "./supplier-detail";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const invoice = (over: Partial<BuyerInvoice> = {}): BuyerInvoice => ({
  id: "i1",
  invoiceNumber: "INV-001",
  supplierPartyId: "s1",
  supplierName: "Acme Supplies",
  status: "submitted",
  grandTotal: "1000.00",
  vatTotal: "75.00",
  issueDate: "2026-07-01",
  dueDate: null,
  confirmationState: "requested",
  stampValid: true,
  eligible: true,
  ...over,
});

const detail = (): BuyerSupplierDetailPayload => ({
  supplier: {
    supplierPartyId: "s1",
    supplierName: "Acme Supplies",
    supplierTin: "01234567-0001",
    tinValidated: true,
    invoiceCount: 4,
    stampedCount: 3,
    eligibleCount: 2,
    totalAmount: "250000.00",
    vatProtected: "15000.00",
    vatAtRisk: "3750.00",
  },
  invoices: [
    invoice({ id: "i1", invoiceNumber: "INV-001" }),
    invoice({
      id: "i2",
      invoiceNumber: "INV-002",
      confirmationState: "confirmed",
      stampValid: false,
    }),
  ],
});

const harness: { status: number; payload: BuyerSupplierDetailPayload | null } =
  { status: 200, payload: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function renderAt(path: string) {
  const { hook } = memoryLocation({ path });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Router hook={hook}>
          <Route path="/suppliers/:id" component={SupplierDetail} />
        </Router>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  harness.status = 200;
  harness.payload = detail();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/buyer/suppliers/")) {
        return harness.status === 200
          ? jsonResponse(harness.payload)
          : jsonResponse({ message: "Not found" }, harness.status);
      }
      return jsonResponse({ message: "not found" }, 404);
    }),
  );
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SupplierDetail", () => {
  test("renders the supplier header with the validated-TIN pill and the aggregate tiles", async () => {
    await renderAt("/suppliers/s1");

    expect(byTestId("text-page-title")!.textContent).toBe("Acme Supplies");
    expect(byTestId("text-supplier-tin")!.textContent).toBe("01234567-0001");
    expect(byTestId("badge-tin-validated")!.textContent).toContain("Validated");

    expect(byTestId("stat-invoices")!.textContent).toContain("4");
    expect(byTestId("stat-stamped")!.textContent).toContain("3");
    expect(byTestId("stat-eligible")!.textContent).toContain("2");
    // Compact tiles keep the exact figure reachable via the title attribute.
    expect(
      byTestId("stat-total")!.querySelector("[title]")!.getAttribute("title"),
    ).toBe(formatNaira("250000.00"));
    expect(
      byTestId("stat-protected-vat")!
        .querySelector("[title]")!
        .getAttribute("title"),
    ).toBe(formatNaira("15000.00"));
    expect(
      byTestId("stat-at-risk-vat")!
        .querySelector("[title]")!
        .getAttribute("title"),
    ).toBe(formatNaira("3750.00"));

    // The way back is always on screen.
    expect(byTestId("link-back")!.getAttribute("href")).toBe("/suppliers");
    expect(byTestId("link-back")!.textContent).toContain("Back to suppliers");
  });

  test("an unvalidated TIN shows the slate pill", async () => {
    harness.payload = detail();
    harness.payload.supplier.tinValidated = false;
    harness.payload.supplier.supplierTin = null;
    await renderAt("/suppliers/s1");
    expect(byTestId("badge-tin-validated")!.textContent).toContain(
      "Unvalidated",
    );
    expect(byTestId("text-supplier-tin")!.textContent).toBe("—");
  });

  test("lists each invoice with number, date, total and both status pills, linking to the respond page", async () => {
    await renderAt("/suppliers/s1");

    const row1 = byTestId("row-invoice-i1");
    expect(row1).not.toBeNull();
    expect(row1!.getAttribute("href")).toBe("/invoices/i1");
    expect(row1!.textContent).toContain("INV-001");
    expect(row1!.textContent).toContain(formatNaira("1000.00"));
    expect(byTestId("badge-stamp-i1")!.textContent).toBe("Stamp valid");
    expect(byTestId("badge-confirmation-i1")!.textContent).toBe(
      "Awaiting response",
    );

    const row2 = byTestId("row-invoice-i2");
    expect(row2!.getAttribute("href")).toBe("/invoices/i2");
    expect(byTestId("badge-stamp-i2")!.textContent).toBe("No stamp");
    expect(byTestId("badge-confirmation-i2")!.textContent).toBe("Confirmed");
  });

  test("an empty invoice list explains itself instead of rendering a bare card", async () => {
    harness.payload = { ...detail(), invoices: [] };
    await renderAt("/suppliers/s1");
    expect(byTestId("text-empty")!.textContent).toContain(
      "No invoices from this supplier yet",
    );
  });

  test("a 404 lands on the unknown-supplier card with the way back", async () => {
    harness.status = 404;
    await renderAt("/suppliers/nope");

    expect(byTestId("card-unknown-supplier")).not.toBeNull();
    expect(byTestId("text-error")!.textContent).toBe(
      "We couldn't find this supplier",
    );
    expect(byTestId("button-back-to-suppliers")!.getAttribute("href")).toBe(
      "/suppliers",
    );
    // No aggregate tiles for a supplier that does not exist.
    expect(byTestId("stat-invoices")).toBeNull();
  });
});
