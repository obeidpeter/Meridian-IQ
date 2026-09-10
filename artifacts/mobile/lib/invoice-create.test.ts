import { test } from "node:test";
import assert from "node:assert/strict";
import { serverFieldErrors } from "./api-error.ts";
import {
  buildInvoicePayload,
  humanizeFieldPath,
  localInvoiceError,
  newLine,
  nextVoiceKeyPrefix,
} from "./invoice-create.ts";
import type { LineDraft } from "./invoice-form.ts";

const line = (overrides: Partial<LineDraft> = {}): LineDraft => ({
  key: "k1",
  description: "Goods",
  quantity: "1",
  unitPrice: "100",
  vatRate: "7.5",
  ...overrides,
});

const valid = {
  clientPartyId: "client-1",
  buyerPartyId: "buyer-1",
  buyerSelected: true,
  invoiceNumber: "INV-0001",
  issueDate: "2026-09-01",
  lines: [line()],
};

test("humanizeFieldPath labels line paths by 1-based line and known keys, camelCase otherwise", () => {
  assert.equal(humanizeFieldPath("lines.0.unitPrice"), "Line 1 · Unit price");
  assert.equal(humanizeFieldPath("lines.2.vatRate"), "Line 3 · VAT rate");
  assert.equal(humanizeFieldPath("buyerPartyId"), "Buyer");
  assert.equal(humanizeFieldPath("issueDate"), "Issue date");
  assert.equal(humanizeFieldPath("someNewField"), "Some New Field");
  assert.equal(
    humanizeFieldPath("lines.0.someNewField"),
    "Line 1 · Some New Field",
  );
  assert.equal(humanizeFieldPath("meta.currency"), "Currency");
});

test("localInvoiceError reports the first missing piece, in order", () => {
  assert.equal(localInvoiceError(valid), null);
  assert.equal(
    localInvoiceError({ ...valid, clientPartyId: null }),
    "No client selected.",
  );
  assert.equal(
    localInvoiceError({ ...valid, buyerPartyId: null }),
    "Choose a buyer for this invoice.",
  );
  assert.equal(
    localInvoiceError({ ...valid, buyerSelected: false }),
    "Verify the selected buyer or choose an available buyer.",
  );
  assert.equal(
    localInvoiceError({ ...valid, invoiceNumber: "  " }),
    "Enter an invoice number.",
  );
  assert.equal(
    localInvoiceError({ ...valid, issueDate: "" }),
    "Enter an issue date.",
  );
  // Order: the buyer is reported before the invoice number.
  assert.equal(
    localInvoiceError({ ...valid, buyerPartyId: null, invoiceNumber: "" }),
    "Choose a buyer for this invoice.",
  );
});

test("localInvoiceError needs one described line with a price above zero", () => {
  const message = "Add at least one line item with a description and price.";
  assert.equal(localInvoiceError({ ...valid, lines: [] }), message);
  assert.equal(
    localInvoiceError({ ...valid, lines: [line({ description: "  " })] }),
    message,
  );
  assert.equal(
    localInvoiceError({ ...valid, lines: [line({ unitPrice: "0" })] }),
    message,
  );
  assert.equal(
    localInvoiceError({ ...valid, lines: [line({ unitPrice: "" })] }),
    message,
  );
  assert.equal(
    localInvoiceError({ ...valid, lines: [line({ unitPrice: "abc" })] }),
    message,
  );
  // A decimal comma parses; one good line among blanks is enough.
  assert.equal(
    localInvoiceError({
      ...valid,
      lines: [line({ description: "" }), line({ unitPrice: "0,5" })],
    }),
    null,
  );
});

test("buildInvoicePayload: a B2B invoice with trimmed fields and notes only when present", () => {
  const payloadLines = [
    { description: "Goods", quantity: "1", unitPrice: "100", vatRate: "0.075" },
  ];
  assert.deepEqual(
    buildInvoicePayload({
      clientPartyId: "client-1",
      buyerPartyId: "buyer-1",
      invoiceNumber: " INV-0001 ",
      issueDate: " 2026-09-01 ",
      notes: "  Net 30 ",
      payloadLines,
    }),
    {
      supplierPartyId: "client-1",
      buyerPartyId: "buyer-1",
      invoiceNumber: "INV-0001",
      issueDate: "2026-09-01",
      kind: "invoice",
      category: "b2b",
      notes: "Net 30",
      lines: payloadLines,
    },
  );
  assert.equal(
    buildInvoicePayload({
      clientPartyId: "client-1",
      buyerPartyId: "buyer-1",
      invoiceNumber: "INV-0001",
      issueDate: "2026-09-01",
      notes: "   ",
      payloadLines,
    }).notes,
    undefined,
  );
});

const keyCounter = (key: string): number => {
  const match = key.match(/^(?:line-\d+|voice)-(\d+)-?$/);
  assert.ok(match, `unexpected key shape ${key}`);
  return Number(match[1]);
};

test("newLine yields blank drafts with distinct, strictly increasing line- keys", () => {
  const first = newLine();
  const second = newLine();
  assert.match(first.key, /^line-\d+-\d+$/);
  assert.deepEqual(
    { ...first, key: undefined },
    {
      key: undefined,
      description: "",
      quantity: "1",
      unitPrice: "",
      vatRate: "7.5",
    },
  );
  assert.notEqual(first.key, second.key);
  // Relative to the previous value only: other suites bump the same counter.
  assert.ok(keyCounter(second.key) > keyCounter(first.key));
});

test("nextVoiceKeyPrefix shares newLine's counter, so voice and manual keys never collide", () => {
  const before = keyCounter(newLine().key);
  const prefix = nextVoiceKeyPrefix();
  assert.match(prefix, /^voice-\d+-$/);
  const voiceCounter = keyCounter(prefix);
  assert.ok(voiceCounter > before);
  assert.ok(keyCounter(nextVoiceKeyPrefix()) > voiceCounter);
  assert.ok(keyCounter(newLine().key) > voiceCounter + 1);
});

test("serverFieldErrors returns the payload's errors array and null for anything else", () => {
  const errors = [{ field: "lines.0.unitPrice", message: "Must be positive." }];
  assert.equal(serverFieldErrors({ status: 422, data: { errors } }), errors);
  assert.deepEqual(
    serverFieldErrors({ status: 422, data: { errors: [] } }),
    [],
  );
  assert.equal(
    serverFieldErrors({ status: 422, data: { errors: "bad" } }),
    null,
  );
  assert.equal(
    serverFieldErrors({ status: 422, data: { message: "x" } }),
    null,
  );
  assert.equal(serverFieldErrors({ status: 500, data: null }), null);
  assert.equal(serverFieldErrors(new Error("network")), null);
  assert.equal(serverFieldErrors(null), null);
  assert.equal(serverFieldErrors("string"), null);
});
