import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, getDb, pool, runRequestContext } from "@workspace/db";
import { migration0051 } from "../../../../../lib/db/src/migrations/0051_operation_recovery.ts";
import { migration0054 } from "../../../../../lib/db/src/migrations/0054_import_runs.ts";
import type { Principal } from "../auth/rbac.ts";
import { createDraft } from "../invoice/service.ts";
import {
  executeOperation,
  listOperations,
  operationOwnerTransaction,
  recoverOperation,
} from "./service.ts";

const firmId = randomUUID();
const clientId = randomUUID();
const siblingId = randomUUID();
const buyerId = randomUUID();
const principal: Principal = {
  userId: randomUUID(),
  firmId,
  clientPartyId: clientId,
  buyerPartyId: null,
  role: "client_user",
};
const inTenant = <T>(fn: () => Promise<T>, owner = principal) =>
  runRequestContext({ bypass: false, firmId: owner.firmId }, fn);

function input(key = randomUUID()) {
  return {
    principal,
    command: "invoice.create" as const,
    idempotencyKey: key,
    clientPartyId: clientId,
    payload: { invoiceNumber: key },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function draft(key: string) {
  return createDraft(
    {
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: key,
      issueDate: "2026-09-04",
      lines: [
        {
          description: "Recovery test",
          quantity: "1",
          unitPrice: "100",
          vatRate: "0",
        },
      ],
    },
    principal.userId,
  );
}

test("operation execution fails closed outside a caller transaction", async () => {
  await assert.rejects(
    executeOperation({
      ...input(),
      execute: async () => {
        assert.fail("must not execute");
      },
    }),
    /tenant transaction/,
  );
});

test("bypass roles are rejected with 403 even with a firm and invoice capabilities", async () => {
  for (const role of [
    "operator",
    "auditor",
    "bank_user",
    "buyer_user",
  ] as const) {
    const owner: Principal = {
      ...principal,
      role,
      capabilities: ["invoice.read", "invoice.write"],
    };
    await assert.rejects(listOperations(owner), {
      status: 403,
      code: "FORBIDDEN",
    });
    await assert.rejects(
      executeOperation({
        ...input(),
        principal: owner,
        execute: async () => {
          assert.fail("bypass must not execute");
        },
      }),
      { status: 403, code: "FORBIDDEN" },
    );
  }
});

test("history route mapping consumes only the scoped database run reference", async (t) => {
  const runId = randomUUID();
  const spoofedId = randomUUID();
  const rows = [
    { id: randomUUID(), command: "invoice.import", import_run_id: runId },
    { id: randomUUID(), command: "invoice.import", import_run_id: null },
    { id: randomUUID(), command: "invoice.create", import_run_id: null },
  ].map((row, index) => ({
    ...row,
    idempotency_key: `${spoofedId}:0`,
    status: "succeeded",
    summary: "Completed",
    created_at:
      index === 1
        ? new Date("2026-09-04T00:00:00.123Z")
        : "2026-09-04 01:00:00.123456+01",
    updated_at: "2026-09-04 00:01:00.987654+00",
    response_status: 200,
    response_body: JSON.stringify({ runId: spoofedId }),
  }));
  const client = Object.assign(new EventEmitter(), {
    release: () => undefined,
    query: async (query: string | { text: string }, params: unknown[] = []) => {
      const statement = typeof query === "string" ? query : query.text;
      if (statement.includes("current_setting('app.firm_id'")) {
        return {
          rows: [
            {
              firm_id: firmId,
              bypass: "off",
              role: "meridian_app",
              isolation: "read committed",
            },
          ],
        };
      }
      if (!statement.includes("FROM operations o")) return { rows: [] };
      for (const predicate of [
        "c.operation_id = o.id",
        "c.firm_id = o.firm_id",
        "c.actor_id = o.actor_id",
        "c.client_party_id = o.client_party_id",
        "r.id = c.run_id",
        "r.firm_id = c.firm_id",
        "r.actor_id = c.actor_id",
        "r.client_party_id = c.client_party_id",
        "r.id AS import_run_id",
      ])
        assert.ok(
          statement.includes(predicate),
          `missing scope/reference predicate: ${predicate}`,
        );
      assert.ok(params.includes(principal.userId));
      assert.ok(params.includes(principal.clientPartyId));
      const selected = rows.find((row) => params.includes(row.id));
      return { rows: selected ? [selected] : rows };
    },
  });
  const transaction = t.mock.method(pool, "connect", async () => client);
  try {
    const history = await inTenant(() => listOperations(principal));
    assert.deepEqual(
      history.operations.map((operation) => operation.route),
      [`/import?run=${runId}`, "/import", "/invoices"],
    );
    for (const [index, row] of rows.entries()) {
      const detail = await inTenant(() =>
        recoverOperation(principal, { id: row.id }),
      );
      assert.equal(detail.route, history.operations[index].route);
      assert.equal(detail.startedAt, "2026-09-04T00:00:00.123Z");
      assert.equal(detail.updatedAt, "2026-09-04T00:01:00.987Z");
      assert.equal(history.operations[index].startedAt, detail.startedAt);
      assert.equal(history.operations[index].updatedAt, detail.updatedAt);
    }
  } finally {
    transaction.mock.restore();
  }
});

describe(
  "durable operation PostgreSQL invariants",
  { skip: !process.env.DATABASE_URL, timeout: 60_000 },
  () => {
    before(async () => {
      await pool.query(migration0051.up);
      await pool.query(migration0051.up);
      await pool.query(migration0054.up);
      await pool.query(
        "INSERT INTO firms (id, name) VALUES ($1, 'Operation recovery tests')",
        [firmId],
      );
      await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
        principal.userId,
        `${principal.userId}@test.example`,
      ]);
      for (const id of [clientId, siblingId, buyerId]) {
        await pool.query(
          "INSERT INTO parties (id, type, legal_name) VALUES ($1, 'client_business', 'Operation party')",
          [id],
        );
      }
      for (const id of [clientId, siblingId]) {
        await pool.query(
          "INSERT INTO engagements (firm_id, client_party_id, type, status, title) VALUES ($1, $2, 'retainer', 'open', 'Operation tests')",
          [firmId, id],
        );
      }
    });
    after(async () => {
      await pool.end();
    });

    test("lost-response retry replays exact bytes/status and creates one invoice", async () => {
      const command = input();
      let calls = 0;
      const execute = async (tx: typeof db) => {
        assert.equal(tx, getDb());
        calls++;
        return { statusCode: 201, body: await draft(command.idempotencyKey) };
      };
      const first = await inTenant(() =>
        executeOperation({ ...command, execute }),
      );
      const replay = await inTenant(() =>
        executeOperation({ ...command, execute }),
      );
      assert.equal(calls, 1);
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(first.operationId, replay.operationId);
      assert.equal(first.body, replay.body);
      assert.equal(replay.statusCode, 201);
      const rows = await pool.query(
        "SELECT id FROM invoices WHERE firm_id = $1 AND invoice_number = $2",
        [firmId, command.idempotencyKey],
      );
      assert.equal(rows.rowCount, 1);
      const recovered = await inTenant(() =>
        recoverOperation(principal, { id: first.operationId }),
      );
      assert.deepEqual(recovered.result.body, JSON.parse(first.body));
      assert.equal(
        new Date(recovered.startedAt).toISOString(),
        recovered.startedAt,
      );
      assert.equal(
        new Date(recovered.updatedAt).toISOString(),
        recovered.updatedAt,
      );
    });

    test("concurrent duplicate reservations wait for commit and execute once", async () => {
      const command = input();
      const ready = deferred<void>();
      const release = deferred<void>();
      const secondPid = deferred<number>();
      let calls = 0;
      const first = inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => {
            calls++;
            const body = await draft(command.idempotencyKey);
            ready.resolve();
            await release.promise;
            return { statusCode: 201, body };
          },
        }),
      );
      await Promise.race([ready.promise, first]);
      const second = inTenant(async () => {
        const pid = await getDb().execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        secondPid.resolve(pid.rows[0].pid);
        return executeOperation({
          ...command,
          execute: async () => {
            calls++;
            return { statusCode: 201, body: "duplicate" };
          },
        });
      });
      void second.catch(() => {});
      try {
        const pid = await secondPid.promise;
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const activity = await pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          blocked,
          true,
          "duplicate must wait on the database reservation",
        );
        assert.equal(calls, 1);
      } finally {
        release.resolve();
      }
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.body, b.body);
      assert.equal(b.replayed, true);
      assert.equal(calls, 1);
    });

    test("changed payload conflicts without a second execution", async () => {
      const command = input();
      await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => ({ statusCode: 201, body: { saved: true } }),
        }),
      );
      await assert.rejects(
        inTenant(() =>
          executeOperation({
            ...command,
            payload: { changed: true },
            execute: async () => {
              assert.fail("must not execute");
            },
          }),
        ),
        { code: "IDEMPOTENCY_CONFLICT", status: 409 },
      );
    });

    test("concurrent different payloads produce one result and one mismatch", async () => {
      const command = input();
      let calls = 0;
      const outcomes = await Promise.allSettled(
        [1, 2].map((value) =>
          inTenant(() =>
            executeOperation({
              ...command,
              payload: { value },
              execute: async () => {
                calls++;
                return { statusCode: 201, body: { value } };
              },
            }),
          ),
        ),
      );
      assert.equal(calls, 1);
      assert.equal(
        outcomes.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = outcomes.find((result) => result.status === "rejected");
      assert.equal(
        failure?.status === "rejected" && failure.reason.code,
        "IDEMPOTENCY_CONFLICT",
      );
    });

    test("partial import row outcomes replay exactly without rerunning the import", async () => {
      const command = { ...input(), command: "invoice.import" as const };
      const body = {
        total: 2,
        createdCount: 1,
        invalidCount: 1,
        committed: true,
        rows: [
          { rowNumber: 1, status: "created", invoiceId: randomUUID() },
          {
            rowNumber: 2,
            status: "invalid",
            errors: [{ field: "row", message: "Rejected" }],
          },
        ],
      };
      const first = await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => ({ statusCode: 200, body, status: "partial" }),
        }),
      );
      const replay = await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => {
            assert.fail("must not rerun import");
          },
        }),
      );
      assert.equal(replay.body, first.body);
      const history = await inTenant(() =>
        recoverOperation(principal, { id: first.operationId }),
      );
      assert.equal(history.status, "partial");
      assert.deepEqual(history.result.body, body);
    });

    test("outer rollback erases both result and invoice; same key then executes", async () => {
      const command = input();
      await assert.rejects(
        inTenant(async () => {
          await executeOperation({
            ...command,
            execute: async () => ({
              statusCode: 201,
              body: await draft(command.idempotencyKey),
            }),
          });
          throw new Error("force outer rollback");
        }),
        /force outer rollback/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT id FROM invoices WHERE firm_id = $1 AND invoice_number = $2",
            [firmId, command.idempotencyKey],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        inTenant(() =>
          recoverOperation(principal, {
            command: command.command,
            idempotencyKey: command.idempotencyKey,
          }),
        ),
        { status: 404 },
      );
      const result = await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => ({
            statusCode: 201,
            body: await draft(command.idempotencyKey),
          }),
        }),
      );
      assert.equal(result.replayed, false);
    });

    test("tenant, actor and command are distinct key namespaces", async () => {
      const command = input();
      const otherFirm = randomUUID();
      await pool.query(
        "INSERT INTO firms (id, name) VALUES ($1, 'Other operation firm')",
        [otherFirm],
      );
      await pool.query(
        "INSERT INTO engagements (firm_id, client_party_id, type, status, title) VALUES ($1, $2, 'retainer', 'open', 'Other')",
        [otherFirm, clientId],
      );
      const owners = [
        principal,
        { ...principal, userId: `apikey:${randomUUID()}` },
        { ...principal, firmId: otherFirm },
      ];
      const ids = new Set<string>();
      for (const owner of owners) {
        const result = await inTenant(
          () =>
            executeOperation({
              ...command,
              principal: owner,
              execute: async () => ({ statusCode: 200, body: { ok: true } }),
            }),
          owner,
        );
        ids.add(result.operationId);
      }
      const imported = await inTenant(() =>
        executeOperation({
          ...command,
          command: "invoice.import",
          execute: async () => ({ statusCode: 200, body: { rows: [] } }),
        }),
      );
      ids.add(imported.operationId);
      assert.equal(ids.size, 4);
    });

    test("own history hides sibling, other actor, other tenant and revoked engagement results", async () => {
      const command = input();
      const result = await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => ({
            statusCode: 200,
            body: { confidential: true },
          }),
        }),
      );
      const owners = [
        { ...principal, clientPartyId: siblingId },
        { ...principal, userId: randomUUID() },
        { ...principal, firmId: randomUUID() },
      ];
      for (const owner of owners) {
        await assert.rejects(
          inTenant(
            () => recoverOperation(owner, { id: result.operationId }),
            owner,
          ),
          { status: 404 },
        );
        assert.equal(
          (await inTenant(() => listOperations(owner), owner)).operations.some(
            (row) => row.id === result.operationId,
          ),
          false,
        );
      }
      await pool.query(
        "UPDATE engagements SET status = 'archived' WHERE firm_id = $1 AND client_party_id = $2",
        [firmId, clientId],
      );
      try {
        await assert.rejects(
          inTenant(() =>
            recoverOperation(principal, { id: result.operationId }),
          ),
          { status: 404 },
        );
        assert.equal(
          (await inTenant(() => listOperations(principal))).operations.length,
          0,
        );
      } finally {
        await pool.query(
          "UPDATE engagements SET status = 'open' WHERE firm_id = $1 AND client_party_id = $2",
          [firmId, clientId],
        );
      }
    });

    test("missing client binding and missing capability cannot read history", async () => {
      for (const owner of [
        { ...principal, clientPartyId: null },
        { ...principal, capabilities: [] },
      ]) {
        await assert.rejects(
          inTenant(() => listOperations(owner), owner),
          { status: 403 },
        );
      }
    });

    test("RLS refuses other actors even when SQL omits ownership filters", async () => {
      const command = input();
      const result = await inTenant(() =>
        executeOperation({
          ...command,
          execute: async () => ({ statusCode: 200, body: {} }),
        }),
      );
      await inTenant(async () => {
        await getDb().execute(
          sql`SELECT set_config('app.operation_actor_id', ${randomUUID()}, true)`,
        );
        assert.equal(
          (
            await getDb().execute(
              sql`SELECT id FROM operations WHERE id = ${result.operationId}::uuid`,
            )
          ).rows.length,
          0,
        );
      });
    });

    test("unfinished reservations cannot commit and completed results are immutable", async () => {
      await assert.rejects(
        inTenant(async () => {
          await getDb().execute(
            sql`SELECT set_config('app.operation_actor_id', ${principal.userId}, true)`,
          );
          await getDb()
            .execute(sql`INSERT INTO operations (firm_id, actor_id, client_party_id, command, idempotency_key, payload_hash)
        VALUES (${firmId}::uuid, ${principal.userId}, ${clientId}::uuid, 'invoice.create', ${randomUUID()}, ${"a".repeat(64)})`);
        }),
        (error: unknown) =>
          error instanceof Error &&
          (error.message.includes("unfinished operation") ||
            (error.cause instanceof Error &&
              error.cause.message.includes("unfinished operation"))),
      );
      const result = await inTenant(() =>
        executeOperation({
          ...input(),
          execute: async () => ({ statusCode: 201, body: { original: true } }),
        }),
      );
      await assert.rejects(
        pool.query("UPDATE operations SET response_body = '{}' WHERE id = $1", [
          result.operationId,
        ]),
        /immutable/,
      );
    });

    test("bounded keyset history preserves microseconds and never repeats a page", async () => {
      const owner = { ...principal, userId: `apikey:${randomUUID()}` };
      const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
      await inTenant(async () => {
        await operationOwnerTransaction(owner, "invoice.write");
        for (let i = 0; i < 3; i++) {
          const timestamp = `2026-09-04T00:00:00.12345${6 + i}+00:00`;
          await getDb().execute(sql`INSERT INTO operations
            (id, firm_id, actor_id, client_party_id, command, idempotency_key, payload_hash,
              status, response_status, response_body, created_at, updated_at)
            VALUES (${ids[i]}::uuid, ${firmId}::uuid, ${owner.userId}, ${clientId}::uuid,
              'invoice.create', ${randomUUID()}, ${"a".repeat(64)}, 'succeeded', 200, '{}',
              ${timestamp}::timestamptz, ${timestamp}::timestamptz)`);
        }
      }, owner);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await inTenant(
          () => listOperations(owner, { limit: 1, cursor }),
          owner,
        );
        assert.equal(page.operations[0].startedAt, "2026-09-04T00:00:00.123Z");
        assert.equal(page.operations[0].updatedAt, "2026-09-04T00:00:00.123Z");
        if (page.nextCursor) {
          const saved = JSON.parse(
            Buffer.from(page.nextCursor, "base64url").toString("utf8"),
          );
          assert.match(
            saved.createdAt,
            /\.12345[678]/,
            "cursor must retain PostgreSQL microseconds independently of response normalization",
          );
        }
        seen.push(...page.operations.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor && seen.length < 10);
      assert.equal(seen.length, 3);
      assert.equal(new Set(seen).size, 3);
      assert.deepEqual(seen, [...ids].reverse());
      await assert.rejects(
        inTenant(() => listOperations(principal, { cursor: "bad" })),
        { status: 400 },
      );
    });
  },
);
