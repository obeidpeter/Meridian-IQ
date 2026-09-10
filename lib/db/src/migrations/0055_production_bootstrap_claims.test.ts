import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { pool } from "../client";
import { migration0055 } from "./0055_production_bootstrap_claims";

test("migration rollback preserves the permanent consumption record", () => {
  assert.doesNotMatch(
    migration0055.down,
    /\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i,
  );
});

test("Postgres enforces claim singleton, bypass-only reads and immutability", async () => {
  const client = await pool.connect();
  const key = `test-${randomUUID()}`;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_bootstrap_claims (key, operator_user_id)
       VALUES ($1, $2)`,
      [key, randomUUID()],
    );

    await client.query("SET LOCAL ROLE meridian_app");
    await client.query("SELECT set_config('app.bypass', 'off', true)");
    const hidden = await client.query(
      "SELECT key FROM production_bootstrap_claims WHERE key = $1",
      [key],
    );
    assert.equal(hidden.rowCount, 0);

    await client.query("SELECT set_config('app.bypass', 'on', true)");
    const visible = await client.query(
      "SELECT key FROM production_bootstrap_claims WHERE key = $1",
      [key],
    );
    assert.equal(visible.rowCount, 1);

    await client.query("SAVEPOINT duplicate_claim");
    await assert.rejects(
      client.query(
        `INSERT INTO production_bootstrap_claims (key, operator_user_id)
         VALUES ($1, $2)`,
        [key, randomUUID()],
      ),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    await client.query("ROLLBACK TO SAVEPOINT duplicate_claim");

    await client.query("SAVEPOINT mutate_claim");
    await assert.rejects(
      client.query(
        `UPDATE production_bootstrap_claims
            SET operator_user_id = $2
          WHERE key = $1`,
        [key, randomUUID()],
      ),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await client.query("ROLLBACK TO SAVEPOINT mutate_claim");

    await client.query("SAVEPOINT delete_claim");
    await assert.rejects(
      client.query("DELETE FROM production_bootstrap_claims WHERE key = $1", [
        key,
      ]),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await client.query("ROLLBACK TO SAVEPOINT delete_claim");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
