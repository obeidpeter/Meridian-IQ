import test from "node:test";
import assert from "node:assert/strict";
import { postgresConnection, psql } from "./common.mjs";
import {
  CATALOG_SQL,
  assertSecurityCatalog,
  compareSecurityCatalog,
} from "./security-catalog.mjs";
import { migration0057 } from "../../../lib/db/src/migrations/0057_evidence_hub_guardrails.ts";

const BASELINE_SQL = `SELECT json_build_object(
  'version', (SELECT max(version) FROM public._schema_migrations),
  'tables', ARRAY[to_regclass('public.evidence_requests'), to_regclass('public.evidence_files'), to_regclass('public.evidence_events')],
  'types', ARRAY[to_regtype('public.evidence_status'), to_regtype('public.evidence_document_type'), to_regtype('public.evidence_scan_status')],
  'channels', (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'message_channel')
);`;

const FINANCIAL_FINGERPRINT_SQL = `SELECT json_build_object(
  'invoices', (SELECT json_build_object('count', count(*), 'digest',
    md5(coalesce(string_agg(md5(to_jsonb(i)::text), '' ORDER BY i.id), ''))) FROM invoices i),
  'lines', (SELECT json_build_object('count', count(*), 'digest',
    md5(coalesce(string_agg(md5(to_jsonb(l)::text), '' ORDER BY l.id), ''))) FROM invoice_lines l)
);`;

function jsonQuery(url, sql) {
  return JSON.parse(psql(url, sql));
}

function applyEvidenceUpgrade(url) {
  psql(
    url,
    `BEGIN;
    SET LOCAL search_path = public, pg_catalog;
    SET LOCAL statement_timeout = '60s';
    SET LOCAL lock_timeout = '5s';
    SELECT pg_advisory_xact_lock(991001);
    ${migration0057.up}
    INSERT INTO _schema_migrations(version, name) VALUES (57, 'evidence_hub_guardrails')
      ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
    COMMIT;`,
  );
}

test("fresh version-56 baseline upgrades without inferred schema or destructive setup", () => {
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "disposable PostgreSQL is mandatory",
  );
  const url = process.env.DATABASE_URL;
  assert.ok(url, "an explicitly prepared version-56 baseline is required");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(postgresConnection(url).url).hostname,
    ),
    "this upgrade fixture only runs against a local disposable database",
  );
  assert.deepEqual(
    jsonQuery(url, BASELINE_SQL),
    {
      version: 56,
      tables: [null, null, null],
      types: [null, null, null],
      channels: ["whatsapp", "sms", "email", "push"],
    },
    "prepare a fresh historical baseline; this test never tears down a newer schema",
  );
  const financial = jsonQuery(url, FINANCIAL_FINGERPRINT_SQL);

  applyEvidenceUpgrade(url);
  const first = jsonQuery(url, CATALOG_SQL);
  assertSecurityCatalog(first);
  for (const name of [
    "evidence_requests",
    "evidence_files",
    "evidence_events",
  ]) {
    const table = first.tables.find((entry) => entry.name === name);
    assert.ok(
      table?.rls && table.forced,
      `${name}: table and forced tenant RLS must be created by SQL`,
    );
  }
  assert.deepEqual(
    first.enums
      .filter((entry) => entry.name === "message_channel")
      .map((entry) => entry.enumlabel),
    ["whatsapp", "sms", "email", "push", "in_app"],
  );
  assert.ok(
    first.migrations.some(
      (entry) =>
        entry.version === 57 && entry.name === "evidence_hub_guardrails",
    ),
  );

  // Use a second committed transaction: PostgreSQL can now safely consume the
  // newly added in-app enum value, just as workers do after migration completion.
  assert.equal(psql(url, "SELECT 'in_app'::message_channel::text"), "in_app");
  applyEvidenceUpgrade(url);
  const repeated = jsonQuery(url, CATALOG_SQL);
  compareSecurityCatalog(first, repeated);
  assert.deepEqual(
    jsonQuery(url, FINANCIAL_FINGERPRINT_SQL),
    financial,
    "migration replay must preserve all existing invoice data",
  );
});
