import { describe, expect, test } from "vitest";
import {
  VAT_STANDARD,
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
});

describe("toInvoiceLineInputs", () => {
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
