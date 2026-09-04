import { describe, expect, test } from "vitest";
import {
  VAT_STANDARD,
  type LineDraft,
  draftHasWork,
  emptyLine,
  lineTotal,
  lineTotals,
  todayIsoDate,
  toInvoiceLineInputs,
  updateLineAt,
} from "./invoice-lines";

describe("emptyLine", () => {
  test("starts with quantity 1 and the standard VAT fraction", () => {
    expect(emptyLine()).toEqual({
      description: "",
      quantity: "1",
      unitPrice: "",
      vatRate: VAT_STANDARD,
    });
  });
});

describe("todayIsoDate", () => {
  test("returns a YYYY-MM-DD string", () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("updateLineAt", () => {
  test("patches only the addressed row", () => {
    const lines = [emptyLine(), emptyLine()];
    const next = updateLineAt(lines, 1, { unitPrice: "1500" });
    expect(next[0]).toEqual(emptyLine());
    expect(next[1].unitPrice).toBe("1500");
    expect(next[1].quantity).toBe("1");
    // Immutably: the input rows are untouched.
    expect(lines[1].unitPrice).toBe("");
  });
});

describe("lineTotal / lineTotals", () => {
  test("computes extension, VAT and total for a row", () => {
    const t = lineTotal({
      description: "goods",
      quantity: "2",
      unitPrice: "1500",
      vatRate: "0.075",
    });
    expect(t.ext).toBe(3000);
    expect(t.vat).toBeCloseTo(225);
    expect(t.total).toBeCloseTo(3225);
  });

  test("treats empty inputs as zero while the user is still typing", () => {
    expect(lineTotal(emptyLine())).toEqual({ ext: 0, vat: 0, total: 0 });
  });

  test("sums net and VAT across lines", () => {
    const totals = lineTotals([
      { description: "a", quantity: "2", unitPrice: "1500", vatRate: "0.075" },
      { description: "b", quantity: "1", unitPrice: "1000", vatRate: "0" },
    ]);
    expect(totals.net).toBe(4000);
    expect(totals.vat).toBeCloseTo(225);
  });

  test("rounds extension half-up and computes VAT before extension rounding", () => {
    expect(
      lineTotal({
        description: "fractional",
        quantity: "0.5",
        unitPrice: "2.01",
        vatRate: "0.5",
      }),
    ).toEqual({ ext: 1.01, vat: 0.5, total: 1.51 });
  });

  test("rounds VAT half-up rather than binary floating-point ties", () => {
    expect(
      lineTotal({
        description: "VAT tie",
        quantity: "1",
        unitPrice: "0.60",
        vatRate: "0.075",
      }),
    ).toEqual({ ext: 0.6, vat: 0.05, total: 0.65 });
  });

  test("sums rounded lines in decimal arithmetic", () => {
    expect(
      lineTotals(
        Array.from({ length: 100 }, () => ({
          description: "small",
          quantity: "0.5",
          unitPrice: "0.01",
          vatRate: "0",
        })),
      ),
    ).toEqual({ net: 1, vat: 0, total: 1 });
    expect(
      lineTotals([
        { description: "a", quantity: "1", unitPrice: "0.10", vatRate: "0" },
        { description: "b", quantity: "1", unitPrice: "0.20", vatRate: "0" },
      ]),
    ).toEqual({ net: 0.3, vat: 0, total: 0.3 });
  });

  test.each(["-", ".", "NaN", "Infinity", "1e999", "0x10"])(
    "does not crash while typing invalid value %s",
    (unitPrice) => {
      expect(lineTotal({ ...emptyLine(), unitPrice })).toEqual({
        ext: 0,
        vat: 0,
        total: 0,
      });
    },
  );
});

describe("draftHasWork", () => {
  test("an empty draft is not work", () => {
    expect(draftHasWork({})).toBe(false);
    expect(draftHasWork({ lines: [emptyLine()] })).toBe(false);
    expect(draftHasWork({ lines: undefined })).toBe(false);
  });

  test("an invoice number or a picked customer is work", () => {
    expect(draftHasWork({ invoiceNumber: "INV-1" })).toBe(true);
    expect(draftHasWork({ buyerPartyId: "x" })).toBe(true);
    // Whitespace alone is not an invoice number.
    expect(draftHasWork({ invoiceNumber: "   " })).toBe(false);
  });

  test("a line with a description or a price is work", () => {
    expect(
      draftHasWork({ lines: [{ ...emptyLine(), description: "goods" }] }),
    ).toBe(true);
    expect(
      draftHasWork({ lines: [{ ...emptyLine(), unitPrice: "1500" }] }),
    ).toBe(true);
  });

  test("a malformed line object reads as empty without throwing", () => {
    expect(draftHasWork({ lines: [{} as LineDraft] })).toBe(false);
  });
});

describe("toInvoiceLineInputs", () => {
  test("preserves cents and fractional quantities beyond Number precision", () => {
    expect(
      toInvoiceLineInputs([
        {
          description: " exact ",
          quantity: "99999999999999.9999",
          unitPrice: "9999999999999999.99",
          vatRate: "0.0750",
        },
      ]),
    ).toEqual([
      {
        description: "exact",
        quantity: "99999999999999.9999",
        unitPrice: "9999999999999999.99",
        vatRate: "0.075",
      },
    ]);
  });

  test.each(["NaN", "Infinity", "0x10", "1e3", "", "-1", "1.001"])(
    "rejects invalid or overprecision price %s instead of coercing it",
    (unitPrice) => {
      expect(() =>
        toInvoiceLineInputs([{ ...emptyLine(), unitPrice }]),
      ).toThrow();
    },
  );

  test("enforces positive quantity and fractional VAT", () => {
    expect(() =>
      toInvoiceLineInputs([{ ...emptyLine(), unitPrice: "1", quantity: "0" }]),
    ).toThrow(/greater than zero/);
    expect(() =>
      toInvoiceLineInputs([{ ...emptyLine(), unitPrice: "1", vatRate: "7.5" }]),
    ).toThrow(/fraction/);
  });

  test("trims descriptions and normalizes the numeric strings", () => {
    expect(
      toInvoiceLineInputs([
        {
          description: "  consulting ",
          quantity: "01",
          unitPrice: "1500.50",
          vatRate: "0.075",
        },
      ]),
    ).toEqual([
      {
        description: "consulting",
        quantity: "1",
        unitPrice: "1500.5",
        vatRate: "0.075",
      },
    ]);
  });
});
