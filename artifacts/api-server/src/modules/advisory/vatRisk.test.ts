import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLedgerCsv,
  analyzeLedger,
  stampKey,
  type LedgerRow,
} from "./vatRisk.ts";

test("parses CSV with aliased headers, quoted fields and currency formatting", () => {
  const csv = [
    "Supplier TIN,Supplier Name,Invoice No,IRN,CSID,Amount,VAT",
    '12345678-0001,"Acme, Ltd",INV-1,IRN-1,CSID-1,"1,075,000",75000',
    "12345678-0002,Beta Co,INV-2,IRN-2,CSID-2,₦537500,37500",
  ].join("\n");
  const rows = parseLedgerCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].supplierName, "Acme, Ltd");
  assert.equal(rows[0].invoiceAmount, 1075000);
  assert.equal(rows[0].vatAmount, 75000);
  assert.equal(rows[1].invoiceAmount, 537500);
});

test("flags invoices without a verified stamp as input-VAT at risk", () => {
  const rows: LedgerRow[] = [
    {
      supplierTin: "T1",
      supplierName: "Verified Supplier",
      invoiceNumber: "INV-1",
      irn: "IRN-1",
      csid: "CSID-1",
      invoiceAmount: 1075000,
      vatAmount: 75000,
    },
    {
      supplierTin: "T2",
      supplierName: "Unstamped Supplier",
      invoiceNumber: "INV-2",
      irn: "IRN-2",
      csid: "CSID-2",
      invoiceAmount: 537500,
      vatAmount: 37500,
    },
  ];
  const valid = new Set<string>([stampKey("IRN-1", "CSID-1")]);
  const report = analyzeLedger(rows, valid, "Buyer Ltd");

  assert.equal(report.rowCount, 2);
  assert.equal(report.verifiedCount, 1);
  assert.equal(report.atRiskCount, 1);
  assert.equal(report.invalidCount, 0);
  assert.equal(report.totalVatAmount, 112500);
  assert.equal(report.totalVatAtRisk, 37500);
  assert.equal(report.rows[0].status, "verified");
  assert.equal(report.rows[0].vatAtRisk, 0);
  assert.equal(report.rows[1].status, "at_risk");
  assert.equal(report.rows[1].vatAtRisk, 37500);
});

test("malformed rows are reported as invalid_input and not scored", () => {
  const rows: LedgerRow[] = [
    { supplierTin: "T1", invoiceNumber: "INV-1", irn: "IRN-1", csid: "CSID-1", invoiceAmount: 100, vatAmount: 7.5 },
    { supplierTin: "T2", invoiceNumber: "INV-2", irn: "", csid: "CSID-2", invoiceAmount: 100, vatAmount: 7.5 },
  ];
  const report = analyzeLedger(rows, new Set(), "Buyer");
  assert.equal(report.invalidCount, 1);
  assert.equal(report.rows[1].status, "invalid_input");
  assert.equal(report.rows[1].vatAtRisk, 0);
});

test("buyer-supplier graph aggregates per supplier with buyer at the centre", () => {
  const rows: LedgerRow[] = [
    { supplierTin: "T1", invoiceNumber: "A", irn: "I1", csid: "C1", invoiceAmount: 200, vatAmount: 15 },
    { supplierTin: "T1", invoiceNumber: "B", irn: "I2", csid: "C2", invoiceAmount: 300, vatAmount: 22.5 },
    { supplierTin: "T2", invoiceNumber: "C", irn: "I3", csid: "C3", invoiceAmount: 100, vatAmount: 7.5 },
  ];
  const report = analyzeLedger(rows, new Set(), "Buyer");
  const buyer = report.graph.nodes.find((n) => n.kind === "buyer")!;
  const supplierNodes = report.graph.nodes.filter((n) => n.kind === "supplier");
  assert.equal(supplierNodes.length, 2);
  assert.equal(report.graph.edges.length, 2);
  assert.equal(buyer.invoiceCount, 3);
  const t1 = supplierNodes.find((n) => n.id === "supplier:T1")!;
  assert.equal(t1.invoiceCount, 2);
  assert.equal(t1.totalAmount, 500);
});

test("1000-row ledger: total exposure equals the independent recomputed sum", () => {
  const rows: LedgerRow[] = [];
  const valid = new Set<string>();
  let expectedAtRisk = 0;
  let expectedVatTotal = 0;
  for (let i = 0; i < 1000; i++) {
    const irn = `IRN-${i}`;
    const csid = `CSID-${i}`;
    const vat = 7.5 * (i + 1); // varied VAT amounts
    rows.push({
      supplierTin: `T${i % 25}`,
      supplierName: `Supplier ${i % 25}`,
      invoiceNumber: `INV-${i}`,
      irn,
      csid,
      invoiceAmount: vat * 15,
      vatAmount: vat,
    });
    expectedVatTotal += vat;
    // Stamp only even invoices; odd invoices are at risk.
    if (i % 2 === 0) valid.add(stampKey(irn, csid));
    else expectedAtRisk += vat;
  }
  const report = analyzeLedger(rows, valid);
  assert.equal(report.rowCount, 1000);
  assert.equal(report.verifiedCount, 500);
  assert.equal(report.atRiskCount, 500);
  assert.equal(report.totalVatAtRisk, Math.round(expectedAtRisk * 100) / 100);
  assert.equal(report.totalVatAmount, Math.round(expectedVatTotal * 100) / 100);
  // Sum of per-row vatAtRisk must reconcile with the reported total.
  const rowSum = report.rows.reduce((s, r) => s + r.vatAtRisk, 0);
  assert.equal(Math.round(rowSum * 100) / 100, report.totalVatAtRisk);
});
