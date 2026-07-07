import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRow, type CanonicalErpRow } from "./contract.ts";
import {
  CONNECTORS,
  sageproConnector,
  quickliteConnector,
  findConnector,
} from "./implementations.ts";

// PL-03 / INT-06 acceptance: two connectors implemented purely as configuration
// plus field mapping against one contract; incremental cursor pull proven on
// fixtures; zero connector-specific branches outside the connector modules.

test("both connectors satisfy the single contract shape", () => {
  assert.ok(Object.keys(CONNECTORS).length >= 2);
  for (const connector of Object.values(CONNECTORS)) {
    assert.equal(typeof connector.key, "string");
    assert.equal(typeof connector.authenticate, "function");
    assert.equal(typeof connector.pullInvoices, "function");
    // Every canonical field must be mapped by the connector's default map.
    const canonicalFields: (keyof CanonicalErpRow)[] = [
      "invoiceNumber",
      "buyerName",
      "buyerTin",
      "issueDate",
      "description",
      "quantity",
      "unitPrice",
      "vatRate",
    ];
    for (const field of canonicalFields) {
      assert.ok(
        connector.defaultFieldMap[field],
        `${connector.key} must map ${field}`,
      );
    }
  }
  assert.equal(findConnector("nope"), null);
});

test("authentication is connector configuration, not engine logic", async () => {
  assert.equal((await sageproConnector.authenticate({ apiKey: "sp_live" })).ok, true);
  assert.equal((await sageproConnector.authenticate({ apiKey: "bad" })).ok, false);
  assert.equal((await quickliteConnector.authenticate({ token: "t" })).ok, true);
  assert.equal((await quickliteConnector.authenticate({})).ok, false);
});

test("golden fixtures: SagePro native rows map through the default field map", async () => {
  const pull = await sageproConnector.pullInvoices({ company: "acme" }, null, 5);
  assert.equal(pull.rows.length, 5);
  assert.equal(pull.nextCursor, "5");
  assert.ok(pull.hasMore);
  const mapped = mapRow(pull.rows[0], sageproConnector.defaultFieldMap);
  assert.ok(mapped.row, JSON.stringify(mapped.errors));
  assert.match(mapped.row.invoiceNumber, /^SP-\d+$/);
  assert.match(mapped.row.issueDate, /^2027-\d{2}-\d{2}$/);
  // SagePro reports VAT as a percentage; the mapper normalizes to a fraction.
  assert.equal(mapped.row.vatRate, "0.075");
});

test("golden fixtures: QuickLite native rows map through the default field map", async () => {
  const pull = await quickliteConnector.pullInvoices({ realm: "demo" }, null, 5);
  const mapped = mapRow(pull.rows[0], quickliteConnector.defaultFieldMap);
  assert.ok(mapped.row, JSON.stringify(mapped.errors));
  assert.match(mapped.row.invoiceNumber, /^QL-\d+$/);
  assert.equal(mapped.row.vatRate, "0.075");
});

test("incremental pull is deterministic and cursor-resumable", async () => {
  const first = await sageproConnector.pullInvoices({ company: "acme" }, null, 10);
  const again = await sageproConnector.pullInvoices({ company: "acme" }, null, 10);
  assert.deepEqual(first.rows, again.rows, "same cursor must yield same rows");
  const second = await sageproConnector.pullInvoices(
    { company: "acme" },
    first.nextCursor,
    10,
  );
  const firstRefs = new Set(first.rows.map((r) => r.DocNo));
  for (const row of second.rows) {
    assert.ok(!firstRefs.has(row.DocNo), "resumed pull must not repeat rows");
  }
  // Draining the whole book terminates.
  const all = await sageproConnector.pullInvoices({ company: "acme" }, "0", 1000);
  assert.equal(all.hasMore, false);
});

test("per-connection field-map overrides win over connector defaults", () => {
  const native = {
    DocNo: "SP-1",
    CustomerName: "X",
    CustomerTIN: "",
    DocDate: "2027-01-01",
    Details: "d",
    Qty: "1",
    UnitCost: "100",
    VatPct: "7.5",
    CustomRef: "OVERRIDE-9",
  };
  const mapped = mapRow(native, {
    ...sageproConnector.defaultFieldMap,
    invoiceNumber: "CustomRef",
  });
  assert.ok(mapped.row);
  assert.equal(mapped.row.invoiceNumber, "OVERRIDE-9");
});

test("mapping reports per-field errors instead of importing garbage", () => {
  const mapped = mapRow(
    { ref: "", customer: "", date: "01/02/2027", price: "abc" },
    quickliteConnector.defaultFieldMap,
  );
  assert.equal(mapped.row, null);
  const fields = mapped.errors.map((e) => e.field);
  assert.ok(fields.includes("invoiceNumber"));
  assert.ok(fields.includes("buyerName"));
  assert.ok(fields.includes("issueDate"));
  assert.ok(fields.includes("unitPrice"));
});
