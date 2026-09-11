import assert from "node:assert/strict";
import { psql } from "./common.mjs";

// The reference is captured only after CI's policy pins and rollback tests pass.
// Compare actual definitions on the same PG major, never just object counts.
export const CATALOG_SQL = `SELECT json_build_object(
  'postgresMajor', current_setting('server_version_num')::int / 10000,
  'role', (SELECT row_to_json(r) FROM (
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
      rolcanlogin, rolinherit,
      has_schema_privilege('meridian_app', 'public', 'CREATE') AS schema_create
    FROM pg_roles WHERE rolname = 'meridian_app') r),
  'memberships', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]')
    FROM pg_roles WHERE rolname <> 'meridian_app'
      AND pg_has_role('meridian_app', oid, 'MEMBER')),
  'tables', (SELECT json_agg(row_to_json(t) ORDER BY name) FROM (
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      pg_get_userbyid(c.relowner) = 'meridian_app' AS app_owner,
      ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
      ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
        'TRUNCATE','REFERENCES','TRIGGER']) privilege
        WHERE has_table_privilege('meridian_app', c.oid, privilege) ORDER BY privilege) AS grants
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) t),
  'columns', (SELECT json_agg(row_to_json(c) ORDER BY table_name, ordinal_position) FROM (
    SELECT table_name, column_name, ordinal_position, column_default, is_nullable,
      data_type, udt_name, character_maximum_length, numeric_precision, numeric_scale,
      is_identity, identity_generation, is_generated, generation_expression
    FROM information_schema.columns WHERE table_schema = 'public') c),
  'enums', (SELECT json_agg(row_to_json(e) ORDER BY name, enumsortorder) FROM (
    SELECT t.typname AS name, e.enumsortorder, e.enumlabel
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public') e),
  'policies', (SELECT json_agg(row_to_json(p) ORDER BY tablename, policyname) FROM (
    SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public') p),
  'triggers', (SELECT json_agg(row_to_json(t) ORDER BY table_name, name) FROM (
    SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled AS enabled,
      pg_get_triggerdef(t.oid, false) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal) t),
  'functions', (SELECT json_agg(row_to_json(f) ORDER BY name, args) FROM (
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_functiondef(p.oid) AS definition, p.prosecdef AS security_definer,
      p.proconfig AS config, has_function_privilege('meridian_app', p.oid, 'EXECUTE') AS executable
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'meridian_%' AND p.prokind = 'f') f),
  'constraints', (SELECT json_agg(row_to_json(k) ORDER BY table_name, name) FROM (
    SELECT c.relname AS table_name, k.conname AS name, k.convalidated AS validated,
      pg_get_constraintdef(k.oid, false) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') k),
  'indexes', (SELECT json_agg(row_to_json(i) ORDER BY table_name, name) FROM (
    SELECT c.relname AS table_name, x.relname AS name, i.indisvalid AS valid,
      i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class x ON x.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') i),
  'migrations', (SELECT json_agg(row_to_json(m) ORDER BY version)
    FROM (SELECT version, name FROM public._schema_migrations) m)
);`;

export function assertSecurityCatalog(catalog) {
  assert.ok(catalog.role, "meridian_app role is missing");
  for (const flag of [
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolcanlogin",
    "schema_create",
  ]) {
    assert.equal(catalog.role[flag], false, `unsafe role privilege: ${flag}`);
  }
  assert.deepEqual(
    catalog.memberships,
    [],
    "runtime role may not assume other roles",
  );
  for (const section of [
    "tables",
    "columns",
    "policies",
    "triggers",
    "functions",
    "constraints",
    "indexes",
    "migrations",
  ]) {
    assert.ok(
      catalog[section]?.length > 0,
      `empty security reference: ${section}`,
    );
  }
  for (const table of catalog.tables) {
    assert.equal(table.app_owner, false, `runtime owns ${table.name}`);
    assert.ok(
      !table.grants.some((grant) => ["TRUNCATE", "TRIGGER"].includes(grant)),
      `unsafe grants: ${table.name}`,
    );
    const policies = catalog.policies.filter((p) => p.tablename === table.name);
    const tenant = table.columns.some((c) =>
      ["firm_id", "client_party_id", "party_id"].includes(c),
    );
    if (
      (tenant && table.name !== "audit_events") ||
      policies.length ||
      table.rls
    ) {
      assert.ok(
        table.rls && table.forced && policies.length,
        `RLS not enforced: ${table.name}`,
      );
    }
  }
  for (const policy of catalog.policies) {
    for (const expression of [policy.qual, policy.with_check].filter(Boolean)) {
      assert.notEqual(
        expression.replace(/[()\s]/g, "").toLowerCase(),
        "true",
        `unrestricted policy: ${policy.tablename}`,
      );
    }
  }
  for (const trigger of catalog.triggers)
    assert.ok(
      ["O", "A"].includes(trigger.enabled),
      `trigger disabled: ${trigger.table_name}/${trigger.name}`,
    );
  for (const constraint of catalog.constraints)
    assert.equal(
      constraint.validated,
      true,
      `unvalidated constraint: ${constraint.name}`,
    );
  for (const index of catalog.indexes)
    assert.ok(index.valid && index.ready, `invalid index: ${index.name}`);
}

export function compareSecurityCatalog(expected, actual) {
  assertSecurityCatalog(expected);
  assertSecurityCatalog(actual);
  expected = canonicalSecurityCatalog(expected);
  actual = canonicalSecurityCatalog(actual);
  for (const section of Object.keys(expected)) {
    assert.deepEqual(
      actual[section],
      expected[section],
      `Database ${section} differs from tested CI reference; require reviewed versioned SQL, not serving-time push`,
    );
  }
}

export function assertCompleteSecurityCatalog(expected, actual) {
  const catalogFields = [
    "postgresMajor",
    "role",
    "memberships",
    "tables",
    "columns",
    "enums",
    "policies",
    "triggers",
    "functions",
    "constraints",
    "indexes",
    "migrations",
  ];
  const roleFields = [
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolcanlogin",
    "rolinherit",
    "schema_create",
  ];
  const rowFields = {
    tables: ["name", "rls", "forced", "app_owner", "columns", "grants"],
    columns: [
      "table_name",
      "column_name",
      "ordinal_position",
      "column_default",
      "is_nullable",
      "data_type",
      "udt_name",
      "character_maximum_length",
      "numeric_precision",
      "numeric_scale",
      "is_identity",
      "identity_generation",
      "is_generated",
      "generation_expression",
    ],
    enums: ["name", "enumsortorder", "enumlabel"],
    policies: [
      "tablename",
      "policyname",
      "permissive",
      "roles",
      "cmd",
      "qual",
      "with_check",
    ],
    triggers: ["table_name", "name", "enabled", "definition"],
    functions: [
      "name",
      "args",
      "definition",
      "security_definer",
      "config",
      "executable",
    ],
    constraints: ["table_name", "name", "validated", "definition"],
    indexes: ["table_name", "name", "valid", "ready", "definition"],
    migrations: ["version", "name"],
  };
  const fields = (value, keys, label) => {
    assert.ok(
      value && typeof value === "object" && !Array.isArray(value),
      `${label} must be an object`,
    );
    assert.deepEqual(
      Object.keys(value).sort(),
      [...keys].sort(),
      `${label} has missing or unknown fields`,
    );
  };
  fields(expected, catalogFields, "expected security catalog");
  fields(actual, catalogFields, "security catalog");
  fields(expected.role, roleFields, "expected security catalog role");
  fields(actual.role, roleFields, "security catalog role");
  for (const [section, keys] of Object.entries(rowFields)) {
    assert.ok(
      Array.isArray(actual[section]),
      `security catalog ${section} must be an array`,
    );
    for (const row of actual[section])
      fields(row, keys, `security catalog ${section} row`);
  }
  compareSecurityCatalog(expected, actual);
}

function canonicalSecurityCatalog(catalog) {
  const result = structuredClone(catalog);
  // Physical column placement and generated object names differ between a
  // scratch schema push and an additive upgrade. Definitions and multiplicity
  // remain authoritative; trigger names are retained because ordering matters.
  for (const table of result.tables) table.columns.sort();
  for (const column of result.columns) delete column.ordinal_position;
  for (const constraint of result.constraints) delete constraint.name;
  for (const index of result.indexes) {
    delete index.name;
    index.definition = index.definition.replace(
      /^(CREATE (?:UNIQUE )?INDEX )(?:"(?:[^"]|"")*"|[^\s]+)( ON )/,
      "$1$2",
    );
  }
  for (const section of ["tables", "columns", "constraints", "indexes"])
    result[section].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
    );
  return result;
}

export function readSecurityCatalog(url) {
  const result = psql(
    url,
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL search_path = public, pg_catalog;
    SET LOCAL statement_timeout = '30s';
    ${CATALOG_SQL}
    COMMIT;`,
  );
  const json = result.split("\n").find((line) => line.startsWith("{"));
  assert.ok(json, "database did not return a security catalog");
  const catalog = JSON.parse(json);
  assertSecurityCatalog(catalog);
  return catalog;
}
