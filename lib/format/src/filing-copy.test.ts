import { describe, expect, test } from "vitest";
import {
  FILING_KIND_LABELS,
  FILING_STATUS_LABELS,
  TAX_TYPE_LABELS,
  filingKindLabel,
  filingPeriodLabel,
  filingStatusLabel,
  taxTypeLabel,
} from "./filing-copy";

describe("filing-copy vocabulary", () => {
  test("maps cover the contract's closed catalogues", () => {
    expect(Object.keys(FILING_STATUS_LABELS).sort()).toEqual(
      ["filed", "prepared", "upcoming"].sort(),
    );
    expect(Object.keys(FILING_KIND_LABELS).sort()).toEqual(
      ["paye", "vat"].sort(),
    );
  });

  test("label helpers hit the maps and degrade off-catalogue tokens", () => {
    expect(filingStatusLabel("upcoming")).toBe("Upcoming");
    expect(filingStatusLabel("prepared")).toBe("Prepared");
    expect(filingStatusLabel("filed")).toBe("Filed");
    // The KIND is the return's own name, distinct from the tax-type token.
    expect(filingKindLabel("vat")).toBe("VAT return");
    expect(filingKindLabel("paye")).toBe("PAYE remittance");
    // Off-catalogue tokens from a newer server degrade to a title-cased
    // word, never a crash.
    expect(filingStatusLabel("in_review")).toBe("In review");
    expect(filingKindLabel("wht_return")).toBe("Wht return");
    expect(filingStatusLabel(null)).toBe("Unknown");
    expect(filingKindLabel("")).toBe("Unknown");
  });

  test("the tax-type vocabulary rides along from notice-copy (one home)", () => {
    expect(taxTypeLabel("vat")).toBe("VAT");
    expect(taxTypeLabel("paye")).toBe("PAYE");
    expect(TAX_TYPE_LABELS.vat).toBe("VAT");
    expect(taxTypeLabel("levy")).toBe("Levy");
  });
});

describe("filingPeriodLabel", () => {
  test("renders YYYY-MM as the month's name and year", () => {
    expect(filingPeriodLabel("2026-07")).toBe("July 2026");
    expect(filingPeriodLabel("2026-01")).toBe("January 2026");
    expect(filingPeriodLabel("2025-12")).toBe("December 2025");
  });

  test("junk input comes back verbatim, never a crash", () => {
    expect(filingPeriodLabel("junk")).toBe("junk");
    expect(filingPeriodLabel("2026-13")).toBe("2026-13");
    expect(filingPeriodLabel("2026-00")).toBe("2026-00");
    expect(filingPeriodLabel("2026")).toBe("2026");
    expect(filingPeriodLabel("")).toBe("");
  });
});
