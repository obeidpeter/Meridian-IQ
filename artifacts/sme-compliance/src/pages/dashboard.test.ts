import { test, expect, describe } from "vitest";
import { showFirstInvoiceCta } from "./dashboard";

// The receivables card's first-run nudge: a quiet "create your first invoice"
// link, and ONLY for a book with no invoices at all — an active book whose
// receivables are simply settled has earned silence, not a nag.
describe("showFirstInvoiceCta", () => {
  test("shows only when the client has no invoices at all", () => {
    expect(showFirstInvoiceCta(0)).toBe(true);
  });

  test("an active book — even fully settled — is never nagged", () => {
    expect(showFirstInvoiceCta(1)).toBe(false);
    expect(showFirstInvoiceCta(37)).toBe(false);
  });

  test("no summary yet (loading or failed) means no nudge — never guess", () => {
    expect(showFirstInvoiceCta(undefined)).toBe(false);
  });
});
