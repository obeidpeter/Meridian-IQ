import { test, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  pool,
  withTransaction,
  firmsTable,
  invoicesTable,
  invoiceLinesTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { importInvoices, validateImportRow, type ImportRow } from "./import.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

const _connectClient = () => pool.connect();
type PoolClient = Awaited<ReturnType<typeof _connectClient>>;

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
const secondUserId = randomUUID();
const databaseTest = { skip: !process.env.DATABASE_URL };

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

// Mock only the wire transport so these checks exercise actual managed roots,
// savepoint lifetimes and Drizzle query compilation instead of fake transactions.
function mockContextTransport(
  t: TestContext,
  query: (text: string, params: unknown[]) => { rows: unknown[] },
) {
  const client = Object.assign(new EventEmitter(), {
    query: async (config: string | { text: string }, params: unknown[] = []) =>
      query(typeof config === "string" ? config : config.text, params),
    release: () => {},
  });
  return t.mock.method(
    pool,
    "connect",
    async () => client as unknown as PoolClient,
  );
}

function contextSetupSql(text: string): boolean {
  return (
    text === "SET LOCAL ROLE meridian_app" ||
    text.startsWith("SELECT set_config(")
  );
}

before(async () => {
  if (!process.env.DATABASE_URL) return;
  const db = getDb();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Import Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values([
      { id: userId, email: `imp-${SALT}@test.example` },
      { id: secondUserId, email: `imp-second-${SALT}@test.example` },
    ])
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
  for (const f of [
    "invoiceNumber",
    "buyerName",
    "buyerTin",
    "issueDate",
    "description",
    "quantity",
    "unitPrice",
    "vatRate",
  ]) {
    assert.ok(fields.includes(f), `${f} should be required`);
  }
  assert.deepEqual(validateImportRow(row(1) as Record<string, unknown>), []);
  assert.equal(
    validateImportRow(
      row(1, { issueDate: "not-a-date" }) as Record<string, unknown>,
    )[0]?.field,
    "issueDate",
  );
  assert.equal(
    validateImportRow(
      row(1, { dueDate: "31/31/2026" }) as Record<string, unknown>,
    )[0]?.field,
    "dueDate",
  );
  assert.equal(
    validateImportRow(row(1, { vatRate: "7.5" }) as Record<string, unknown>)[0]
      ?.field,
    "vatRate",
  );
  assert.equal(
    validateImportRow(row(1, { quantity: "0" }) as Record<string, unknown>)[0]
      ?.field,
    "quantity",
  );
});

test(
  "dry run counts valid and invalid rows without writing anything",
  databaseTest,
  async () => {
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
  },
);

test(
  "per-row commit creates the buyer once by TIN and reuses it",
  databaseTest,
  async () => {
    const result = await importInvoices(
      firmId,
      clientId,
      [row(11), row(12)],
      true,
      userId,
    );
    assert.equal(result.createdCount, 2);
    assert.equal(result.committed, true);
    assert.ok(result.rows.every((r) => r.status === "created" && r.invoiceId));
    const buyers = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(eq(partiesTable.tin, `TIN-IMP-${SALT}`));
    assert.equal(
      buyers.length,
      1,
      "both rows must share one buyer party per TIN",
    );
  },
);

test("year zero is rejected before any database write", async () => {
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
  assert.equal(result.rows[0].errors[0].field, "issueDate");
});

test(
  "bulk path creates every valid row, one buyer per TIN, sorted by rowNumber",
  databaseTest,
  async () => {
    const tin = `TIN-IMP-BULK-${SALT}`;
    const rows: ImportRow[] = [];
    // 101 valid rows (over the 100-row bulk threshold), one invalid in the middle,
    // pushed out of order to prove the response sort.
    for (let n = 101; n >= 1; n -= 1) {
      rows.push(row(n, { buyerTin: tin, invoiceNumber: `IMPB-${SALT}-${n}` }));
    }
    rows.push(
      row(102, {
        buyerTin: tin,
        invoiceNumber: `IMPB-${SALT}-102`,
        unitPrice: "",
      }),
    );
    const result = await importInvoices(firmId, clientId, rows, true, userId);
    assert.equal(result.total, 102);
    assert.equal(result.createdCount, 101);
    assert.equal(result.invalidCount, 1);
    assert.equal(result.committed, true);
    const numbers = result.rows.map((r) => r.rowNumber);
    assert.deepEqual(
      numbers,
      [...numbers].sort((a, b) => a - b),
      "rows sorted",
    );
    const buyers = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(eq(partiesTable.tin, tin));
    assert.equal(buyers.length, 1, "the bulk path creates one buyer per TIN");
  },
);

test("bulk all-invalid imports return every error without issuing any SQL", async (t) => {
  let transactions = 0;
  const transaction = mockContextTransport(t, (text) => {
    if (text === "BEGIN") transactions += 1;
    else if (text !== "COMMIT" && !contextSetupSql(text))
      assert.fail(`all-invalid imports must not query or insert rows: ${text}`);
    return { rows: [] };
  });
  try {
    for (const count of [101, 250, 5000]) {
      const rows = Array.from({ length: count }, (_, index) =>
        row(index + 1, { unitPrice: "" }),
      );
      const result = await importInvoices(firmId, clientId, rows, true, userId);
      assert.deepEqual(
        { ...result, rows: undefined },
        {
          total: count,
          validCount: 0,
          invalidCount: count,
          createdCount: 0,
          committed: true,
          rows: undefined,
        },
      );
      assert.equal(result.rows.length, count);
      assert.deepEqual(
        result.rows.map((entry) => entry.rowNumber),
        rows.map((entry) => entry.rowNumber),
      );
      assert.ok(
        result.rows.every(
          (entry) =>
            entry.status === "invalid" &&
            entry.invoiceId === null &&
            entry.errors.some((error) => error.field === "unitPrice"),
        ),
      );
    }
    assert.equal(
      transactions,
      3,
      "one managed root per bulk call; no fallback retry or data query",
    );
  } finally {
    transaction.mock.restore();
  }
});

for (const [count, failedIndex] of [
  [2, 0],
  [102, 0],
  [502, 500],
]) {
  test(
    `${count}-row import rolls back failed buyer creation and re-resolves the TIN`,
    databaseTest,
    async () => {
      const tin = `TIN-IMP-ROLLBACK-${count}-${SALT}`;
      const rows = Array.from({ length: count }, (_, index) =>
        row(index + 1, {
          buyerTin: tin,
          invoiceNumber: `IMP-ROLLBACK-${count}-${SALT}-${index + 1}`,
          // Valid import text, but PostgreSQL rejects NUL in a text column. The
          // invoice and buyer have already been inserted when the line fails.
          description:
            index === failedIndex ? "Rejected\u0000line" : "Saved line",
        }),
      );
      assert.deepEqual(
        validateImportRow(rows[failedIndex] as Record<string, unknown>),
        [],
      );
      const result = await withTransaction(() =>
        importInvoices(firmId, clientId, rows, true, userId),
      );
      assert.equal(result.total, count);
      assert.equal(result.createdCount, count - 1);
      assert.equal(result.validCount, count - 1);
      assert.equal(result.invalidCount, 1);
      assert.equal(result.committed, true);
      assert.equal(result.rows[failedIndex].status, "invalid");
      assert.equal(result.rows[failedIndex].invoiceId, null);
      assert.equal(result.rows[failedIndex].errors[0].field, "row");
      const created = result.rows.filter((entry) => entry.status === "created");
      assert.equal(created.length, count - 1);
      const buyers = await getDb()
        .select({ id: partiesTable.id })
        .from(partiesTable)
        .where(eq(partiesTable.tin, tin));
      assert.equal(
        buyers.length,
        1,
        "rolled-back buyer IDs must not survive in the cache",
      );
      const invoices = await getDb()
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(eq(invoicesTable.buyerPartyId, buyers[0].id));
      assert.equal(
        invoices.length,
        count - 1,
        "bulk rollback must remove all attempted invoices before fallback",
      );
      assert.deepEqual(
        invoices.map((entry) => entry.id).sort(),
        created.map((entry) => entry.invoiceId).sort(),
      );
      const lines = await getDb()
        .select({
          invoiceId: invoiceLinesTable.invoiceId,
          lineNo: invoiceLinesTable.lineNo,
        })
        .from(invoiceLinesTable)
        .innerJoin(
          invoicesTable,
          eq(invoiceLinesTable.invoiceId, invoicesTable.id),
        )
        .where(eq(invoicesTable.buyerPartyId, buyers[0].id));
      assert.equal(lines.length, count - 1);
      assert.ok(lines.every((line) => line.lineNo === 1));
      assert.equal(
        new Set(lines.map((line) => line.invoiceId)).size,
        count - 1,
      );
      const rejected = await getDb()
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(
          eq(invoicesTable.invoiceNumber, rows[failedIndex].invoiceNumber!),
        );
      assert.equal(
        rejected.length,
        0,
        "a failed row must leave no header without its line",
      );
    },
  );
}

test(
  "bulk import with one valid row and an existing buyer never inserts an empty buyer batch",
  databaseTest,
  async () => {
    const tin = `TIN-IMP-EXISTING-${SALT}`;
    const [buyer] = await getDb()
      .insert(partiesTable)
      .values({
        type: "buyer",
        legalName: `Existing import buyer ${SALT}`,
        tin,
        createdByFirmId: firmId,
        createdByUserId: userId,
      })
      .returning({ id: partiesTable.id });
    const rows = Array.from({ length: 101 }, (_, index) =>
      row(index + 1, {
        buyerTin: tin,
        invoiceNumber: `IMP-EXISTING-${SALT}-${index + 1}`,
        unitPrice: index === 100 ? "1000" : "",
      }),
    );
    const result = await withTransaction(() =>
      importInvoices(firmId, clientId, rows, true, userId),
    );
    assert.equal(result.createdCount, 1);
    assert.equal(result.validCount, 1);
    assert.equal(result.invalidCount, 100);
    assert.equal(result.rows[100].status, "created");
    const invoices = await getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.buyerPartyId, buyer.id));
    assert.deepEqual(
      invoices.map((invoice) => invoice.id),
      [result.rows[100].invoiceId],
    );
    const buyers = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(eq(partiesTable.tin, tin));
    assert.deepEqual(buyers, [buyer]);
  },
);

test("per-row and bulk imports lock once before buyer reads, independent of TIN order", async (t) => {
  for (const count of [2, 102]) {
    const events: string[] = [];
    let depth = 0;
    const stop = new Error("stop after buyer lookup");
    const transaction = mockContextTransport(t, (text, params) => {
      if (text === "BEGIN" || text.startsWith("savepoint ")) depth += 1;
      else if (
        text === "ROLLBACK" ||
        text === "COMMIT" ||
        text.startsWith("release savepoint ") ||
        text.startsWith("rollback to savepoint ")
      )
        depth -= 1;
      else if (contextSetupSql(text)) return { rows: [] };
      else if (text.includes("transaction_isolation")) {
        events.push(`isolation:${depth}`);
        return { rows: [{ isolation: "read committed" }] };
      } else if (text.includes("pg_advisory_xact_lock")) {
        assert.deepEqual(params, [
          JSON.stringify(["invoice.import.buyers", firmId, clientId]),
        ]);
        events.push(`lock:${depth}`);
      } else {
        events.push(`select:${depth}`);
        assert.match(text, /"parties"\."merged_into_id" is null/);
        assert.match(text, /i\.firm_id = /);
        assert.match(text, /i\.supplier_party_id = /);
        assert.equal(params.filter((value) => value === firmId).length, 2);
        assert.equal(params.filter((value) => value === clientId).length, 2);
        assert.ok(params.includes(userId));
        throw stop;
      }
      return { rows: [] };
    });
    try {
      const rows = Array.from({ length: count }, (_, index) =>
        row(index + 1, {
          buyerTin: index % 2 ? "A" : "Z",
        }),
      );
      await assert.rejects(
        importInvoices(firmId, clientId, rows, true, userId),
        (error) => error instanceof Error && error.cause === stop,
      );
      assert.deepEqual(events, ["isolation:1", "lock:1", "select:2"]);
    } finally {
      transaction.mock.restore();
    }
  }
});

test("snapshot isolation is rejected before locking or looking up buyers", async (t) => {
  const transaction = mockContextTransport(t, (text) => {
    if (text === "BEGIN" || text === "ROLLBACK" || contextSetupSql(text))
      return { rows: [] };
    assert.match(text, /transaction_isolation/);
    return { rows: [{ isolation: "repeatable read" }] };
  });
  try {
    await assert.rejects(
      importInvoices(firmId, clientId, [row(1)], true, userId),
      /requires READ COMMITTED/,
    );
  } finally {
    transaction.mock.restore();
  }
});

test("dry runs do not open a buyer-lock transaction", async (t) => {
  const transaction = t.mock.method(pool, "connect", () =>
    assert.fail("dry run must not lock"),
  );
  try {
    const result = await importInvoices(
      firmId,
      clientId,
      [row(1), row(2)],
      false,
      userId,
    );
    assert.equal(result.validCount, 2);
    assert.equal(result.createdCount, 0);
  } finally {
    transaction.mock.restore();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBuyerLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = await getDb().execute(
      sql`SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted`,
    );
    if (waiting.rows.length) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(
    "concurrent import did not wait for the first transaction's buyer lock",
  );
}

for (const [firstCount, secondCount, failFirst] of [
  [2, 102, false],
  [102, 2, false],
  [102, 102, true],
] as const) {
  test(
    `concurrent ${firstCount}/${secondCount}-row imports reuse buyers after commit${failFirst ? " and bulk rollback" : ""}`,
    databaseTest,
    async () => {
      const prefix = `IMP-CONCURRENT-${SALT}-${firstCount}-${secondCount}`;
      const tins = [`${prefix}-A`, `${prefix}-Z`];
      const firstReady = deferred<void>();
      const release = deferred<void>();
      const secondPid = deferred<number>();
      const first = withTransaction(async () => {
        const result = await importInvoices(
          firmId,
          clientId,
          Array.from({ length: firstCount }, (_, index) =>
            row(index + 1, {
              invoiceNumber: `${prefix}-first-${index}`,
              buyerTin: tins[index % 2],
              description:
                failFirst && index === 0
                  ? "Rejected\u0000line"
                  : "First import",
            }),
          ),
          true,
          userId,
        );
        firstReady.resolve();
        await release.promise;
        return result;
      });
      await Promise.race([
        firstReady.promise,
        first.then(() => assert.fail("first import ended before release")),
      ]);
      const second = withTransaction(async () => {
        await getDb().execute(sql`SET LOCAL lock_timeout = '10s'`);
        const pid = await getDb().execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        secondPid.resolve(pid.rows[0].pid);
        return importInvoices(
          firmId,
          clientId,
          Array.from({ length: secondCount }, (_, index) =>
            row(index + 1, {
              invoiceNumber: `${prefix}-second-${index}`,
              buyerTin: tins[1 - (index % 2)],
            }),
          ),
          true,
          secondUserId,
        );
      });
      try {
        const pid = await Promise.race([
          secondPid.promise,
          second.then(() => assert.fail("second import ended before locking")),
        ]);
        await Promise.race([
          waitForBuyerLock(pid),
          second.then(() =>
            assert.fail("second import bypassed the buyer lock"),
          ),
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.createdCount, firstCount - Number(failFirst));
      assert.equal(secondResult.createdCount, secondCount);
      const buyers = await getDb()
        .select({ id: partiesTable.id, tin: partiesTable.tin })
        .from(partiesTable)
        .where(inArray(partiesTable.tin, tins));
      assert.equal(
        buyers.length,
        2,
        "one buyer per TIN, despite different actors and reversed row orders",
      );
      assert.equal(new Set(buyers.map((buyer) => buyer.tin)).size, 2);
      const invoices = await getDb()
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(
          inArray(
            invoicesTable.buyerPartyId,
            buyers.map((buyer) => buyer.id),
          ),
        );
      assert.equal(
        invoices.length,
        firstCount + secondCount - Number(failFirst),
      );
    },
  );
}

for (const count of [2, 102]) {
  test(
    `${count}-row import does not reuse another firm or sibling client's TIN match`,
    databaseTest,
    async () => {
      const foreignFirm = randomUUID();
      const sibling = randomUUID();
      const tin = `TIN-IMP-SPHERE-${count}-${SALT}`;
      await getDb()
        .insert(firmsTable)
        .values({ id: foreignFirm, name: `Foreign import ${count} ${SALT}` });
      await getDb().insert(partiesTable).values({
        id: sibling,
        type: "client_business",
        legalName: "Sibling client",
      });
      const foreign = await getDb()
        .insert(partiesTable)
        .values([
          {
            type: "buyer",
            legalName: "Private foreign buyer",
            tin,
            createdByFirmId: foreignFirm,
            createdByUserId: userId,
          },
          {
            type: "buyer",
            legalName: "Private sibling buyer",
            tin,
            createdByFirmId: firmId,
            createdByUserId: secondUserId,
          },
        ])
        .returning({ id: partiesTable.id });
      await getDb()
        .insert(invoicesTable)
        .values({
          firmId,
          supplierPartyId: sibling,
          buyerPartyId: foreign[1].id,
          invoiceNumber: `SPHERE-${count}-${SALT}`,
          issueDate: "2026-01-15",
        });
      const result = await importInvoices(
        firmId,
        clientId,
        Array.from({ length: count }, (_, index) =>
          row(index + 1, {
            buyerTin: tin,
            invoiceNumber: `IMP-SPHERE-${count}-${SALT}-${index}`,
          }),
        ),
        true,
        userId,
      );
      assert.equal(result.createdCount, count);
      const [created] = await getDb()
        .select({ buyerId: invoicesTable.buyerPartyId })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, result.rows[0].invoiceId!));
      assert.ok(foreign.every((buyer) => buyer.id !== created.buyerId));
      const parties = await getDb()
        .select({ id: partiesTable.id })
        .from(partiesTable)
        .where(eq(partiesTable.tin, tin));
      assert.equal(
        parties.length,
        3,
        "out-of-sphere legacy matches must remain untouched",
      );
    },
  );
}

test(
  "a waiting import creates a fresh buyer after the lock holder rolls back",
  databaseTest,
  async () => {
    const tin = `TIN-IMP-LOCK-ROLLBACK-${SALT}`;
    const ready = deferred<void>();
    const release = deferred<void>();
    const pid = deferred<number>();
    const rollback = new Error("rollback first import");
    let rolledBackBuyer = "";
    const first = withTransaction(async () => {
      const result = await importInvoices(
        firmId,
        clientId,
        [
          row(1, {
            buyerTin: tin,
            invoiceNumber: `LOCK-ROLLBACK-FIRST-${SALT}`,
          }),
        ],
        true,
        userId,
      );
      const [invoice] = await getDb()
        .select({ buyer: invoicesTable.buyerPartyId })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, result.rows[0].invoiceId!));
      rolledBackBuyer = invoice.buyer;
      ready.resolve();
      await release.promise;
      throw rollback;
    });
    const firstOutcome = assert.rejects(first, (error) => error === rollback);
    await Promise.race([
      ready.promise,
      firstOutcome.then(() =>
        assert.fail("first import failed before buyer creation"),
      ),
    ]);
    const second = withTransaction(async () => {
      await getDb().execute(sql`SET LOCAL lock_timeout = '10s'`);
      const result = await getDb().execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      pid.resolve(result.rows[0].pid);
      return importInvoices(
        firmId,
        clientId,
        [
          row(1, {
            buyerTin: tin,
            invoiceNumber: `LOCK-ROLLBACK-SECOND-${SALT}`,
          }),
        ],
        true,
        secondUserId,
      );
    });
    try {
      const backendPid = await Promise.race([
        pid.promise,
        second.then(() => assert.fail("second import ended before locking")),
      ]);
      await Promise.race([
        waitForBuyerLock(backendPid),
        second.then(() => assert.fail("second import bypassed the buyer lock")),
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([firstOutcome, second]);
    }
    await firstOutcome;
    assert.equal((await second).createdCount, 1);
    const buyers = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(eq(partiesTable.tin, tin));
    assert.equal(buyers.length, 1);
    assert.notEqual(buyers[0].id, rolledBackBuyer);
  },
);
