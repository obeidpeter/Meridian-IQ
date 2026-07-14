import { test, expect, describe } from "vitest";
import {
  batchSummary,
  captureStatusLabel,
  captureBadgeClasses,
  usagePct,
  fieldLabel,
} from "./clerk";

describe("captureStatusLabel", () => {
  test("labels every lifecycle status from the client's seat", () => {
    expect(captureStatusLabel("pending")).toBe("Clerk is reading");
    expect(captureStatusLabel("extracted")).toBe("Awaiting review");
    expect(captureStatusLabel("in_review")).toBe("Being reviewed");
    expect(captureStatusLabel("approved")).toBe("Approved");
    expect(captureStatusLabel("rejected")).toBe("Rejected");
    expect(captureStatusLabel("escalated")).toBe("Escalated");
    expect(captureStatusLabel("failed")).toBe("Could not read");
  });

  test("humanizes an unknown status instead of throwing", () => {
    expect(captureStatusLabel("weird_state")).toBe("Weird state");
  });
});

describe("captureBadgeClasses", () => {
  test("maps statuses onto the shared pill tones", () => {
    expect(captureBadgeClasses("approved")).toContain("emerald");
    expect(captureBadgeClasses("in_review")).toContain("amber");
    expect(captureBadgeClasses("escalated")).toContain("amber");
    expect(captureBadgeClasses("extracted")).toContain("blue");
    expect(captureBadgeClasses("rejected")).toContain("red");
    expect(captureBadgeClasses("failed")).toContain("red");
    expect(captureBadgeClasses("pending")).toContain("slate");
  });

  test("falls back to slate for unrecognised statuses", () => {
    expect(captureBadgeClasses("something-new")).toContain("slate");
  });
});

describe("usagePct", () => {
  test("computes the rounded percent of the allowance consumed", () => {
    expect(usagePct(0, 1_000_000)).toBe(0);
    expect(usagePct(250_000, 1_000_000)).toBe(25);
    expect(usagePct(333_333, 1_000_000)).toBe(33);
    expect(usagePct(1_000_000, 1_000_000)).toBe(100);
  });

  test("clamps over-spend to 100 and negative usage to 0", () => {
    expect(usagePct(2_000_000, 1_000_000)).toBe(100);
    expect(usagePct(-5, 1_000_000)).toBe(0);
  });

  test("yields 0 for a missing, zero, negative, or non-finite budget", () => {
    expect(usagePct(500, 0)).toBe(0);
    expect(usagePct(500, -1)).toBe(0);
    expect(usagePct(500, Number.NaN)).toBe(0);
    expect(usagePct(500, Number.POSITIVE_INFINITY)).toBe(0);
    expect(usagePct(Number.NaN, 1_000)).toBe(0);
  });
});

describe("batchSummary", () => {
  test("reads naturally for a clean multi-invoice batch", () => {
    expect(batchSummary(3, 0)).toBe(
      "Clerk found 3 invoices and opened a case for each",
    );
  });

  test("appends the duplicate count when some segments were skipped", () => {
    expect(batchSummary(3, 1)).toBe(
      "Clerk found 3 invoices and opened a case for each · 1 duplicate skipped",
    );
    expect(batchSummary(2, 2)).toBe(
      "Clerk found 2 invoices and opened a case for each · 2 duplicates skipped",
    );
  });

  test("singularizes a one-invoice batch", () => {
    expect(batchSummary(1, 0)).toBe(
      "Clerk found 1 invoice and opened a case for it",
    );
  });

  test("explains an all-duplicates batch instead of claiming new cases", () => {
    expect(batchSummary(0, 2)).toBe(
      "Clerk found 2 invoices, but you'd already sent them all",
    );
    expect(batchSummary(0, 1)).toBe(
      "Clerk found 1 invoice, but you'd already sent it",
    );
  });

  test("falls back sanely when nothing was opened or skipped", () => {
    expect(batchSummary(0, 0)).toBe(
      "Clerk didn't find any new invoices in that document",
    );
  });
});

describe("fieldLabel", () => {
  test("splits camelCase into a sentence-cased label", () => {
    expect(fieldLabel("invoiceNumber")).toBe("Invoice number");
    expect(fieldLabel("supplierTaxId")).toBe("Supplier tax id");
    expect(fieldLabel("currency")).toBe("Currency");
  });
});
