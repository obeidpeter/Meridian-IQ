import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import {
  pool,
  db,
  getDb,
  runInBypassContext,
  auditEventsTable,
} from "@workspace/db";
import { appendAudit } from "./audit.ts";
import { registry } from "../../lib/metrics.ts";

test("audit lock deadlines bound contention without appending or forking evidence", async () => {
  const blocker = await pool.connect();
  const entityId = randomUUID();
  const event = {
    action: "test.audit-contention",
    entityType: "test",
    entityId,
  };
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(918273)");
    const started = Date.now();
    await assert.rejects(
      runInBypassContext(async () => {
        await getDb().execute(sql`SET LOCAL lock_timeout = '100ms'`);
        await appendAudit(event);
      }),
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.entityId, entityId))
      ).length,
      0,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const row = await appendAudit(event);
  const next = await appendAudit({ ...event, entityId: randomUUID() });
  assert.equal(
    next.prevHash,
    row.hash,
    "the global evidence chain is preserved",
  );
  const metrics = await registry.metrics();
  assert.match(metrics, /meridian_audit_lock_failures_total [1-9]/);
  assert.match(metrics, /meridian_audit_lock_wait_seconds_count \d+/);
});
