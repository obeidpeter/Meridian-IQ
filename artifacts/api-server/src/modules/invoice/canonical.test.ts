import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeToUbl,
  parseFromUbl,
  serializeToJson,
  parseFromJson,
  validateCanonical,
  type CanonicalInvoice,
} from "./canonical.ts";

// Golden fixture exercising the full mandatory field set (CORE-01, C2).
const GOLDEN: CanonicalInvoice = {
  invoiceNumber: "INV-GOLD-001",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  invoiceTypeCode: "380",
  currencyCode: "NGN",
  supplier: {
    legalName: "Widgets Ltd",
    tin: "12345678-0001",
    cacNumber: "RC123456",
    street: "1 Market Rd",
    city: "Lagos",
    countryCode: "NG",
  },
  buyer: {
    legalName: "MegaCorp",
    tin: "87654321-0001",
    cacNumber: "RC654321",
    street: "2 High St",
    city: "Abuja",
    countryCode: "NG",
  },
  lines: [
    {
      id: "1",
      description: "Consulting",
      quantity: "10",
      unitCode: "EA",
      unitPrice: "1000.00",
      vatRate: "7.50",
      lineExtension: "10000.00",
      vatAmount: "750.00",
    },
    {
      id: "2",
      description: "Support retainer",
      quantity: "1",
      unitCode: "EA",
      unitPrice: "5000.00",
      vatRate: "7.50",
      lineExtension: "5000.00",
      vatAmount: "375.00",
    },
  ],
  lineExtensionAmount: "15000.00",
  taxExclusiveAmount: "15000.00",
  taxAmount: "1125.00",
  taxInclusiveAmount: "16125.00",
  payableAmount: "16125.00",
};

test("UBL serialization emits an XML declaration", () => {
  const xml = serializeToUbl(GOLDEN);
  assert.ok(xml.startsWith("<?xml"), "UBL must begin with an XML declaration");
  assert.match(xml, /urn:oasis:names:specification:ubl:schema:xsd:Invoice-2/);
});

test("UBL round-trip is lossless", () => {
  const restored = parseFromUbl(serializeToUbl(GOLDEN));
  assert.deepEqual(restored, GOLDEN);
});

test("JSON round-trip is lossless", () => {
  const restored = parseFromJson(serializeToJson(GOLDEN));
  assert.deepEqual(restored, GOLDEN);
});

test("monetary values survive round-trip without float drift", () => {
  const restored = parseFromUbl(serializeToUbl(GOLDEN));
  assert.equal(restored.payableAmount, "16125.00");
  assert.equal(restored.lines[0].vatAmount, "750.00");
});

test("validateCanonical passes for a complete invoice", () => {
  assert.equal(validateCanonical(GOLDEN).length, 0);
});

test("validateCanonical flags a missing supplier TIN", () => {
  const bad: CanonicalInvoice = {
    ...GOLDEN,
    supplier: { ...GOLDEN.supplier, tin: "" },
  };
  const errors = validateCanonical(bad);
  assert.ok(errors.length > 0, "expected at least one field error");
});
