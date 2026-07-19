import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCorrectionShape,
  computeCorrectionShapes,
  normalizeCorrectionField,
} from "./metrics.ts";

// Correction-shape mining: deterministic classification of the corrections
// exhaust by the SHAPE of each override. Pure functions, table-driven — no
// DB, no model.

test("classifyCorrectionShape: the closed taxonomy, case by case", () => {
  const cases: Array<{
    field: string;
    extracted: string | null;
    final: string | null;
    shape: string;
  }> = [
    // Day/month transposed in the same year — the classic scan error.
    {
      field: "issueDate",
      extracted: "2026-04-03",
      final: "2026-03-04",
      shape: "date_dmy_flip",
    },
    // The flip is recognized across the two date dialects the exhaust carries.
    {
      field: "dueDate",
      extracted: "03/04/2026",
      final: "2026-03-04",
      shape: "date_dmy_flip",
    },
    // A date correction that is not a transposition.
    {
      field: "issueDate",
      extracted: "2026-01-15",
      final: "2026-02-20",
      shape: "date_other",
    },
    // Unparseable date text still counts as a date-field correction.
    {
      field: "dueDate",
      extracted: "next Friday",
      final: "2026-02-20",
      shape: "date_other",
    },
    // VAT dialect confusion: percent where the form wants a fraction, both ways.
    {
      field: "lines.vatRate",
      extracted: "7.5",
      final: "0.075",
      shape: "vat_percent_fraction",
    },
    {
      field: "lines.vatRate",
      extracted: "0.075",
      final: "7.5",
      shape: "vat_percent_fraction",
    },
    // A x10 slip on a rate field is a scale error, not dialect confusion.
    {
      field: "lines.vatRate",
      extracted: "0.75",
      final: "0.075",
      shape: "numeric_scale",
    },
    // Power-of-ten slips on amounts, either direction, comma noise tolerated.
    {
      field: "grandTotal",
      extracted: "1250000",
      final: "125000",
      shape: "numeric_scale",
    },
    {
      field: "subtotal",
      extracted: "1,250.00",
      final: "125000",
      shape: "numeric_scale",
    },
    // Numeric but no clean relationship.
    {
      field: "subtotal",
      extracted: "100",
      final: "137",
      shape: "numeric_other",
    },
    // Missed vs hallucinated.
    {
      field: "dueDate",
      extracted: null,
      final: "2026-02-20",
      shape: "missed_value",
    },
    {
      field: "supplierTin",
      extracted: "01234567-0001",
      final: null,
      shape: "hallucinated_value",
    },
    // Everything else is a text correction.
    {
      field: "supplierName",
      extracted: "ACME LTD",
      final: "Acme Limited",
      shape: "text_other",
    },
  ];
  for (const c of cases) {
    assert.equal(
      classifyCorrectionShape(c.field, c.extracted, c.final),
      c.shape,
      `${c.field}: ${c.extracted} -> ${c.final}`,
    );
  }
});

test("line fields normalize by position; lines.count is bookkeeping, not a field", () => {
  assert.equal(normalizeCorrectionField("lines.3.vatRate"), "lines.vatRate");
  assert.equal(normalizeCorrectionField("lines.0.unitPrice"), "lines.unitPrice");
  assert.equal(normalizeCorrectionField("lines.count"), null);
  assert.equal(normalizeCorrectionField("issueDate"), "issueDate");
});

test("the fold groups changed corrections by normalized field and shape, newest example first", () => {
  const rows = computeCorrectionShapes([
    // Newest case first — its values must win the example slot.
    {
      corrections: [
        { field: "lines.0.vatRate", extracted: "750", final: "7.5", changed: true },
        { field: "lines.count", extracted: "2", final: "3", changed: true },
        { field: "invoiceNumber", extracted: "A-1", final: "A-1", changed: false },
      ],
    },
    {
      corrections: [
        { field: "lines.2.vatRate", extracted: "7.5", final: "0.075", changed: true },
        { field: "issueDate", extracted: null, final: "2026-01-01", changed: true },
      ],
    },
    { corrections: null },
  ]);

  assert.deepEqual(rows, [
    {
      field: "lines.vatRate",
      shape: "vat_percent_fraction",
      count: 2,
      exampleExtracted: "750",
      exampleFinal: "7.5",
    },
    {
      field: "issueDate",
      shape: "missed_value",
      count: 1,
      exampleExtracted: null,
      exampleFinal: "2026-01-01",
    },
  ]);
});
