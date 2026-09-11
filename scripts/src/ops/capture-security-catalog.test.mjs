import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest } from "./build-manifest.mjs";
import { captureSecurityCatalog } from "./capture-security-catalog.mjs";

const catalog = {
  postgresMajor: 16,
  role: {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolcanlogin: false,
    rolinherit: true,
    schema_create: false,
  },
  memberships: [],
  tables: [
    {
      name: "invoices",
      rls: true,
      forced: true,
      app_owner: false,
      columns: ["firm_id"],
      grants: ["SELECT"],
    },
  ],
  columns: [
    {
      table_name: "invoices",
      column_name: "firm_id",
      ordinal_position: 1,
      column_default: null,
      is_nullable: "NO",
      data_type: "uuid",
      udt_name: "uuid",
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
      is_identity: "NO",
      identity_generation: null,
      is_generated: "NEVER",
      generation_expression: null,
    },
  ],
  enums: [],
  policies: [
    {
      tablename: "invoices",
      policyname: "firm_scope",
      permissive: "PERMISSIVE",
      roles: ["meridian_app"],
      cmd: "ALL",
      qual: "firm_id = current_setting('app.firm_id')::uuid",
      with_check: "firm_id = current_setting('app.firm_id')::uuid",
    },
  ],
  triggers: [
    {
      table_name: "invoices",
      name: "guard",
      enabled: "O",
      definition: "BEFORE UPDATE",
    },
  ],
  functions: [
    {
      name: "guard",
      args: "",
      definition: "RAISE EXCEPTION",
      security_definer: false,
      config: null,
      executable: true,
    },
  ],
  constraints: [
    {
      table_name: "invoices",
      name: "positive",
      validated: true,
      definition: "CHECK (amount > 0)",
    },
  ],
  indexes: [
    {
      name: "unique_line",
      table_name: "invoices",
      valid: true,
      ready: true,
      definition:
        "CREATE UNIQUE INDEX unique_line ON public.invoices USING btree (firm_id)",
    },
  ],
  migrations: [{ version: 54, name: "import_runs" }],
};

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "catalog-capture-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    format: 1,
    source: { revision: "a".repeat(40) },
    ci: { runId: "123", repository: "fixture/repository" },
    contractVersion: "fixture-contract",
    database: catalog,
    assets: [{ file: "fixture", sha256: "b".repeat(64) }],
  };
  const manifestFile = path.join(root, "manifest.json");
  const manifestBytes = JSON.stringify(manifest);
  writeFileSync(manifestFile, manifestBytes);
  const env = {
    RELEASE_MANIFEST: manifestFile,
    RELEASE_MANIFEST_SHA256: digest(manifestBytes),
    RELEASE_BASE_URL: "https://production.invalid",
  };
  const input = path.join(root, "raw.json");
  const output = path.join(root, "capture.json");
  const writeInput = (value) => writeFileSync(input, JSON.stringify(value));
  writeInput(catalog);
  return { root, env, input, output, writeInput };
}

test("creates canonical private checksum-bound capture without overwrite", (t) => {
  const f = fixture(t);
  const now = Date.parse("2026-09-10T12:34:56.000Z");
  const result = captureSecurityCatalog(
    ["--input", f.input, "--output", f.output],
    f.env,
    { now },
  );
  const bytes = readFileSync(f.output);
  assert.equal(result.sha256, digest(bytes));
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(bytes), {
    format: 1,
    kind: "security-catalog-capture",
    capturedAt: "2026-09-10T12:34:56.000Z",
    manifestSha256: f.env.RELEASE_MANIFEST_SHA256,
    targetOrigin: f.env.RELEASE_BASE_URL,
    catalog,
  });
  assert.match(bytes.toString(), /\n  "format": 1,/);
  assert.ok(bytes.toString().endsWith("\n"));
  assert.throws(
    () =>
      captureSecurityCatalog(
        ["--input", f.input, "--output", f.output],
        f.env,
        { now },
      ),
    /EEXIST/,
  );
});

test("refuses malformed, partial, unknown, unsafe, and symlink input", (t) => {
  const f = fixture(t);
  const run = () =>
    captureSecurityCatalog(["--input", f.input, "--output", f.output], f.env);
  writeFileSync(f.input, "{");
  assert.throws(run, /valid UTF-8 JSON/);

  const partial = structuredClone(catalog);
  delete partial.policies;
  f.writeInput(partial);
  assert.throws(run, /missing or unknown fields/);

  f.writeInput({ ...catalog, unexpected: [] });
  assert.throws(run, /missing or unknown fields/);

  for (const [section, field] of [
    ["columns", "ordinal_position"],
    ["constraints", "name"],
    ["indexes", "name"],
  ]) {
    const nestedPartial = structuredClone(catalog);
    delete nestedPartial[section][0][field];
    f.writeInput(nestedPartial);
    assert.throws(run, /missing or unknown fields/);
  }

  const nestedUnknown = structuredClone(catalog);
  nestedUnknown.tables[0].unexpected = true;
  f.writeInput(nestedUnknown);
  assert.throws(run, /missing or unknown fields/);

  const unsafe = structuredClone(catalog);
  unsafe.role.rolsuper = true;
  f.writeInput(unsafe);
  assert.throws(run, /unsafe role privilege/);

  const real = path.join(f.root, "real.json");
  writeFileSync(real, JSON.stringify(catalog));
  rmSync(f.input);
  symlinkSync(real, f.input);
  assert.throws(run, /non-symlink/);
});

test("refuses oversized raw input", (t) => {
  const f = fixture(t);
  chmodSync(f.input, 0o600);
  writeFileSync(f.input, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  assert.throws(
    () =>
      captureSecurityCatalog(["--input", f.input, "--output", f.output], f.env),
    /size invalid/,
  );
});
