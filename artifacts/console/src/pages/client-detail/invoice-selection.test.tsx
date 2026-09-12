// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ClientRisk,
  ConsoleInvoice,
  InvoiceDetail,
  Me,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  data: undefined as InvoiceDetail | undefined,
  isPending: true,
  isError: false,
  enabled: false,
  refetch: vi.fn(),
  keys: [] as unknown[],
  evidence: vi.fn((_props: unknown) => null),
}));
vi.mock("@/pages/evidence", () => ({
  EvidenceWorkspace: harness.evidence,
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetInvoice: (
    _id: string,
    options: { query: { enabled: boolean; queryKey: unknown[] } },
  ) => {
    harness.enabled = options.query.enabled;
    harness.keys = options.query.queryKey;
    return {
      data: harness.data,
      isPending: harness.isPending,
      isSuccess: !harness.isPending && !harness.isError,
      isError: harness.isError,
      refetch: harness.refetch,
    };
  },
}));
import {
  ClientInvoiceSelection,
  useClientInvoiceSelection,
} from "./invoice-selection";

const invoiceId = "82284dc2-6229-46d2-86b7-d1fd3f6c7bca";
const client = {
  clientPartyId: "client-A",
  legalName: "Client A",
} as ClientRisk;
const invoices = [
  { id: invoiceId, invoiceNumber: "INV-001" },
] as ConsoleInvoice[];
const me = {
  firmId: "firm-A",
  userId: "user-A",
  capabilities: ["invoice.read"],
} as Me;
function record(overrides = {}): InvoiceDetail {
  return {
    invoice: {
      id: invoiceId,
      firmId: "firm-A",
      supplierPartyId: "client-A",
      invoiceNumber: "INV-001",
      currency: "NGN",
      grandTotal: "100",
      vatTotal: "0",
      issueDate: "2026-09-01",
      status: "draft",
      contentRevision: 1,
      ...overrides,
    },
    lines: [],
  } as unknown as InvoiceDetail;
}
function Fixture({
  rows = invoices,
  partyId = "client-A",
  identity = me,
}: {
  rows?: ConsoleInvoice[];
  partyId?: string;
  identity?: Me;
}) {
  const selection = useClientInvoiceSelection({
    clientPartyId: partyId,
    client,
    invoices: rows,
    me: identity,
  });
  return (
    <>
      <button
        id={`open-client-invoice-${invoiceId}`}
        onClick={() => selection.setInvoiceId(invoiceId)}
      >
        Open invoice
      </button>
      <ClientInvoiceSelection
        selection={selection}
        clientPartyId={partyId}
        clientName={client.legalName}
      />
    </>
  );
}
beforeEach(() => {
  harness.data = undefined;
  harness.isPending = true;
  harness.isError = false;
  harness.refetch.mockReset();
  harness.evidence.mockClear();
  window.history.replaceState(
    null,
    "",
    `/clients/client-A?view=invoices&filter=failed&invoiceId=${invoiceId}`,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("deep link waits for authorized portfolio membership and matching full record", () => {
  const { rerender } = render(<Fixture rows={[]} />);
  expect(harness.enabled).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<Fixture />);
  expect(harness.enabled).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  harness.data = record();
  harness.isPending = false;
  rerender(<Fixture />);
  expect(screen.getByRole("dialog", { name: "INV-001" })).toBeTruthy();
  expect(harness.keys).toContain("firm-A");
  expect(harness.keys).toContain("user-A");
  expect(harness.keys).toContain("client-A");
  expect(harness.evidence.mock.calls.at(-1)?.[0]).toEqual({
    invoiceId,
    client: { id: "client-A", label: "Client A" },
    embedded: true,
  });
});

test.each([
  { id: "other-invoice" },
  { supplierPartyId: "other-client" },
  { firmId: "other-firm" },
])("rejects mismatched full record %j", (overrides) => {
  harness.data = record(overrides);
  harness.isPending = false;
  render(<Fixture />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("not available");
});

test("capability failure, stale client data and failed reads never open cached record", () => {
  harness.data = record();
  harness.isPending = false;
  const { rerender } = render(
    <Fixture identity={{ ...me, capabilities: [] }} />,
  );
  expect(harness.enabled).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<Fixture partyId="client-B" />);
  expect(harness.enabled).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  harness.isError = true;
  rerender(<Fixture />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(harness.refetch).toHaveBeenCalledOnce();
});

test("closing preserves view/filter/scroll, restores focus and does not reopen on rerender", async () => {
  harness.data = record();
  harness.isPending = false;
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const { rerender } = render(<Fixture />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(new URLSearchParams(location.search).get("invoiceId")).toBeNull();
  expect(new URLSearchParams(location.search).get("view")).toBe("invoices");
  expect(new URLSearchParams(location.search).get("filter")).toBe("failed");
  expect(scroll).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open invoice" }),
    ),
  );
  rerender(<Fixture />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("browser back/forward query changes select only authorized invoices", () => {
  harness.data = record();
  harness.isPending = false;
  render(<Fixture />);
  window.history.replaceState(
    null,
    "",
    "/clients/client-A?view=invoices&invoiceId=unknown",
  );
  fireEvent.popState(window);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(harness.enabled).toBe(false);
});
