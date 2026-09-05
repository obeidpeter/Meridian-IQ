// @vitest-environment jsdom
// The invoice form's draft-first contract:
//  - A customer without a TIN never blocks CREATING a draft — the amber
//    note under the picker warns (FIRS wording, draft-allowed copy), the
//    checklist row stays unchecked, and the server remains the gate for
//    stamping.
//  - Drafts persist durably (localStorage) and the restore indicator plus
//    Discard appear immediately on a real restore; an untouched form leaves
//    no residue.
//  - The Clerk note and the draft-saved indicator are pre-mounted
//    role="status" live regions, and the whole Draft-with-Clerk card is
//    absent while the clerk_ai feature is dark.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderWithClient } from "../test-utils";
import type { Me, Party } from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the page renders with.
const harness = vi.hoisted(() => ({
  me: undefined as unknown,
  parties: [] as unknown[],
  createCalls: [] as unknown[],
  clerkCalls: [] as unknown[],
  clerkResult: undefined as unknown,
  createResult: undefined as unknown,
  createHandler: undefined as
    | ((data: unknown, options: unknown) => Promise<unknown>)
    | undefined,
  generation: 0,
  ending: false,
  listeners: new Set<() => void>(),
  toast: vi.fn(),
  navigate: vi.fn(),
  drafts: new Map<string, unknown>(),
  saveBarrier: undefined as Promise<void> | undefined,
  onSave: undefined as (() => void) | undefined,
  reset() {
    this.me = undefined;
    this.parties = [];
    this.createCalls = [];
    this.clerkCalls = [];
    this.clerkResult = undefined;
    this.createResult = undefined;
    this.createHandler = undefined;
    this.generation = 0;
    this.ending = false;
    this.listeners.clear();
    this.toast.mockClear();
    this.navigate.mockClear();
    this.drafts.clear();
    this.saveBarrier = undefined;
    this.onSave = undefined;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: harness.me }),
    useListParties: () => ({ data: harness.parties }),
    getParty: async (id: string) =>
      harness.parties.find((party) => (party as { id: string }).id === id),
    listParties: async () => harness.parties,
    // Catalogue left unresolved so tinGuidance renders its local fallback.
    useListErrorCatalogue: () => ({ data: undefined }),
    useListLineItemSuggestions: () => ({ data: undefined }),
    createInvoice: (data: unknown, options: unknown) => {
      harness.createCalls.push({ data, options });
      if (harness.createHandler) return harness.createHandler(data, options);
      return Promise.resolve(
        harness.createResult ?? { invoice: { id: "inv-1" } },
      );
    },
    draftInvoiceWithClerk: (data: unknown, options: unknown) => {
      harness.clerkCalls.push({ data, options });
      return Promise.resolve(harness.clerkResult);
    },
    useCreateParty: () => ({
      isPending: false,
      mutateAsync: vi.fn(),
    }),
  };
});

vi.mock("@workspace/web-ui", async (original) => {
  const actual = await original<typeof import("@workspace/web-ui")>();
  return {
    ...actual,
    beginOperation: vi.fn(actual.beginOperation),
    updateOperation: vi.fn(actual.updateOperation),
    webSession: {
      getGeneration: () => harness.generation,
      isEnding: () => harness.ending,
      subscribe: (listener: () => void) => {
        harness.listeners.add(listener);
        return () => harness.listeners.delete(listener);
      },
    },
  };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));
vi.mock("wouter", async (original) => ({
  ...(await original<typeof import("wouter")>()),
  useLocation: () => ["/invoices/new", harness.navigate],
}));

vi.mock("@/lib/invoice-draft-api", () => ({
  invoiceDraftApi: () => ({
    get: async (id: string) => {
      if (!harness.drafts.has(id)) throw { status: 404 };
      return harness.drafts.get(id);
    },
    save: async (
      id: string,
      input: { expectedRevision: number; writeId: string; draft: unknown },
    ) => {
      harness.onSave?.();
      await harness.saveBarrier;
      const row = {
        id,
        revision: input.expectedRevision + 1,
        writeId: input.writeId,
        draft: input.draft,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
      };
      harness.drafts.set(id, row);
      return row;
    },
    remove: async (id: string) => {
      harness.drafts.delete(id);
    },
  }),
  listServerInvoiceDrafts: async () => ({
    items: [...harness.drafts.values()],
    nextOffset: null,
  }),
}));

// Import AFTER the mock so the page module binds the stand-ins.
import { InvoiceNew, draftStorageKey, type DraftState } from "./invoice-new";
import { beginOperation, updateOperation } from "@workspace/web-ui";
import { readInvoiceSubmission } from "@/lib/invoice-submission";
import { InvoiceDraftSession } from "@/lib/invoice-draft-session";

function me(over: Partial<Me> = {}): Me {
  return {
    userId: "u-1",
    role: "client_user",
    email: null,
    fullName: null,
    firmId: "f-1",
    clientPartyId: "cp-1",
    buyerPartyId: null,
    capabilities: ["invoice.read", "invoice.write"],
    features: ["invoice_lifecycle", "clerk_ai"],
    ...over,
  };
}

function buyer(over: Partial<Party> = {}): Party {
  return {
    id: "b-1",
    type: "buyer",
    legalName: "Adaeze Foods",
    tin: "30000000-0003",
    tinValidated: false,
    countryCode: "NG",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const KEY = draftStorageKey("u-1", "f-1");

/** A complete draft except for whatever the test overrides. */
function storedDraft(over: Partial<DraftState> = {}): DraftState {
  return {
    invoiceNumber: "INV-9",
    buyerPartyId: "b-1",
    issueDate: "2026-08-27",
    dueDate: "",
    currency: "NGN",
    fxRateToNgn: "",
    whtCategory: "",
    lines: [
      {
        description: "goods",
        quantity: "1",
        unitPrice: "1000",
        vatRate: "0.075",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  harness.reset();
  vi.mocked(beginOperation).mockClear();
  vi.mocked(updateOperation).mockClear();
  harness.me = me();
  harness.parties = [buyer()];
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/invoices/new");
});

afterEach(() => {
  cleanup();
});

async function restoreLegacy() {
  fireEvent.click(
    screen.getByRole("button", { name: "Recover earlier device draft" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Invoice number") as HTMLInputElement).value,
    ).toBe("INV-9"),
  );
  await waitFor(() =>
    expect(screen.getByTestId("text-draft-saved").textContent).not.toContain(
      "Loading",
    ),
  );
}

describe("no-TIN buyer never blocks a draft", () => {
  beforeEach(() => {
    harness.parties = [buyer({ id: "b-no-tin", tin: null })];
    localStorage.setItem(
      KEY,
      JSON.stringify(storedDraft({ buyerPartyId: "b-no-tin" })),
    );
  });

  test("Create invoice calls the create mutation despite the missing TIN", async () => {
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0]).toMatchObject({
      data: { buyerPartyId: "b-no-tin", invoiceNumber: "INV-9" },
    });
    expect(harness.createCalls[0]).toMatchObject({
      options: {
        headers: {
          "X-Idempotency-Key": expect.stringMatching(/^invoice-create:/),
        },
      },
    });
    await waitFor(() => expect(harness.drafts.size).toBe(0));
  });

  test("the TIN note is an amber warning with the FIRS fallback and draft-allowed copy", async () => {
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    await waitFor(() =>
      expect(document.getElementById("buyer-tin-note")).not.toBeNull(),
    );
    const note = document.getElementById("buyer-tin-note");
    expect(note).not.toBeNull();
    expect(note!.className).toContain("text-amber-700");
    expect(note!.getAttribute("role")).toBeNull();
    expect(note!.textContent).toMatch(/FIRS rejects B2B invoices/);
    expect(note!.textContent).toContain(
      "You can still save this invoice as a draft",
    );
  });

  test("the 'Customer has a TIN' readiness step flags attention, not completion", async () => {
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    // A buyer is selected but carries no TIN: the rail says so (attention),
    // rather than pretending the step is merely unstarted or complete.
    const row = screen.getByText("Customer has a TIN");
    expect(row.textContent).toContain("needs attention");
    expect(row.textContent).not.toContain("complete");
    expect(
      screen.getByTestId("readiness-customer-tin").getAttribute("data-state"),
    ).toBe("attention");
    expect(screen.getByText(/a draft can still be saved/)).toBeTruthy();
  });
});

test("readiness and creation both reject a missing price, but accept a zero price", async () => {
  const draft = storedDraft();
  draft.lines[0].unitPrice = "";
  localStorage.setItem(KEY, JSON.stringify(draft));
  renderWithClient(<InvoiceNew />);
  await restoreLegacy();
  expect(
    screen.getByTestId("readiness-line-items").getAttribute("data-state"),
  ).toBe("todo");
  const price = document.getElementById("line-0-unit-price")!;
  price.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
  expect(harness.createCalls).toHaveLength(0);
  expect(document.activeElement).toBe(price);
  fireEvent.change(document.getElementById("line-0-unit-price")!, {
    target: { value: "0" },
  });
  expect(
    screen.getByTestId("readiness-line-items").getAttribute("data-state"),
  ).toBe("done");
  fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
  await waitFor(() => expect(harness.createCalls).toHaveLength(1));
});

describe("durable draft persistence", () => {
  test("unmount during the draft flush prevents the following create command", async () => {
    let release!: () => void;
    harness.saveBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      harness.onSave = resolve;
    });
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    const view = renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
      await started;
    });
    view.unmount();
    localStorage.clear();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    try {
      await act(async () => release());
      expect(harness.createCalls).toHaveLength(0);
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
      removals.mockRestore();
    }
  });

  test("a restored draft distinguishes device recovery from account confirmation", async () => {
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    const status = screen.getByTestId("text-draft-saved");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain("device only");
    expect(screen.getByTestId("button-discard-draft")).toBeTruthy();
  });

  test("an untouched mount stores nothing after the debounce", async () => {
    renderWithClient(<InvoiceNew />);
    expect(screen.getByTestId("text-draft-saved").textContent).toContain(
      "Loading draft",
    );
    // Ride out the 400ms autosave debounce inside act, so its setSavedAt
    // lands cleanly.
    await act(() => new Promise((r) => setTimeout(r, 500)));
    expect(screen.getByTestId("text-draft-saved").textContent).toBe(
      "New draft",
    );
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  test("a pre-move sessionStorage draft still restores", async () => {
    sessionStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    expect(screen.getByTestId("text-draft-saved").textContent).toContain(
      "device only",
    );
  });
});

describe("Clerk surfaces", () => {
  test("the note is a pre-mounted role=status live region that fills on draft", async () => {
    harness.clerkResult = {
      proposal: { lines: [] },
      buyerSuggestions: [],
    };
    renderWithClient(<InvoiceNew />);
    await waitFor(() =>
      expect(screen.getByTestId("text-draft-saved").textContent).toBe(
        "New draft",
      ),
    );
    const note = screen.getByTestId("text-clerk-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe("");
    fireEvent.change(screen.getByTestId("input-clerk-draft"), {
      target: { value: "Invoice Adaeze Foods for June deliveries" },
    });
    fireEvent.click(screen.getByTestId("button-clerk-draft"));
    await waitFor(() =>
      expect(note.textContent).toContain("check every field"),
    );
  });

  test("the whole card is absent while the clerk_ai feature is dark", () => {
    harness.me = me({ features: ["invoice_lifecycle"] });
    renderWithClient(<InvoiceNew />);
    expect(screen.queryByTestId("input-clerk-draft")).toBeNull();
    expect(screen.queryByTestId("text-clerk-note")).toBeNull();
    expect(screen.queryByText("Draft with Clerk")).toBeNull();
  });
  test("a late Clerk proposal cannot replace newer manual edits", async () => {
    let finish!: (value: unknown) => void;
    harness.clerkResult = new Promise((resolve) => {
      finish = resolve;
    });
    renderWithClient(<InvoiceNew />);
    await waitFor(() =>
      expect(screen.getByTestId("text-draft-saved").textContent).toBe(
        "New draft",
      ),
    );
    fireEvent.change(screen.getByTestId("input-clerk-draft"), {
      target: { value: "Invoice Adaeze Foods" },
    });
    fireEvent.click(screen.getByTestId("button-clerk-draft"));
    fireEvent.change(screen.getByLabelText("Invoice number"), {
      target: { value: "MANUAL" },
    });
    await act(async () => {
      finish({
        proposal: { invoiceNumber: "AI", lines: [] },
        buyerSuggestions: [],
      });
    });
    expect(
      (screen.getByLabelText("Invoice number") as HTMLInputElement).value,
    ).toBe("MANUAL");
    expect(screen.getByTestId("text-clerk-note").textContent).toContain(
      "not applied",
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("immutable invoice retries", () => {
  test("lost create response, attempted edits and refresh replay the original body and create only one invoice", async () => {
    const committed = new Map<
      string,
      { body: unknown; invoice: { id: string } }
    >();
    const lost = deferred<void>();
    harness.createHandler = async (body, options) => {
      const key = (options as { headers: Record<string, string> }).headers[
        "X-Idempotency-Key"
      ];
      const existing = committed.get(key);
      if (existing) {
        expect(body).toEqual(existing.body);
        return { invoice: existing.invoice };
      }
      const invoice = { id: "exactly-one-invoice" };
      committed.set(key, { body: structuredClone(body), invoice });
      await lost.promise;
      throw new Error("Response dropped after commit");
    };
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    const first = renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(committed.size).toBe(1));
    const draftId = new URLSearchParams(window.location.search).get("draft")!;
    const scope = draftStorageKey("u-1", "f-1", "cp-1");
    const original = readInvoiceSubmission(scope, draftId);
    expect(original).toMatchObject({
      status: "pending",
      key: `invoice-create:${draftId}`,
      body: { buyerPartyId: "b-1", lines: [{ unitPrice: "1000" }] },
    });
    expect(document.getElementById("buyer-select")!.matches(":disabled")).toBe(
      true,
    );
    fireEvent.change(document.getElementById("line-0-unit-price")!, {
      target: { value: "9000" },
    });
    await act(async () => lost.resolve());
    await waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Invoice creation not confirmed" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Invoice number"), {
      target: { value: "REPLACEMENT" },
    });
    expect(
      (screen.getByLabelText("Invoice number") as HTMLInputElement).value,
    ).toBe("INV-9");
    expect(
      (document.getElementById("line-0-unit-price") as HTMLInputElement).value,
    ).toBe("1000");
    expect(
      screen.getByRole("button", { name: "New draft" }).matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("button-discard-draft").matches(":disabled"),
    ).toBe(true);
    expect(readInvoiceSubmission(scope, draftId)).toEqual(original);
    first.unmount();
    // A stale account copy must not replace the immutable command on refresh.
    const row = harness.drafts.get(draftId) as Record<string, unknown>;
    harness.drafts.set(draftId, {
      ...row,
      draft: storedDraft({
        buyerPartyId: "b-other",
        lines: [
          {
            description: "changed",
            quantity: "1",
            unitPrice: "9000",
            vatRate: "0",
          },
        ],
      }),
    });
    renderWithClient(<InvoiceNew />);
    const retry = await screen.findByRole("button", {
      name: "Retry original invoice",
    });
    expect(
      (document.getElementById("line-0-unit-price") as HTMLInputElement).value,
    ).toBe("1000");
    fireEvent.click(retry);
    await waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith(
        "/invoices/exactly-one-invoice",
      ),
    );
    expect(harness.createCalls).toHaveLength(2);
    expect(committed.size).toBe(1);
    const [a, b] = harness.createCalls as {
      data: unknown;
      options: { headers: unknown };
    }[];
    expect(b.data).toEqual(a.data);
    expect(b.options.headers).toEqual(a.options.headers);
    expect(readInvoiceSubmission(scope, draftId)).toEqual({
      status: "succeeded",
      key: `invoice-create:${draftId}`,
      invoiceId: "exactly-one-invoice",
    });
  });

  test("a first structured validation rejection permits correction without silently rotating the key", async () => {
    let attempts = 0;
    harness.createHandler = async () => {
      if (++attempts === 1)
        throw { status: 400, data: { error: "Invalid invoice input" } };
      return { invoice: { id: "corrected" } };
    };
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not create invoice" }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Retry original invoice" }),
    ).toBeNull();
    expect(
      document.getElementById("line-0-unit-price")!.matches(":disabled"),
    ).toBe(false);
    fireEvent.change(document.getElementById("line-0-unit-price")!, {
      target: { value: "1200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith("/invoices/corrected"),
    );
    const [a, b] = harness.createCalls as {
      data: { lines: { unitPrice: string }[] };
      options: { headers: unknown };
    }[];
    expect(b.options.headers).toEqual(a.options.headers);
    expect(b.data.lines[0].unitPrice).toBe("1200");
  });

  test("a validation rejection on retry cannot erase an earlier unknown result", async () => {
    let attempts = 0;
    harness.createHandler = async () => {
      if (++attempts === 1) throw new Error("Lost response");
      throw {
        status: 400,
        data: { error: "Current validation policy rejects this input" },
      };
    };
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Retry original invoice" }),
    );
    await waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: "Retry original invoice" }),
    ).toBeTruthy();
    expect(document.getElementById("buyer-select")!.matches(":disabled")).toBe(
      true,
    );
    const [a, b] = harness.createCalls as {
      data: unknown;
      options: { headers: unknown };
    }[];
    expect(b.data).toEqual(a.data);
    expect(b.options.headers).toEqual(a.options.headers);
  });

  test("storage failure before dispatch does not send an unrecoverable create request", async () => {
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    await restoreLegacy();
    const original = Storage.prototype.setItem;
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.endsWith(":submission"))
          throw new Error("Recovery storage unavailable");
        original.call(this, key, value);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
      await waitFor(() =>
        expect(harness.toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Could not create invoice" }),
        ),
      );
      expect(harness.createCalls).toHaveLength(0);
    } finally {
      write.mockRestore();
    }
  });
});

describe("session-bound invoice commands", () => {
  test("a cached success cannot navigate after the session ends before React cleanup", async () => {
    const load = vi.spyOn(InvoiceDraftSession.prototype, "load");
    try {
      localStorage.setItem(KEY, JSON.stringify(storedDraft()));
      renderWithClient(<InvoiceNew />);
      await restoreLegacy();
      const session = load.mock.contexts.at(-1) as
        | InvoiceDraftSession
        | undefined;
      expect(session).toBeDefined();
      session!.state = {
        ...session!.state,
        submission: {
          status: "succeeded",
          key: `invoice-create:${session!.id}`,
          invoiceId: "previous-session-invoice",
        },
      };
      harness.ending = true;
      harness.generation++;
      fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.createCalls).toHaveLength(0);
    } finally {
      load.mockRestore();
    }
  });

  test.each(["logout", "switch", "unmount"] as const)(
    "%s while create mutation startup is suspended never dispatches the command",
    async (boundary) => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
        mutationCache: new MutationCache({
          onMutate: async () => {
            entered.resolve();
            await gate.promise;
          },
        }),
      });
      localStorage.setItem(KEY, JSON.stringify(storedDraft()));
      const view = render(<InvoiceNew />, {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      await restoreLegacy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
        await entered.promise;
      });
      invalidate(boundary, view);
      await expectNoLateEffects(async () => {
        gate.resolve();
      });
      expect(harness.createCalls).toHaveLength(0);
    },
  );

  test.each(["logout", "switch", "unmount"] as const)(
    "%s while create response is suspended aborts and suppresses completion",
    async (boundary) => {
      const gate = deferred<unknown>();
      harness.createResult = gate.promise;
      localStorage.setItem(KEY, JSON.stringify(storedDraft()));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const view = render(<InvoiceNew />, {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      await restoreLegacy();
      fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
      await waitFor(() => expect(harness.createCalls).toHaveLength(1));
      const { options } = harness.createCalls[0] as {
        options: { signal: AbortSignal };
      };
      invalidate(boundary, view);
      expect(options.signal.aborted).toBe(true);
      await expectNoLateEffects(async () => {
        gate.resolve({ invoice: { id: "late-invoice" } });
      });
      expect(harness.createCalls).toHaveLength(1);
    },
  );

  test.each(["logout", "switch", "unmount"] as const)(
    "%s before Clerk failure suppresses stale error feedback",
    async (boundary) => {
      const gate = deferred<unknown>();
      harness.clerkResult = gate.promise;
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const view = render(<InvoiceNew />, {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      await waitFor(() =>
        expect(screen.getByTestId("text-draft-saved").textContent).toBe(
          "New draft",
        ),
      );
      fireEvent.change(screen.getByTestId("input-clerk-draft"), {
        target: { value: "Invoice Adaeze Foods" },
      });
      fireEvent.click(screen.getByTestId("button-clerk-draft"));
      await waitFor(() => expect(harness.clerkCalls).toHaveLength(1));
      const { options } = harness.clerkCalls[0] as {
        options: { signal: AbortSignal };
      };
      invalidate(boundary, view);
      expect(options.signal.aborted).toBe(true);
      await expectNoLateEffects(async () => {
        gate.reject(new Error("late gateway failure"));
      });
      expect(harness.clerkCalls).toHaveLength(1);
      expect(screen.queryByTestId("text-clerk-note")?.textContent ?? "").toBe(
        "",
      );
    },
  );
});

function invalidate(
  boundary: "logout" | "switch" | "unmount",
  view: ReturnType<typeof render>,
) {
  act(() => {
    if (boundary === "unmount") view.unmount();
    else if (boundary === "switch") {
      harness.me = me({ userId: "u-2", firmId: "f-2", clientPartyId: "cp-2" });
      view.rerender(<InvoiceNew />);
    } else {
      harness.ending = true;
      harness.generation++;
      harness.listeners.forEach((listener) => listener());
    }
  });
}

async function expectNoLateEffects(release: () => Promise<void>) {
  localStorage.clear();
  vi.mocked(beginOperation).mockClear();
  vi.mocked(updateOperation).mockClear();
  harness.toast.mockClear();
  harness.navigate.mockClear();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const removals = vi.spyOn(Storage.prototype, "removeItem");
  try {
    await act(release);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(beginOperation).not.toHaveBeenCalled();
    expect(updateOperation).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  } finally {
    writes.mockRestore();
    removals.mockRestore();
  }
}
