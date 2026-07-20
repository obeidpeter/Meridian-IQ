import { test, expect, describe } from "vitest";
import type {
  BillingStatementFee,
  BillingStatementTier,
  BillingStatementUsage,
} from "@workspace/api-client-react";
import {
  billingCardState,
  clerkUsageLine,
  intentBadgeClasses,
  intentMonthLabel,
  intentStatusLabel,
  overageLine,
  paymentErrorCopy,
  tierSummary,
} from "./billing-statement-card";
import { monthCsvFilename } from "@/lib/download";

// Billing statement display helpers plus the card's render state machine.
// Render-on-success is the INITIAL gate only (a 403 for roles without
// billing scope hides the whole section); once shown, the card stays
// mounted across month switches and failed month fetches.

describe("billingCardState", () => {
  test("hidden until the first statement loads — the initial render-on-success gate", () => {
    // Initial fetch in flight: nothing to show yet.
    expect(
      billingCardState({ hasStatement: false, isError: false, isFetching: true }),
    ).toBe("hidden");
    // Initial fetch failed (403/404): the section stays away entirely.
    expect(
      billingCardState({ hasStatement: false, isError: true, isFetching: false }),
    ).toBe("hidden");
  });

  test("a month switch keeps the card mounted with a loading hint", () => {
    expect(
      billingCardState({ hasStatement: true, isError: false, isFetching: true }),
    ).toBe("loading");
  });

  test("a failed month fetch shows an inline error, never a vanished card", () => {
    expect(
      billingCardState({ hasStatement: true, isError: true, isFetching: false }),
    ).toBe("error");
    // Even while the retry is in flight the card reports the error state —
    // the held statement stays on screen underneath.
    expect(
      billingCardState({ hasStatement: true, isError: true, isFetching: true }),
    ).toBe("error");
  });

  test("a settled successful fetch renders the data plainly", () => {
    expect(
      billingCardState({ hasStatement: true, isError: false, isFetching: false }),
    ).toBe("data");
  });
});

describe("monthCsvFilename", () => {
  test("names the saved file after the statement month", () => {
    expect(monthCsvFilename("billing-statement", "2026-06-01")).toBe(
      "billing-statement-2026-06.csv",
    );
  });

  test("an empty month still yields a usable filename", () => {
    expect(monthCsvFilename("billing-statement", "")).toBe(
      "billing-statement.csv",
    );
  });
});

const tier = (over: Partial<BillingStatementTier> = {}): BillingStatementTier => ({
  key: "growth",
  name: "Growth",
  monthlyPrice: "50000",
  includedInvoices: 100,
  overagePrice: "200",
  clerkMonthlyTokens: null,
  ...over,
});

describe("tierSummary", () => {
  test("names the plan, price, allowance and overage rate", () => {
    const line = tierSummary(tier());
    expect(line).toContain("Growth");
    expect(line).toContain("/month");
    expect(line).toContain("100 accepted invoice(s) included");
    expect(line).toContain("per extra");
  });

  test("mentions the Clerk token allowance only when the tier sets one", () => {
    expect(tierSummary(tier())).not.toContain("Clerk tokens");
    expect(
      tierSummary(tier({ clerkMonthlyTokens: 2_000_000 })),
    ).toContain("Clerk tokens/month");
  });
});

describe("clerkUsageLine", () => {
  const usage = (
    over: Partial<BillingStatementUsage> = {},
  ): BillingStatementUsage => ({
    acceptedInvoices: 12,
    submissionAttempts: 15,
    clerkTokens: 1234567,
    clerkCalls: 89,
    byPurpose: [],
    ...over,
  });

  test("pairs the token total with the call count", () => {
    const line = clerkUsageLine(usage());
    // Grouping separators follow the runtime locale — assert the digits.
    expect(line).toMatch(/tokens across .*89.* call\(s\)/);
    expect(line.replace(/\D/g, "")).toContain("123456789");
  });

  test("a quiet month reads as zero, not blank", () => {
    expect(clerkUsageLine(usage({ clerkTokens: 0, clerkCalls: 0 }))).toBe(
      "0 tokens across 0 call(s)",
    );
  });
});

describe("overageLine", () => {
  const fee = (over: Partial<BillingStatementFee> = {}): BillingStatementFee => ({
    base: "50000",
    overageInvoices: 0,
    overage: "0",
    total: "50000",
    ...over,
  });

  test("inside the plan the row is the em-dash sentinel, never ₦0.00", () => {
    expect(overageLine(fee())).toBe("—");
  });

  test("an overage names the amount and how many invoices went over", () => {
    const line = overageLine(fee({ overageInvoices: 7, overage: "1400" }));
    expect(line).toContain("7 invoice(s) over the plan");
    expect(line).not.toBe("—");
  });
});

describe("paymentErrorCopy", () => {
  test("409 is the duplicate-payment wall, pointed at the list below", () => {
    expect(paymentErrorCopy(409)).toContain("already in motion");
  });

  test("400 is the zero-fee refusal — nothing to collect", () => {
    expect(paymentErrorCopy(400)).toContain("nothing to collect");
  });

  test("anything else reads as a plain retryable failure", () => {
    expect(paymentErrorCopy(500)).toContain("Try again");
    expect(paymentErrorCopy(undefined)).toContain("Try again");
  });
});

describe("payment intent status pills", () => {
  test("maps the provider lifecycle to labels and tones", () => {
    expect(intentStatusLabel("pending")).toBe("Pending");
    expect(intentBadgeClasses("pending")).toContain("amber");
    expect(intentStatusLabel("confirmed")).toBe("Confirmed");
    expect(intentBadgeClasses("confirmed")).toContain("emerald");
    expect(intentStatusLabel("failed")).toBe("Failed");
    expect(intentBadgeClasses("failed")).toContain("red");
    expect(intentStatusLabel("cancelled")).toBe("Cancelled");
    expect(intentBadgeClasses("cancelled")).toContain("slate");
  });

  test("a status from a newer server humanizes into a slate pill", () => {
    expect(intentStatusLabel("refunded")).toBe("Refunded");
    expect(intentBadgeClasses("refunded")).toContain("slate");
  });
});

describe("intentMonthLabel", () => {
  const months = [
    { value: "2026-06-01", label: "June 2026" },
    { value: "2026-05-01", label: "May 2026" },
  ];

  test("resolves through the statement's own month options", () => {
    expect(intentMonthLabel("2026-06-01", months)).toBe("June 2026");
  });

  test("falls back to the raw month for anything the list no longer carries", () => {
    expect(intentMonthLabel("2024-01-01", months)).toBe("2024-01-01");
  });
});
