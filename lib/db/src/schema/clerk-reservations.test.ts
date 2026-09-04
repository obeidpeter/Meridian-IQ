import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { clerkReservationsTable } from "./clerk-reservations.ts";
import { migration0053 } from "../migrations/0053_clerk_reservations.ts";

test("reservation schema inference retains migration53's bypass-only RLS policy", () => {
  const config = getTableConfig(clerkReservationsTable);
  assert.equal(config.enableRLS, true);
  assert.equal(config.policies.length, 1);
  const policy = config.policies[0];
  assert.equal(policy.name, "meridian_bypass_only");
  assert.equal(policy.for, "all");
  assert.equal(policy.to, "public");
  const dialect = new PgDialect();
  assert.equal(
    dialect.sqlToQuery(policy.using!).sql,
    "current_setting('app.bypass', true) = 'on'",
  );
  assert.equal(
    dialect.sqlToQuery(policy.withCheck!).sql,
    "current_setting('app.bypass', true) = 'on'",
  );
  assert.match(migration0053.up, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration0053.up, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(
    migration0053.up,
    /REVOKE DELETE ON clerk_reservations FROM meridian_app/,
  );
  assert.equal(migration0053.down, "SELECT 1;");
});
