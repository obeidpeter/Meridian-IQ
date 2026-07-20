import { describe, expect, test } from "vitest";
import { invoicePdfFilename } from "./download";

describe("invoicePdfFilename", () => {
  test("keeps a plain invoice number as-is", () => {
    expect(invoicePdfFilename("INV-001")).toBe("invoice-INV-001.pdf");
    expect(invoicePdfFilename("2026_07.42")).toBe("invoice-2026_07.42.pdf");
  });

  test("folds filesystem-hostile characters to single dashes", () => {
    expect(invoicePdfFilename("INV/2026/001")).toBe("invoice-INV-2026-001.pdf");
    expect(invoicePdfFilename('A:"B"?<C>|D')).toBe("invoice-A-B-C-D.pdf");
    expect(invoicePdfFilename("No 42 / July")).toBe("invoice-No-42-July.pdf");
  });

  test("never emits leading/trailing separators or a hidden-file dot", () => {
    expect(invoicePdfFilename("/INV-9/")).toBe("invoice-INV-9.pdf");
    expect(invoicePdfFilename("..INV..")).toBe("invoice-INV.pdf");
  });

  test("an invoice number that sanitizes away still names a usable file", () => {
    expect(invoicePdfFilename("")).toBe("invoice.pdf");
    expect(invoicePdfFilename("///")).toBe("invoice.pdf");
  });
});
