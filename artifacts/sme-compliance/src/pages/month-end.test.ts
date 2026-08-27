import { test, expect, describe } from "vitest";
import { destinationFor } from "./month-end";

const ALL_FEATURES = new Set([
  "reconciliation",
  "money_analytics",
  "collection_accounts",
  "statutory_desks",
]);
const ALL_CAPS = new Set(["obligation.read", "filing.read", "invoice.read"]);
const NONE = new Set<string>();

describe("destinationFor", () => {
  test("routes every contract key to the surface that resolves it", () => {
    expect(destinationFor("overdue_submissions", ALL_FEATURES, ALL_CAPS)).toBe("/invoices");
    expect(destinationFor("unbilled_income", ALL_FEATURES, ALL_CAPS)).toBe("/invoices/new");
    expect(destinationFor("unmatched_credits", ALL_FEATURES, ALL_CAPS)).toBe("/reconciliation");
    expect(destinationFor("missing_bills", ALL_FEATURES, ALL_CAPS)).toBe("/bills");
    expect(destinationFor("double_payments", ALL_FEATURES, ALL_CAPS)).toBe("/bills");
    expect(destinationFor("unmatched_collections", ALL_FEATURES, ALL_CAPS)).toBe("/collections");
    expect(destinationFor("open_obligations", ALL_FEATURES, ALL_CAPS)).toBe("/obligations");
    expect(destinationFor("open_filings", ALL_FEATURES, ALL_CAPS)).toBe("/filings");
    expect(destinationFor("wht_credits", ALL_FEATURES, ALL_CAPS)).toBe("/wht");
    expect(destinationFor("pending_approvals", ALL_FEATURES, ALL_CAPS)).toBe("/invoices");
  });

  test("a dark feature hides the destination instead of misrouting", () => {
    expect(destinationFor("wht_credits", NONE, ALL_CAPS)).toBeNull();
    expect(destinationFor("unmatched_credits", NONE, ALL_CAPS)).toBeNull();
    expect(destinationFor("open_filings", NONE, ALL_CAPS)).toBeNull();
    expect(destinationFor("overdue_submissions", NONE, NONE)).toBe("/invoices");
  });

  test("a missing capability hides the destination too", () => {
    expect(destinationFor("open_obligations", ALL_FEATURES, NONE)).toBeNull();
  });

  test("a key from a newer server falls back to the invoice vault", () => {
    expect(destinationFor("brand_new_check", NONE, NONE)).toBe("/invoices");
  });
});
