// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  INVOICE_DRAFT_TTL_MS,
  draftStorageKey,
  loadInvoiceDraft,
  saveInvoiceDraft,
  type DraftState,
} from "./invoice-draft";

const KEY = draftStorageKey("user-1", "firm-1");
const NOW = new Date("2026-09-04T12:00:00.000Z");

function draft(): DraftState {
  return {
    invoiceNumber: "INV-42",
    buyerPartyId: "buyer-1",
    issueDate: "2026-09-04",
    dueDate: "",
    currency: "NGN",
    fxRateToNgn: "",
    whtCategory: "",
    lines: [
      {
        description: "Advisory",
        quantity: "1",
        unitPrice: "250000",
        vatRate: "0.075",
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("invoice draft retention", () => {
  test("writes a versioned seven-day envelope", () => {
    expect(saveInvoiceDraft(KEY, draft(), NOW)).toEqual(NOW);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      version: number;
      expiresAt: string;
      draft: DraftState;
    };
    expect(stored.version).toBe(1);
    expect(Date.parse(stored.expiresAt) - NOW.getTime()).toBe(
      INVOICE_DRAFT_TTL_MS,
    );
    expect(stored.draft.invoiceNumber).toBe("INV-42");
  });

  test("purges an expired draft from both storage locations", () => {
    saveInvoiceDraft(KEY, draft(), NOW);
    sessionStorage.setItem(KEY, JSON.stringify(draft()));
    const loaded = loadInvoiceDraft(
      KEY,
      new Date(NOW.getTime() + INVOICE_DRAFT_TTL_MS + 1),
    );
    expect(loaded.restored).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  test("drops corrupt durable data and restores a valid legacy session copy", () => {
    localStorage.setItem(KEY, "{not-json");
    sessionStorage.setItem(KEY, JSON.stringify(draft()));
    const loaded = loadInvoiceDraft(KEY, NOW);
    expect(loaded.restored).toBe(true);
    expect(loaded.draft.invoiceNumber).toBe("INV-42");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("sanitizes malformed fields instead of crashing the invoice form", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...draft(),
        invoiceNumber: { unsafe: true },
        lines: [{ description: 3 }],
      }),
    );
    const loaded = loadInvoiceDraft(KEY, NOW);
    expect(loaded.draft.invoiceNumber).toBe("");
    expect(loaded.draft.lines).toHaveLength(1);
    expect(loaded.draft.lines[0]?.description).toBe("");
  });

  test("reports a blocked storage write instead of claiming the draft is saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(saveInvoiceDraft(KEY, draft(), NOW)).toBeNull();
  });
});
