import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ImportInvoicesResponse } from "@workspace/api-zod";
import { pool, closeDatabasePools } from "@workspace/db";
import {
  listen,
  closeAllServers,
  jsonCommandHeaders,
} from "./test-helpers/route-harness.ts";

// Unlike appFor(), this starts the main app, including CSRF, principal resolution,
// request-wide tenant transactions and commit-before-response. Never skips without PG.
const salt = randomUUID().replaceAll("-", "");
const firm = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();
const actor = randomUUID();
let base: string;
const previousAuth = process.env.ENABLE_DEV_AUTH;
const previousNodeEnv = process.env.NODE_ENV;
const headers = {
  "content-type": "application/json",
  "x-meridian-csrf": "1",
  "x-mock-role": "client_user",
  "x-mock-user": actor,
  "x-mock-firm": firm,
  "x-mock-client-party": clientA,
};

before(async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "real PostgreSQL DATABASE_URL is required",
  );
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "set E2E_DATABASE_DISPOSABLE=1 only for a migrated scratch database",
  );
  process.env.NODE_ENV = "test";
  process.env.ENABLE_DEV_AUTH = "true";
  await pool.query("SELECT 1");
  await pool.query("INSERT INTO firms (id, name) VALUES ($1, $2)", [
    firm,
    `Reliability ${salt}`,
  ]);
  await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    actor,
    `${salt}@test.example`,
  ]);
  await pool.query(
    `INSERT INTO parties (id, type, legal_name, tin, created_by_firm_id) VALUES
    ($1, 'client_business', 'Client A', $4, $7), ($2, 'client_business', 'Client B', $5, $7),
    ($3, 'buyer', 'Fixture Buyer', $6, $7)`,
    [clientA, clientB, buyer, `a-${salt}`, `b-${salt}`, `buyer-${salt}`, firm],
  );
  await pool.query(
    `INSERT INTO engagements (firm_id, client_party_id, type, title) VALUES
    ($1, $2, 'retainer', 'A'), ($1, $3, 'retainer', 'B')`,
    [firm, clientA, clientB],
  );
  const { default: app } = await import("./app.ts");
  base = await listen(app);
});

after(async () => {
  await closeAllServers();
  await closeDatabasePools();
  if (previousAuth === undefined) delete process.env.ENABLE_DEV_AUTH;
  else process.env.ENABLE_DEV_AUTH = previousAuth;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

function invoice(number: string, supplier = clientA) {
  return {
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: number,
    issueDate: "2026-09-04",
    lines: [
      {
        description: "Fixture",
        quantity: "1",
        unitPrice: "100",
        vatRate: "0.075",
      },
    ],
  };
}
const post = (route: string, body: unknown, extra = {}) =>
  fetch(base + route, {
    method: "POST",
    headers: { ...jsonCommandHeaders(), ...headers, ...extra },
    body: JSON.stringify(body),
  });

test("main HTTP stack requires CSRF and denies cross-client creation with zero invoice-side effects", async () => {
  const number = `DENIED-${salt}`;
  const csrf = await post("/api/invoices", invoice(number), {
    "x-meridian-csrf": "",
  });
  assert.equal(csrf.status, 403);
  await csrf.text();
  const denied = await post("/api/invoices", invoice(number, clientB));
  assert.equal(denied.status, 403);
  await denied.text();
  const result = await pool.query(
    "SELECT id FROM invoices WHERE invoice_number = $1",
    [number],
  );
  assert.equal(result.rowCount, 0);
  const lines = await pool.query(
    "SELECT l.id FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.invoice_number=$1",
    [number],
  );
  assert.equal(lines.rowCount, 0);
});

test("main HTTP transaction: stale writes and approvals conflict without lost content", async () => {
  const created = await post("/api/invoices", invoice(`REV-${salt}`));
  assert.equal(created.status, 201, await created.clone().text());
  const body = z
    .object({
      invoice: z.object({
        id: z.string().uuid(),
        contentRevision: z.number().int().positive(),
      }),
    })
    .parse(await created.json());
  const id = body.invoice.id;
  const revision = body.invoice.contentRevision;
  assert.ok(
    Number.isInteger(revision),
    "source contract exposes contentRevision",
  );
  const patch = (description: string) =>
    fetch(base + `/api/invoices/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: revision,
        lines: [
          { description, quantity: "1", unitPrice: "100", vatRate: "0.075" },
        ],
      }),
    });
  const writes = await Promise.all([patch("A"), patch("B")]);
  assert.deepEqual(
    writes.map((response) => response.status).sort(),
    [200, 409],
  );
  await Promise.all(writes.map((response) => response.text()));
  const approve = await post(
    `/api/invoices/${id}/approve`,
    { expectedRevision: revision },
    { "x-mock-role": "firm_admin", "x-mock-client-party": "" },
  );
  assert.equal(approve.status, 409);
  await approve.text();
  const stored = await pool.query(
    "SELECT content_revision FROM invoices WHERE id=$1",
    [id],
  );
  assert.equal(stored.rows[0].content_revision, revision + 1);
  const approvals = await pool.query(
    "SELECT id FROM invoice_approvals WHERE invoice_id=$1 AND revoked_at IS NULL",
    [id],
  );
  assert.equal(approvals.rowCount, 0);
  const lines = await pool.query(
    "SELECT description FROM invoice_lines WHERE invoice_id=$1",
    [id],
  );
  assert.equal(lines.rowCount, 1);
  assert.ok(["A", "B"].includes(lines.rows[0].description));
});

test("main HTTP create retries and concurrent duplicate commands preserve one durable outcome", async () => {
  const number = `REPLAY-${salt}`;
  const key = randomUUID();
  const replayHeaders = { "x-idempotency-key": key };
  const body = invoice(number);
  const responses = await Promise.all([
    post("/api/invoices", body, replayHeaders),
    post("/api/invoices", body, replayHeaders),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
  );
  const bytes = await Promise.all(responses.map((response) => response.text()));
  assert.equal(bytes[0], bytes[1]);
  assert.equal(
    responses[0].headers.get("x-operation-id"),
    responses[1].headers.get("x-operation-id"),
  );
  // Discarding the first result does not require a second create after response loss.
  const retry = await post("/api/invoices", body, replayHeaders);
  assert.equal(retry.status, 201);
  assert.equal(await retry.text(), bytes[0]);
  const conflict = await post(
    "/api/invoices",
    { ...body, invoiceNumber: number + "-changed" },
    replayHeaders,
  );
  assert.equal(conflict.status, 409);
  await conflict.text();
  const durable = await pool.query(
    "SELECT id FROM invoices WHERE invoice_number LIKE $1",
    [number + "%"],
  );
  assert.equal(durable.rowCount, 1);
  const operations = await pool.query(
    "SELECT status FROM operations WHERE firm_id=$1 AND actor_id=$2 AND idempotency_key=$3",
    [firm, actor, key],
  );
  assert.equal(operations.rowCount, 1);
  assert.equal(operations.rows[0].status, "succeeded");
});

test("main HTTP import rolls back SQL failure and reports only durable row successes at both thresholds", async () => {
  const trigger = `r198_failure_${salt}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.description = '${trigger}' THEN RAISE EXCEPTION 'fixture failure' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER ${trigger} BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION ${trigger}();`);
  try {
    for (const size of [3, 101]) {
      const prefix = `IMPORT-${salt}-${size}-`;
      const rows = Array.from({ length: size }, (_, i) => ({
        rowNumber: i + 1,
        invoiceNumber: prefix + i,
        buyerName: "Fixture Buyer",
        buyerTin: `buyer-${salt}`,
        issueDate: "2026-09-04",
        description: i === 1 ? trigger : "Valid fixture",
        quantity: "1",
        unitPrice: "100",
        vatRate: "0.075",
      }));
      const response = await post(
        "/api/invoices/import",
        { clientPartyId: clientA, rows, commit: true },
        { "x-idempotency-key": randomUUID() },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const result = ImportInvoicesResponse.parse(await response.json());
      const durable = await pool.query(
        "SELECT id FROM invoices WHERE invoice_number LIKE $1 ORDER BY id",
        [prefix + "%"],
      );
      assert.equal(durable.rowCount, size - 1);
      assert.equal(result.createdCount, durable.rowCount);
      assert.deepEqual(
        result.rows
          .filter((row) => row.status === "created")
          .map((row) => z.string().uuid().parse(row.invoiceId))
          .sort(),
        durable.rows.map((row) => row.id),
      );
      assert.equal(result.rows[1].status, "invalid");
      assert.equal(result.rows[1].invoiceId, null);
      const orphaned = await pool.query(
        "SELECT id FROM invoices WHERE invoice_number=$1",
        [prefix + "1"],
      );
      assert.equal(
        orphaned.rowCount,
        0,
        "failed line cannot leave an invoice header behind",
      );
    }
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS ${trigger} ON invoice_lines; DROP FUNCTION IF EXISTS ${trigger}();`,
    );
  }
});
