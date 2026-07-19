import { test, expect, describe } from "vitest";
import {
  batchSummary,
  captureStatusLabel,
  captureBadgeClasses,
  dataAnswerScope,
  formatTokens,
  handleClerkGatewayError,
  usageBreakdown,
  usagePct,
  fieldLabel,
} from "./clerk";

describe("dataAnswerScope", () => {
  test("joins the resolved display labels into one scope clause", () => {
    expect(dataAnswerScope({ month: "June 2026" })).toBe("June 2026");
    expect(
      dataAnswerScope({ month: "June 2026", client: "Adaeze Textiles" }),
    ).toBe("June 2026 · Adaeze Textiles");
  });

  test("yields an empty string for an unscoped lookup so the clause is skipped", () => {
    expect(dataAnswerScope(undefined)).toBe("");
    expect(dataAnswerScope({})).toBe("");
    // Blank labels contribute nothing rather than a dangling separator.
    expect(dataAnswerScope({ month: "  ", client: "Adaeze Textiles" })).toBe(
      "Adaeze Textiles",
    );
  });
});

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

describe("usageBreakdown", () => {
  test("sorts purposes by spend descending", () => {
    expect(
      usageBreakdown([
        { purpose: "ask_clerk", tokens: 200 },
        { purpose: "extract_invoice", tokens: 900 },
        { purpose: "draft_invoice", tokens: 500 },
      ]).rows,
    ).toEqual([
      { purpose: "extract_invoice", tokens: 900 },
      { purpose: "draft_invoice", tokens: 500 },
      { purpose: "ask_clerk", tokens: 200 },
    ]);
  });

  test("breaks spend ties alphabetically so the order is stable", () => {
    expect(
      usageBreakdown([
        { purpose: "transcribe_voice", tokens: 100 },
        { purpose: "ask_clerk", tokens: 100 },
      ]).rows.map((r) => r.purpose),
    ).toEqual(["ask_clerk", "transcribe_voice"]);
  });

  test("hides zero, negative, and non-finite rows", () => {
    const { rows, overflow } = usageBreakdown([
      { purpose: "extract_invoice", tokens: 900 },
      { purpose: "segment_batch", tokens: 0 },
      { purpose: "ask_clerk", tokens: -5 },
      { purpose: "draft_invoice", tokens: Number.NaN },
    ]);
    expect(rows).toEqual([{ purpose: "extract_invoice", tokens: 900 }]);
    expect(overflow).toBe(0);
  });

  test("caps visible rows and folds the remainder into overflow", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      purpose: `purpose_${i}`,
      tokens: 600 - i * 100,
    }));
    const { rows, overflow } = usageBreakdown(many);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ purpose: "purpose_0", tokens: 600 });
    expect(overflow).toBe(2);
    // Only rows with actual spend count toward the fold.
    expect(
      usageBreakdown([...many, { purpose: "quiet", tokens: 0 }]).overflow,
    ).toBe(2);
  });

  test("yields the empty shape for a missing or empty array", () => {
    // Version skew: a pre-0.35.0 server doesn't send byPurpose at all.
    expect(usageBreakdown(undefined)).toEqual({ rows: [], overflow: 0 });
    expect(usageBreakdown([])).toEqual({ rows: [], overflow: 0 });
  });
});

describe("formatTokens", () => {
  test("compacts large counts and leaves small ones whole", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  test("falls back to the dash placeholder for non-finite input", () => {
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("—");
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

describe("handleClerkGatewayError", () => {
  const gatewayError = (status: number, message: string) =>
    Object.assign(new Error("request failed"), {
      status,
      data: { error: message },
    });

  const collect = () => {
    const calls: Array<{ title: string; description: string }> = [];
    let disabled = false;
    return {
      calls,
      isDisabled: () => disabled,
      opts: {
        onDisabled: () => {
          disabled = true;
        },
        toast: (t: { title: string; description: string }) => {
          calls.push({ title: t.title, description: t.description });
        },
        fallbackTitle: "Clerk couldn't take that",
      },
    };
  };

  test("503 raises the kill-switch banner instead of a toast", () => {
    const c = collect();
    handleClerkGatewayError(gatewayError(503, "Clerk is disabled"), c.opts);
    expect(c.isDisabled()).toBe(true);
    expect(c.calls).toEqual([]);
  });

  test("429 relays the server's message under the allowance title", () => {
    const c = collect();
    handleClerkGatewayError(gatewayError(429, "Budget exhausted"), c.opts);
    expect(c.isDisabled()).toBe(false);
    expect(c.calls).toEqual([
      {
        title: "Monthly Clerk allowance used up",
        description: "Budget exhausted",
      },
    ]);
  });

  test("anything else relays the server's words under the fallback title", () => {
    const c = collect();
    handleClerkGatewayError(gatewayError(422, "No speech detected"), c.opts);
    expect(c.calls).toEqual([
      {
        title: "Clerk couldn't take that",
        description: "No speech detected",
      },
    ]);
  });

  test("untyped errors fall back to the generic message", () => {
    const c = collect();
    handleClerkGatewayError(new Error("network down"), c.opts);
    expect(c.calls).toEqual([
      { title: "Clerk couldn't take that", description: "network down" },
    ]);
  });
});
