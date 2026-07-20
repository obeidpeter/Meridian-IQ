import { test, expect, describe } from "vitest";
import type {
  BillingStatementFee,
  BillingStatementTier,
  BillingStatementUsage,
} from "@workspace/api-client-react";
import {
  clerkUsageLine,
  overageLine,
  tierSummary,
} from "./billing-statement-card";

// Billing statement display helpers. The card itself is render-on-success
// (a 403 for roles without billing scope hides the whole section), matching
// the VAT pack beside it in the Money group.

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
