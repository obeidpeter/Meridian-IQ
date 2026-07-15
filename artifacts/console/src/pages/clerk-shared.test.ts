import { test, expect, describe } from "vitest";
import type {
  ClerkCase,
  ClerkExtractionField,
  ClerkExtractionLine,
} from "@workspace/api-client-react";
import {
  approveFormFromCase,
  isReadyToApprove,
  vatFractionFromPercent,
  vatPercentFromRaw,
  vatPercentInvalid,
  reviewEffort,
} from "./clerk-shared";

function field(patch: Partial<ClerkExtractionField>): ClerkExtractionField {
  return {
    field: "invoiceNumber",
    value: "INV-001",
    confidence: 0.97,
    sourceSnippet: null,
    critical: false,
    flagged: false,
    ...patch,
  };
}

function makeCase(patch: Partial<ClerkCase>): ClerkCase {
  return {
    id: "case-1",
    kind: "extraction",
    status: "extracted",
    createdBy: "op-1",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T10:00:00Z",
    preflight: [],
    extraction: {
      fields: [
        field({ field: "invoiceNumber", critical: true }),
        field({ field: "issueDate", value: "2026-06-30", critical: true }),
        field({ field: "dueDate", value: null, confidence: 0.4 }),
      ],
      lines: [],
      promptVersion: "v1",
      model: "test-model",
    },
    ...patch,
  };
}

describe("isReadyToApprove", () => {
  test("ready: extracted, empty pre-flight, criticals confident and present", () => {
    expect(isReadyToApprove(makeCase({}))).toBe(true);
  });

  test("not ready when preflight is null or undefined — never ran is not clear", () => {
    expect(isReadyToApprove(makeCase({ preflight: null }))).toBe(false);
    expect(isReadyToApprove(makeCase({ preflight: undefined }))).toBe(false);
  });

  test("not ready while pre-flight lists issues", () => {
    expect(
      isReadyToApprove(
        makeCase({
          preflight: [{ field: "issueDate", message: "Issue date is in the future" }],
        }),
      ),
    ).toBe(false);
  });

  test("not ready when a critical field has no value", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, value: null })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(false);
  });

  test("not ready when a critical field's confidence is below 0.9", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, confidence: 0.89 })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(false);
    // The boundary itself passes: >= 0.9, not > 0.9.
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, confidence: 0.9 })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(true);
  });

  test("a shaky NON-critical field does not block readiness", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [
              field({ critical: true }),
              field({ field: "dueDate", value: null, confidence: 0.1 }),
            ],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(true);
  });

  test("only status 'extracted' qualifies", () => {
    expect(isReadyToApprove(makeCase({ status: "in_review" }))).toBe(false);
    expect(isReadyToApprove(makeCase({ status: "pending" }))).toBe(false);
    expect(isReadyToApprove(makeCase({ status: "approved" }))).toBe(false);
  });
});

describe("vatPercentFromRaw", () => {
  test("percent-style strings keep their number, '%' stripped", () => {
    expect(vatPercentFromRaw("7.5%")).toBe("7.5");
    expect(vatPercentFromRaw("0%")).toBe("0");
    expect(vatPercentFromRaw("100%")).toBe("100");
  });

  test("bare numbers above 1 are already percents", () => {
    expect(vatPercentFromRaw("7.5")).toBe("7.5");
    expect(vatPercentFromRaw("75")).toBe("75");
  });

  test("bare numbers at or below 1 are fractions, scaled to percent", () => {
    expect(vatPercentFromRaw("0.075")).toBe("7.5");
    expect(vatPercentFromRaw("0.5")).toBe("50");
    // The boundary itself is treated as a fraction: 1 means 100%.
    expect(vatPercentFromRaw("1")).toBe("100");
  });

  test("float artifacts from the scale-up are rounded away", () => {
    // 0.07 * 100 → 7.000000000000001 without the toFixed round-trip.
    expect(vatPercentFromRaw("0.07")).toBe("7");
  });

  test("unusable input yields the empty string — never a default rate", () => {
    expect(vatPercentFromRaw(null)).toBe("");
    expect(vatPercentFromRaw("")).toBe("");
    expect(vatPercentFromRaw("abc")).toBe("");
    expect(vatPercentFromRaw("-5")).toBe("");
  });
});

describe("vatFractionFromPercent", () => {
  test("converts an operator-edited percent to the API's fraction", () => {
    expect(vatFractionFromPercent("7.5")).toBe("0.075");
    expect(vatFractionFromPercent("100")).toBe("1");
  });

  test("a stray '%' is stripped before converting", () => {
    expect(vatFractionFromPercent("7.5%")).toBe("0.075");
  });

  test("zero stays zero", () => {
    expect(vatFractionFromPercent("0")).toBe("0");
  });

  test("empty input stays empty", () => {
    expect(vatFractionFromPercent("")).toBe("");
    expect(vatFractionFromPercent("  ")).toBe("");
  });

  test("non-numeric input passes through untouched for the server to reject", () => {
    expect(vatFractionFromPercent("abc")).toBe("abc");
  });
});

describe("vatPercentInvalid", () => {
  test("explicit numbers in [0, 100] are valid, boundaries included", () => {
    expect(vatPercentInvalid("0")).toBe(false);
    expect(vatPercentInvalid("7.5")).toBe(false);
    expect(vatPercentInvalid("100")).toBe(false);
  });

  test("a stray '%' does not invalidate an otherwise good percent", () => {
    expect(vatPercentInvalid("7.5%")).toBe(false);
  });

  test("empty, non-numeric and out-of-range values are invalid", () => {
    expect(vatPercentInvalid("")).toBe(true);
    expect(vatPercentInvalid("  ")).toBe(true);
    expect(vatPercentInvalid("abc")).toBe(true);
    expect(vatPercentInvalid("-1")).toBe(true);
    expect(vatPercentInvalid("100.5")).toBe(true);
  });
});

describe("approveFormFromCase", () => {
  function line(patch: Partial<ClerkExtractionLine>): ClerkExtractionLine {
    return {
      description: "Consulting",
      quantity: "2",
      unitPrice: "5000",
      vatRate: "0.075",
      confidence: 0.95,
      ...patch,
    };
  }

  test("seeds the form from the extracted fields; party slots start empty", () => {
    const form = approveFormFromCase(
      makeCase({
        extraction: {
          fields: [
            field({ field: "invoiceNumber", value: "INV-042", critical: true }),
            field({ field: "issueDate", value: "2026-06-30" }),
            field({ field: "dueDate", value: "2026-07-30" }),
            field({ field: "currency", value: "USD" }),
          ],
          lines: [line({})],
          promptVersion: "v1",
          model: "test-model",
        },
      }),
    );
    expect(form.invoiceNumber).toBe("INV-042");
    expect(form.issueDate).toBe("2026-06-30");
    expect(form.dueDate).toBe("2026-07-30");
    expect(form.currency).toBe("USD");
    expect(form.category).toBe("b2b");
    // The operator picks these deliberately — never pre-filled.
    expect(form.firmId).toBe("");
    expect(form.supplierPartyId).toBe("");
    expect(form.buyerPartyId).toBe("");
  });

  test("currency defaults to NGN when extraction found none", () => {
    expect(approveFormFromCase(makeCase({})).currency).toBe("NGN");
  });

  test("missing fields and a missing extraction yield empty strings", () => {
    const form = approveFormFromCase(makeCase({ extraction: undefined }));
    expect(form.invoiceNumber).toBe("");
    expect(form.issueDate).toBe("");
    expect(form.dueDate).toBe("");
    expect(form.lines).toEqual([]);
  });

  test("line nulls get editable defaults; vatRate is normalised to percent", () => {
    const form = approveFormFromCase(
      makeCase({
        extraction: {
          fields: [field({})],
          lines: [
            line({}),
            line({
              description: null,
              quantity: null,
              unitPrice: null,
              vatRate: null,
            }),
          ],
          promptVersion: "v1",
          model: "test-model",
        },
      }),
    );
    expect(form.lines[0]).toEqual({
      description: "Consulting",
      quantity: "2",
      unitPrice: "5000",
      vatRate: "7.5",
    });
    // A missing VAT rate stays EMPTY — the operator must enter one.
    expect(form.lines[1]).toEqual({
      description: "",
      quantity: "1",
      unitPrice: "0",
      vatRate: "",
    });
  });
});

describe("reviewEffort", () => {
  const kase = (flagged: number, preflight: number) =>
    ({
      status: "extracted",
      preflight: Array.from({ length: preflight }, (_, i) => ({
        check: `c${i}`,
        detail: "x",
      })),
      extraction: {
        fields: [
          ...Array.from({ length: flagged }, (_, i) => ({
            field: `f${i}`,
            value: null,
            confidence: 0.2,
            sourceSnippet: null,
            critical: false,
            flagged: true,
          })),
          {
            field: "clean",
            value: "ok",
            confidence: 0.99,
            sourceSnippet: null,
            critical: false,
            flagged: false,
          },
        ],
        lines: [],
      },
    }) as never;

  test("counts flagged fields plus pre-flight findings", () => {
    expect(reviewEffort(kase(3, 2))).toBe(5);
    expect(reviewEffort(kase(0, 0))).toBe(0);
  });

  test("lighter cases sort ahead of heavier ones", () => {
    const light = kase(1, 0);
    const heavy = kase(4, 3);
    expect([heavy, light].sort((a, b) => reviewEffort(a) - reviewEffort(b))[0]).toBe(
      light,
    );
  });
});
