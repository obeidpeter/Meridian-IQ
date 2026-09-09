import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "../client";
import { migration0056 } from "./0056_clerk_reservation_uniques";

// The single-column unique indexes on the two settlement columns, by column,
// with the index (constraint) name that carries them.
const UNIQUES = `
  SELECT a.attname AS column_name, x.relname AS index_name
    FROM pg_index i
    JOIN pg_class x ON x.oid = i.indexrelid
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
   WHERE i.indrelid = 'clerk_reservations'::regclass
     AND i.indisunique AND i.indnatts = 1 AND i.indpred IS NULL
     AND a.attname IN ('inference_call_id', 'provider_call_id')
   ORDER BY 1`;

async function uniques(client: pg.PoolClient) {
  return (await client.query<{ column_name: string; index_name: string }>(UNIQUES)).rows;
}

// Reproduce the production catalogue: the table exists without its two
// UNIQUE constraints (whatever name the builder gave them).
async function dropUniques(client: pg.PoolClient) {
  const { rows } = await client.query<{ conname: string }>(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'clerk_reservations'::regclass AND contype = 'u'",
  );
  for (const { conname } of rows) {
    await client.query(
      `ALTER TABLE clerk_reservations DROP CONSTRAINT ${client.escapeIdentifier(conname)}`,
    );
  }
}

test("migration 56 leaves a built table untouched and recreates dropped uniqueness by column (R113)", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await uniques(client);
    assert.deepEqual(
      before.map((row) => row.column_name),
      ["inference_call_id", "provider_call_id"],
      "the scratch schema carries both constraints",
    );
    await client.query(migration0056.up);
    assert.deepEqual(await uniques(client), before, "re-assertion is a no-op");

    await dropUniques(client);
    assert.deepEqual(await uniques(client), [], "production shape reproduced");
    await client.query(migration0056.up);
    assert.deepEqual(await uniques(client), [
      {
        column_name: "inference_call_id",
        index_name: "clerk_reservations_inference_call_id_unique",
      },
      {
        column_name: "provider_call_id",
        index_name: "clerk_reservations_provider_call_id_unique",
      },
    ]);
    await client.query(migration0056.up);
    assert.equal((await uniques(client)).length, 2, "idempotent after repair");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("migration 56 names the duplicated column instead of asserting over duplicate rows", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await dropUniques(client);
    const firm = randomUUID();
    const call = randomUUID();
    await client.query("INSERT INTO firms (id, name) VALUES ($1, $2)", [
      firm,
      "migration-56 fixture",
    ]);
    const { rows: [{ udt_name: outcomeType }] } = await client.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'clerk_inference_calls' AND column_name = 'outcome'",
    );
    const { rows: [{ outcome }] } = await client.query<{ outcome: string }>(
      `SELECT (enum_range(NULL::${client.escapeIdentifier(outcomeType)}))[1]::text AS outcome`,
    );
    await client.query(
      `INSERT INTO clerk_inference_calls (id, firm_id, purpose, model, prompt_version, input_ref, schema_valid, outcome)
       VALUES ($1, $2, 'migration-56', 'fixture', 'v1', 'fixture', true, $3::${client.escapeIdentifier(outcomeType)})`,
      [call, firm, outcome],
    );
    for (let i = 0; i < 2; i += 1) {
      await client.query(
        `INSERT INTO clerk_reservations (firm_id, reserved_tokens, month_start, expires_at, provider_call_id)
         VALUES ($1, 10, now(), now() + interval '1 hour', $2)`,
        [firm, call],
      );
    }
    await assert.rejects(
      client.query(migration0056.up),
      (error: unknown) =>
        error instanceof Error &&
        /clerk_reservations\.provider_call_id carries 1 duplicated value/.test(
          error.message,
        ) &&
        (error as { code?: string }).code === "23505",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});
