// @vitest-environment jsdom
// The bulk-confirm flow on the confirmation queue: awaiting rows grow
// checkboxes (never the already-answered ones), "Select all" arms the action
// bar, the confirm dialog states the permanence, the POST carries the picked
// ids + the single-flow's method/no-set-off semantics, and the per-invoice
// results panel reports every skip with its reason. The header's Export CSV
// is a plain same-origin navigation to the generated URL. The network is a
// stubbed global fetch — the real generated hooks and react-query run.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BuyerInvoice,
  BulkConfirmationsResult,
} from "@workspace/api-client-react";
import { getExportBuyerConfirmationsUrl } from "@workspace/api-client-react";
import { Confirmations } from "./confirmations";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Harness: a per-URL fetch stub (the generated client's customFetch rides the
// global fetch) plus a bare react-dom/client mount — this app ships no DOM
// testing library, so queries go straight through document.querySelector.
// ---------------------------------------------------------------------------

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

const harness: {
  invoices: BuyerInvoice[];
  bulkResult: BulkConfirmationsResult;
  bulkStatus: number;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} = {
  invoices: [],
  bulkResult: { confirmed: 0, skipped: 0, items: [] },
  bulkStatus: 200,
  calls: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      harness.calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.startsWith("/api/buyer/confirmations/bulk") && method === "POST") {
        return harness.bulkStatus === 200
          ? jsonResponse(harness.bulkResult)
          : jsonResponse({ message: "bad request" }, harness.bulkStatus);
      }
      if (url.startsWith("/api/buyer/invoices")) {
        return jsonResponse(harness.invoices);
      }
      return jsonResponse({ message: "not found" }, 404);
    }),
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPage(ui: ReactElement = <Confirmations />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    );
  });
  await flush();
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`);

const click = (el: Element | null) =>
  act(async () => {
    (el as HTMLElement).click();
  });

beforeEach(() => {
  harness.invoices = [];
  harness.bulkResult = { confirmed: 0, skipped: 0, items: [] };
  harness.bulkStatus = 200;
  harness.calls = [];
  stubFetch();
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

describe("bulk selection", () => {
  test("awaiting rows gain checkboxes; answered rows never do", async () => {
    harness.invoices = [
      invoice({ id: "i1", invoiceNumber: "INV-001" }),
      invoice({ id: "i2", invoiceNumber: "INV-002" }),
      invoice({
        id: "i3",
        invoiceNumber: "INV-003",
        confirmationState: "confirmed",
      }),
    ];
    await renderPage();

    expect(byTestId("check-confirm-i1")).not.toBeNull();
    expect(byTestId("check-confirm-i2")).not.toBeNull();
    expect(byTestId("check-confirm-i3")).toBeNull();
    expect(byTestId("check-select-all")).not.toBeNull();
    // Nothing picked yet — no action bar.
    expect(byTestId("bar-bulk-actions")).toBeNull();
  });

  test("a hand-picked row arms the bar with its count", async () => {
    harness.invoices = [
      invoice({ id: "i1" }),
      invoice({ id: "i2", invoiceNumber: "INV-002" }),
    ];
    await renderPage();

    await click(byTestId("check-confirm-i1"));
    expect(byTestId("bar-bulk-actions")).not.toBeNull();
    expect(byTestId("text-bulk-selected")!.textContent).toContain("1 selected");
    // Unticking the same row disarms the bar again.
    await click(byTestId("check-confirm-i1"));
    expect(byTestId("bar-bulk-actions")).toBeNull();
  });

  test("select all picks every awaiting row and only those", async () => {
    harness.invoices = [
      invoice({ id: "i1" }),
      invoice({ id: "i2", invoiceNumber: "INV-002" }),
      invoice({
        id: "i3",
        invoiceNumber: "INV-003",
        confirmationState: "confirmed",
      }),
    ];
    await renderPage();

    await click(byTestId("check-select-all"));
    expect(byTestId("text-bulk-selected")!.textContent).toContain("2 selected");
    expect(byTestId("check-confirm-i1")!.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(byTestId("check-confirm-i2")!.getAttribute("aria-checked")).toBe(
      "true",
    );
    // And clears everything on the second click.
    await click(byTestId("check-select-all"));
    expect(byTestId("bar-bulk-actions")).toBeNull();
  });

  test("a list with no awaiting rows shows no selection column at all", async () => {
    harness.invoices = [
      invoice({ id: "i9", confirmationState: "confirmed" }),
    ];
    await renderPage();
    expect(byTestId("check-select-all")).toBeNull();
    expect(byTestId("check-confirm-i9")).toBeNull();
  });
});

describe("bulk confirm", () => {
  test("dialog → POST with ids, method and no-set-off → results panel with each skip's reason, then a list refresh", async () => {
    harness.invoices = [
      invoice({ id: "i1", invoiceNumber: "INV-001" }),
      invoice({ id: "i2", invoiceNumber: "INV-002" }),
    ];
    harness.bulkResult = {
      confirmed: 1,
      skipped: 1,
      items: [
        { invoiceId: "i1", status: "confirmed", reason: null },
        { invoiceId: "i2", status: "skipped", reason: "Already responded" },
      ],
    };
    await renderPage();

    await click(byTestId("check-select-all"));
    // The single flow's confirmed branch: no-set-off is an explicit tick.
    await click(byTestId("checkbox-bulk-no-set-off"));
    await click(byTestId("button-bulk-confirm"));

    // The permanence warning, verbatim.
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Confirm 2 invoices?");
    expect(dialog!.textContent).toContain(
      "Each records who confirmed and how, permanently.",
    );

    const listCallsBefore = harness.calls.filter((c) =>
      c.url.startsWith("/api/buyer/invoices"),
    ).length;
    await click(byTestId("button-confirm-bulk"));
    await flush();

    const post = harness.calls.find(
      (c) => c.url === "/api/buyer/confirmations/bulk" && c.method === "POST",
    );
    expect(post).toBeDefined();
    expect(post!.body).toEqual({
      invoiceIds: ["i1", "i2"],
      method: "portal",
      noSetOff: true,
    });

    // Per-invoice outcomes: the confirmed count plus every skip with its
    // reason, linking back to the invoice.
    expect(byTestId("card-bulk-results")).not.toBeNull();
    expect(byTestId("text-bulk-outcome")!.textContent).toContain("1 confirmed");
    expect(byTestId("text-bulk-outcome")!.textContent).toContain("1 skipped");
    const skippedRow = byTestId("row-bulk-skipped-i2");
    expect(skippedRow).not.toBeNull();
    expect(skippedRow!.textContent).toContain("Already responded");
    const link = byTestId("link-bulk-skipped-i2");
    expect(link!.getAttribute("href")).toBe("/invoices/i2");
    expect(link!.textContent).toBe("INV-002");

    // The queue refreshed (a second GET landed) and the selection cleared.
    const listCallsAfter = harness.calls.filter((c) =>
      c.url.startsWith("/api/buyer/invoices"),
    ).length;
    expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
    expect(byTestId("bar-bulk-actions")).toBeNull();

    // The panel is dismissible.
    await click(byTestId("button-dismiss-bulk-results"));
    expect(byTestId("card-bulk-results")).toBeNull();
  });

  test("an all-confirmed run reports zero skips and no skip rows", async () => {
    harness.invoices = [invoice({ id: "i1" })];
    harness.bulkResult = {
      confirmed: 1,
      skipped: 0,
      items: [{ invoiceId: "i1", status: "confirmed" }],
    };
    await renderPage();

    await click(byTestId("check-confirm-i1"));
    await click(byTestId("button-bulk-confirm"));
    await click(byTestId("button-confirm-bulk"));
    await flush();

    expect(byTestId("text-bulk-outcome")!.textContent).toContain("1 confirmed");
    expect(byTestId("text-bulk-outcome")!.textContent).toContain("0 skipped");
    expect(
      document.querySelector('[data-testid^="row-bulk-skipped-"]'),
    ).toBeNull();
    // Default method semantics replicated from the single flow: "portal".
    const post = harness.calls.find((c) => c.method === "POST");
    expect(post!.body).toEqual({
      invoiceIds: ["i1"],
      method: "portal",
      noSetOff: false,
    });
  });
});

describe("export", () => {
  test("the header button is a plain same-origin navigation to the generated export URL", async () => {
    harness.invoices = [invoice({ id: "i1" })];
    await renderPage();

    const button = byTestId("button-export-confirmations");
    expect(button).not.toBeNull();
    expect(button!.tagName).toBe("A");
    expect(button!.getAttribute("href")).toBe(getExportBuyerConfirmationsUrl());
    expect(button!.getAttribute("href")).toBe(
      "/api/buyer/confirmations/export",
    );
  });

  test("a dark Buyer Rails flag hides the export button with the queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "not found" }, 404)),
    );
    await renderPage();
    expect(byTestId("button-export-confirmations")).toBeNull();
  });
});
