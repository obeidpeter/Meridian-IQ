import { describe, expect, test } from "vitest";
import {
  WHT_CATEGORY_LABELS,
  WHT_CREDIT_STATUS_LABELS,
  whtCategoryLabel,
  whtCreditStatusLabel,
} from "./wht-copy";

describe("wht-copy vocabulary", () => {
  test("maps cover the contract's closed catalogues", () => {
    expect(Object.keys(WHT_CATEGORY_LABELS).sort()).toEqual(
      [
        "commission_5",
        "goods_2",
        "rent_10",
        "royalties_10",
        "services_5",
        "works_2",
      ].sort(),
    );
    expect(Object.keys(WHT_CREDIT_STATUS_LABELS).sort()).toEqual(
      ["awaiting_note", "note_received"].sort(),
    );
  });

  test("category labels name the rate; absence reads as no WHT", () => {
    expect(whtCategoryLabel("services_5")).toBe(
      "Services & professional fees — 5%",
    );
    expect(whtCategoryLabel("goods_2")).toBe("Supply of goods — 2%");
    expect(whtCategoryLabel("rent_10")).toBe("Rent & hire — 10%");
    expect(whtCategoryLabel(null)).toBe("No WHT");
    expect(whtCategoryLabel(undefined)).toBe("No WHT");
    expect(whtCategoryLabel("")).toBe("No WHT");
    // Off-catalogue tokens from a newer server degrade to a title-cased
    // word, never a crash.
    expect(whtCategoryLabel("dividends_10")).toBe("Dividends 10");
  });

  test("credit status labels hit the map and degrade off-catalogue", () => {
    expect(whtCreditStatusLabel("awaiting_note")).toBe("Awaiting credit note");
    expect(whtCreditStatusLabel("note_received")).toBe("Credit note received");
    expect(whtCreditStatusLabel("disputed")).toBe("Disputed");
    expect(whtCreditStatusLabel(null)).toBe("Unknown");
  });
});
