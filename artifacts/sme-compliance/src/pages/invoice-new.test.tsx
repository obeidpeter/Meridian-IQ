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
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type { Me, Party } from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the page renders with.
const harness = vi.hoisted(() => ({
  me: undefined as unknown,
  parties: [] as unknown[],
  createCalls: [] as unknown[],
  clerkCalls: [] as unknown[],
  clerkResult: undefined as unknown,
  reset() {
    this.me = undefined;
    this.parties = [];
    this.createCalls = [];
    this.clerkCalls = [];
    this.clerkResult = undefined;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: harness.me }),
    useListParties: () => ({ data: harness.parties }),
    // Catalogue left unresolved so tinGuidance renders its local fallback.
    useListErrorCatalogue: () => ({ data: undefined }),
    useListLineItemSuggestions: () => ({ data: undefined }),
    useCreateInvoice: () => ({
      isPending: false,
      mutateAsync: (vars: unknown) => {
        harness.createCalls.push(vars);
        return Promise.resolve({ invoice: { id: "inv-1" } });
      },
    }),
    useDraftInvoiceWithClerk: () => ({
      isPending: false,
      mutateAsync: (vars: unknown) => {
        harness.clerkCalls.push(vars);
        return Promise.resolve(harness.clerkResult);
      },
    }),
    useCreateParty: () => ({
      isPending: false,
      mutateAsync: vi.fn(),
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { InvoiceNew, draftStorageKey, type DraftState } from "./invoice-new";

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
      { description: "goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
    ],
    ...over,
  };
}

beforeEach(() => {
  harness.reset();
  harness.me = me();
  harness.parties = [buyer()];
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

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
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0]).toMatchObject({
      data: { buyerPartyId: "b-no-tin", invoiceNumber: "INV-9" },
    });
    // The stored draft is cleared once the invoice exists server-side.
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
  });

  test("the TIN note is an amber warning with the FIRS fallback and draft-allowed copy", () => {
    renderWithClient(<InvoiceNew />);
    const note = document.getElementById("buyer-tin-note");
    expect(note).not.toBeNull();
    expect(note!.className).toContain("text-amber-700");
    expect(note!.getAttribute("role")).toBeNull();
    expect(note!.textContent).toMatch(/FIRS rejects B2B invoices/);
    expect(note!.textContent).toContain(
      "You can still save this invoice as a draft",
    );
  });

  test("the 'Customer has a TIN' readiness step flags attention, not completion", () => {
    renderWithClient(<InvoiceNew />);
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

describe("durable draft persistence", () => {
  test("a restored draft shows the indicator and Discard immediately", () => {
    localStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    const status = screen.getByTestId("text-draft-saved");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Draft saved on this device");
    expect(screen.getByTestId("button-discard-draft")).toBeTruthy();
  });

  test("an untouched mount stores nothing after the debounce", async () => {
    renderWithClient(<InvoiceNew />);
    expect(screen.getByTestId("text-draft-saved").textContent).toBe("");
    // Ride out the 400ms autosave debounce inside act, so its setSavedAt
    // lands cleanly.
    await act(() => new Promise((r) => setTimeout(r, 500)));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  test("a pre-move sessionStorage draft still restores", () => {
    sessionStorage.setItem(KEY, JSON.stringify(storedDraft()));
    renderWithClient(<InvoiceNew />);
    expect(screen.getByTestId("text-draft-saved").textContent).toBe(
      "Draft saved on this device",
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
});
