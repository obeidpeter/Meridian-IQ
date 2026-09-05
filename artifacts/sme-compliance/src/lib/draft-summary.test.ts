import { expect, test } from "vitest";
import { draftAmount, draftOptionLabel, draftTime } from "./draft-summary";
import { emptyInvoiceDraft } from "./invoice-draft";
import { invoiceLineErrors } from "./invoice-lines";

const line = {
  description: "Delivery",
  quantity: "1",
  unitPrice: "100",
  vatRate: "0.075",
};
test.each(["", " ", "-1", "Infinity", "1e3", "0.001"])(
  "invalid price %j is not complete",
  (unitPrice) => {
    expect(invoiceLineErrors({ ...line, unitPrice }).unitPrice).toBeTruthy();
  },
);
test("free items are valid while a blank price is incomplete", () => {
  expect(invoiceLineErrors({ ...line, unitPrice: "0" })).toEqual({});
  expect(draftAmount(emptyInvoiceDraft())).toBe("Amount incomplete");
});
test.each(["0", "-2", "Infinity", "0.00001"])(
  "invalid quantity %j is actionable",
  (quantity) => {
    expect(invoiceLineErrors({ ...line, quantity }).quantity).toContain(
      "greater than zero",
    );
  },
);
test("unnumbered drafts have an item, amount and saved date instead of identical titles", () => {
  const draft = { ...emptyInvoiceDraft(), lines: [line] };
  const label = draftOptionLabel(draft, "2026-09-05T12:00:00Z");
  expect(label).toContain("Delivery");
  expect(label).toContain("107.50");
  expect(label).toContain("2026");
  expect(
    draftOptionLabel({ ...draft, lines: [{ ...line, description: "Design" }] }),
  ).not.toBe(label);
});
test("unknown dates are not presented as a real save or expiry", () => {
  expect(draftTime("invalid")).toBe("Not available");
  expect(draftTime()).toBe("Not available");
});
