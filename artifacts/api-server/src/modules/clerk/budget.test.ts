import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  firmsTable,
  clerkInferenceCallsTable,
  runRequestContext,
} from "@workspace/db";
import { acquireFirmClerkBudgetPermit, firmClerkUsage } from "./budget.ts";
import { createGateway, CLERK_FLAG_KEY } from "./gateway.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";
import { z } from "zod/v4";

async function firm() {
  const id = randomUUID();
  await db.insert(firmsTable).values({ id, name: `Clerk reservation ${id}` });
  return id;
}

function row(firmId: string, promptTokens = 40) {
  return {
    firmId,
    purpose: "extract_invoice",
    model: "reservation-test",
    promptVersion: "test",
    inputRef: randomUUID(),
    schemaValid: true,
    outcome: "ok" as const,
    promptTokens,
    completionTokens: 10,
  };
}

test("provider-time permit owns no connection and settlement is exact, durable and single-use", async () => {
  const firmId = await firm();
  const otherFirm = await firm();
  const permit = await acquireFirmClerkBudgetPermit(firmId, 100);
  assert.ok(permit);
  try {
    assert.equal(
      pool.totalCount - pool.idleCount,
      0,
      "no connection remains checked out during provider work",
    );
    await assert.rejects(acquireFirmClerkBudgetPermit(firmId, 100), {
      code: "CLERK_BUSY",
    });
    assert.equal(
      (await pool.query("SELECT 1 AS ordinary_request")).rows[0]
        .ordinary_request,
      1,
    );
    const other = await acquireFirmClerkBudgetPermit(otherFirm, 100);
    assert.ok(other);
    try {
      await other.append(row(otherFirm));
    } finally {
      await other.release();
    }
    await assert.rejects(
      runRequestContext({ bypass: false, firmId }, async () => {
        await permit.append(row(firmId));
        throw new Error("ambient rollback");
      }),
      /ambient rollback/,
    );
    await permit.append(row(firmId, 90));
    const calls = await db
      .select()
      .from(clerkInferenceCallsTable)
      .where(eq(clerkInferenceCallsTable.firmId, firmId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptTokens, 40);
    const reservation = await pool.query(
      "SELECT settled_at, inference_call_id FROM clerk_reservations WHERE firm_id = $1",
      [firmId],
    );
    assert.ok(reservation.rows[0].settled_at);
    assert.equal(reservation.rows[0].inference_call_id, calls[0].id);
  } finally {
    await permit.release();
    await permit.release();
  }
  const next = await acquireFirmClerkBudgetPermit(firmId, 100);
  assert.ok(next, "settlement frees admission");
  try {
    await next.append(row(firmId));
  } finally {
    await next.release();
  }
});

test("exhausted budget never creates a reservation; ledger failures and expired uncertain spend fail closed", async () => {
  const firmId = await firm();
  const usage = await firmClerkUsage(firmId);
  await db
    .insert(clerkInferenceCallsTable)
    .values({
      ...row(firmId),
      promptTokens: usage.budgetTokens,
      completionTokens: 0,
    });
  assert.equal(await acquireFirmClerkBudgetPermit(firmId, 1), null);
  assert.equal(
    (
      await pool.query("SELECT id FROM clerk_reservations WHERE firm_id = $1", [
        firmId,
      ])
    ).rowCount,
    0,
  );

  const uncertainFirm = await firm();
  const permit = await acquireFirmClerkBudgetPermit(uncertainFirm, 100);
  assert.ok(permit);
  try {
    await assert.rejects(
      permit.append({ ...row(uncertainFirm), caseId: randomUUID() }),
    );
  } finally {
    await permit.release();
  }
  await pool.query(
    "UPDATE clerk_reservations SET expires_at = now() - interval '1 hour' WHERE firm_id = $1",
    [uncertainFirm],
  );
  await assert.rejects(acquireFirmClerkBudgetPermit(uncertainFirm, 100), {
    code: "CLERK_BUSY",
  });
  assert.equal(
    (
      await db
        .select()
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.firmId, uncertainFirm))
    ).length,
    0,
  );
  const unresolved = await pool.query(
    "SELECT reserved_tokens, settled_at FROM clerk_reservations WHERE firm_id = $1",
    [uncertainFirm],
  );
  assert.equal(Number(unresolved.rows[0].reserved_tokens), 100);
  assert.equal(unresolved.rows[0].settled_at, null);
});

test("short budget lock contention does not wait while owning the shared pool", async () => {
  const firmId = await firm();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`clerk-budget:${firmId}`],
    );
    const start = Date.now();
    await assert.rejects(acquireFirmClerkBudgetPermit(firmId, 100), {
      code: "CLERK_BUSY",
    });
    assert.ok(Date.now() - start < 1_000);
    assert.equal(pool.waitingCount, 0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("a separate instance cannot admit a firm with a durable pending reservation", async () => {
  const firmId = await firm();
  const permit = await acquireFirmClerkBudgetPermit(firmId, 100);
  assert.ok(permit);
  try {
    const modulePath = `./budget.ts?replica=${randomUUID()}`;
    const replica = (await import(modulePath)) as typeof import("./budget.ts");
    await assert.rejects(replica.acquireFirmClerkBudgetPermit(firmId, 100), {
      code: "CLERK_BUSY",
    });
    await permit.append(row(firmId));
  } finally {
    await permit.release();
  }
});

test("reservation table rejects tenant writes and does not reveal another firm's pending spend", async () => {
  const firmId = await firm();
  const permit = await acquireFirmClerkBudgetPermit(firmId, 100);
  assert.ok(permit);
  try {
    await assert.rejects(
      runRequestContext({ bypass: false, firmId }, async () => {
        const { getDb } = await import("@workspace/db");
        const { sql } = await import("drizzle-orm");
        const visible = await getDb().execute(
          sql`SELECT id FROM clerk_reservations WHERE firm_id = ${firmId}`,
        );
        assert.equal(visible.rows.length, 0);
        await getDb()
          .execute(sql`INSERT INTO clerk_reservations(firm_id, reserved_tokens, month_start, expires_at)
        VALUES (${firmId}, 1, now(), now() + interval '1 minute')`);
      }),
    );
    await permit.append(row(firmId));
  } finally {
    await permit.release();
  }
});

test("gateway's slow provider leaves database connections free and later settles actual token use", async () => {
  const flag = makeFlagGuard(CLERK_FLAG_KEY);
  await flag.saveAndSet(true);
  const firmId = await firm();
  let began!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const gateway = createGateway({
    model: "slow-provider",
    complete: async () => {
      began();
      await released;
      return {
        content: '{"value":"ok"}',
        promptTokens: 31,
        completionTokens: 9,
      };
    },
  });
  const inference = gateway.infer({
    firmId,
    purpose: "extract_invoice",
    promptVersion: "test",
    system: "test",
    user: "test",
    schemaName: "result",
    jsonSchema: { type: "object" },
    validator: z.object({ value: z.string() }),
    inputForHash: randomUUID(),
  });
  try {
    await Promise.race([
      started,
      inference.then(() => {
        throw new Error("Provider never started");
      }),
    ]);
    assert.equal(pool.totalCount - pool.idleCount, 0);
    assert.equal(
      (await pool.query("SELECT 1 AS responsive")).rows[0].responsive,
      1,
    );
    const reservation = await pool.query(
      "SELECT settled_at FROM clerk_reservations WHERE firm_id = $1",
      [firmId],
    );
    assert.equal(reservation.rows[0].settled_at, null);
  } finally {
    finish();
  }
  try {
    assert.deepEqual(await inference, { ok: true, data: { value: "ok" } });
    const calls = await db
      .select()
      .from(clerkInferenceCallsTable)
      .where(eq(clerkInferenceCallsTable.firmId, firmId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptTokens, 31);
    assert.equal(calls[0].completionTokens, 9);
  } finally {
    await flag.restore();
  }
});
