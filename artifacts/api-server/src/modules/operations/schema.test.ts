import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { operationsTable } from "../../../../../lib/db/src/schema/operations.ts";
import {
  importRunChunksTable,
  importRunsTable,
} from "../../../../../lib/db/src/schema/import-runs.ts";
import { migration0051 } from "../../../../../lib/db/src/migrations/0051_operation_recovery.ts";
import { migration0054 } from "../../../../../lib/db/src/migrations/0054_import_runs.ts";

const dialect = new PgDialect();
const normalize = (sql: string) =>
  sql
    .replace(/"(?:operations|import_runs|import_run_chunks)"\./g, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();

for (const { table, migration, policyName, foreignKeys } of [
  {
    table: operationsTable,
    migration: migration0051.up,
    policyName: "meridian_operation_owner",
    foreignKeys: ["operations_firm_id_fkey", "operations_client_party_id_fkey"],
  },
  {
    table: importRunsTable,
    migration: migration0054.up,
    policyName: "meridian_import_run_owner",
    foreignKeys: [
      "import_runs_firm_id_fkey",
      "import_runs_client_party_id_fkey",
    ],
  },
  {
    table: importRunChunksTable,
    migration: migration0054.up,
    policyName: "meridian_import_run_owner",
    foreignKeys: [
      "import_run_chunks_client_party_id_fkey",
      "import_run_chunks_operation_id_fkey",
      "import_run_chunks_run_fk",
    ],
  },
]) {
  const config = getTableConfig(table);
  test(`${config.name} declares exactly the migration's owner RLS policy`, () => {
    assert.equal(config.enableRLS, true);
    assert.equal(
      config.policies.length,
      1,
      "no additional permissive bypass policy",
    );
    const [policy] = config.policies;
    assert.equal(policy.name, policyName);
    assert.equal(policy.for, "all");
    assert.equal(policy.to, "public");
    assert.ok(policy.using);
    assert.ok(policy.withCheck);
    const declared = migration.match(
      new RegExp(
        `CREATE POLICY ${policyName} ON ${config.name} USING \\(([\\s\\S]*?)\\) WITH CHECK \\(([\\s\\S]*?)\\);`,
      ),
    );
    assert.ok(declared, "migration must create the same named policy");
    assert.equal(
      normalize(dialect.sqlToQuery(policy.using).sql),
      normalize(declared[1]),
    );
    assert.equal(
      normalize(dialect.sqlToQuery(policy.withCheck).sql),
      normalize(declared[2]),
    );
    assert.ok(
      migration.includes(
        `ALTER TABLE ${config.name} FORCE ROW LEVEL SECURITY;`,
      ),
    );
  });

  test(`${config.name} constraint and index declarations match migrations`, () => {
    assert.deepEqual(
      config.foreignKeys.map((key) => key.getName()).sort(),
      foreignKeys.sort(),
    );
    for (const check of config.checks) {
      const declared = migration.match(
        new RegExp(
          `ALTER TABLE ${config.name} ADD CONSTRAINT ${check.name}\\s+CHECK \\(([\\s\\S]*?)\\);`,
        ),
      );
      assert.ok(declared, `${check.name} must be present in the migration`);
      assert.equal(
        normalize(dialect.sqlToQuery(check.value).sql),
        normalize(declared[1]),
      );
    }
    for (const index of config.indexes) {
      assert.ok(migration.includes(`INDEX IF NOT EXISTS ${index.config.name}`));
    }
    for (const key of config.primaryKeys) {
      assert.ok(migration.includes(`CONSTRAINT ${key.getName()} PRIMARY KEY`));
    }
  });
}
