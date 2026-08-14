import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, firmsTable, invoicesTable, partiesTable, usersTable } from "@workspace/db";
import { importInvoices, validateImportRow, type ImportRow } from "./import.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The spreadsheet import engine (SME-02, NFR-03), moved out of the
// /invoices/import route in the R60 round. Pinned invariants:
//  - validateImportRow mirrors the guided single-invoice rules (mandatory
//    fields, real dates, fractional VAT);
//  - a dry run counts without writing;
//  - the per-row path resolves buyers by TIN (create once, reuse after) and
//    isolates row failures as row-level errors with validCount corrected;
//  - the bulk path (commit && rows > 100) creates every valid row, reuses one
//    buyer per TIN, and returns results sorted by rowNumber.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const userId = randomUUID();

const row = (n: number, over: Partial<ImportRow> = {}): ImportRow => ({
  rowNumber: n,
  invoiceNumber: `IMP-${SALT}-${n}`,
  buyerName: `Import Buyer ${SALT}`,
  buyerTin: `TIN-IMP-${SALT}`,
  issueDate: "2026-01-15",
  description: "Imported line",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
  ...over,
});

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Import Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `imp-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values({
    id: clientId,
    type: "client_business",
    legalName: `Import Client ${SALT}`,
  });
});

test("validateImportRow mirrors the guided single-invoice rules", () => {
  const missing = validateImportRow({});
  const fields = missing.map((e) => e.field);
  for (const f of ["invoiceNumber", "buyerName", "buyerTin", "issueDate", "description", "quantity", "unitPrice", "vatRate"]) {
    assert.ok(fields.includes(f), `${f} should be required`);
  }
  assert.deepEqual(validateImportRow(row(1) as Record<string, unknown>), []);
  assert.equal(
    validateImportRow(row(1, { issueDate: "not-a-date" }) as Record<string, unknown>)[0]?.field,
    "issueDate",
  );
  assert.equal(
    validateImportRow(row(1, { dueDate: "31/31/2026" }) as Record<string, unknown>)[0]?.field,
    "dueDate",
  );
  assert.equal(
    validateImportRow(row(1, { vatRate: "7.5" }) as Record<string, unknown>)[0]?.field,
    "vatRate",
  );
  assert.equal(
    validateImportRow(row(1, { quantity: "0" }) as Record<string, unknown>)[0]?.field,
    "quantity",
  );
});

test("dry run counts valid and invalid rows without writing anything", async () => {
  const result = await importInvoices(
    firmId,
    clientId,
    [row(1), row(2), row(3, { vatRate: "9" })],
    false,
    userId,
  );
  assert.equal(result.total, 3);
  assert.equal(result.validCount, 2);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(result.committed, false);
  assert.deepEqual(
    result.rows.map((r) => r.status),
    ["valid", "valid", "invalid"],
  );
  const written = await getDb()
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.firmId, firmId));
  assert.equal(written.length, 0, "a dry run must not insert invoices");
});

test("per-row commit creates the buyer once by TIN and reuses it", async () => {
  const result = await importInvoices(firmId, clientId, [row(11), row(12)], true, userId);
  assert.equal(result.createdCount, 2);
  assert.equal(result.committed, true);
  assert.ok(result.rows.every((r) => r.status === "created" && r.invoiceId));
  const buyers = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(eq(partiesTable.tin, `TIN-IMP-${SALT}`));
  assert.equal(buyers.length, 1, "both rows must share one buyer party per TIN");
});

test("a row failing after validation is reported as a row-level error", async () => {
  // Year zero passes the JS Date check but no such date exists in Postgres, so
  // the insert throws — the engine must fold it into a per-row "invalid" with
  // validCount corrected rather than aborting the batch.
  const result = await importInvoices(
    firmId,
    clientId,
    [row(21, { issueDate: "0000-01-01", invoiceNumber: `IMP-${SALT}-bad` })],
    true,
    userId,
  );
  assert.equal(result.validCount, 0);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(result.committed, true);
  assert.equal(result.rows[0].status, "invalid");
  assert.equal(result.rows[0].errors[0].field, "row");
});

test("bulk path creates every valid row, one buyer per TIN, sorted by rowNumber", async () => {
  const tin = `TIN-IMP-BULK-${SALT}`;
  const rows: ImportRow[] = [];
  // 101 valid rows (over the 100-row bulk threshold), one invalid in the middle,
  // pushed out of order to prove the response sort.
  for (let n = 101; n >= 1; n -= 1) {
    rows.push(row(n, { buyerTin: tin, invoiceNumber: `IMPB-${SALT}-${n}` }));
  }
  rows.push(row(102, { buyerTin: tin, invoiceNumber: `IMPB-${SALT}-102`, unitPrice: "" }));
  const result = await importInvoices(firmId, clientId, rows, true, userId);
  assert.equal(result.total, 102);
  assert.equal(result.createdCount, 101);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.committed, true);
  const numbers = result.rows.map((r) => r.rowNumber);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "rows sorted");
  const buyers = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(eq(partiesTable.tin, tin));
  assert.equal(buyers.length, 1, "the bulk path creates one buyer per TIN");
});
