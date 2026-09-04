import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseOptions, assertRecoveryEvidence, release } from "./release.mjs";
import { compareSecurityCatalog } from "./security-catalog.mjs";
import { digest, loadManifest, stampManifest } from "./build-manifest.mjs";
import { verifyDeployment } from "./postdeploy.mjs";

const revision = "a".repeat(40);
const env = {
  DATABASE_URL: "postgres://localhost/disposable",
  RELEASE_MANIFEST: "manifest.json",
  RELEASE_MANIFEST_SHA256: "b".repeat(64),
  RELEASE_ROLLBACK_REVISION: revision,
};
const catalog = {
  postgresMajor: 16,
  role: {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolcanlogin: false,
    schema_create: false,
    rolinherit: true,
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
  columns: [{ table_name: "invoices", column_name: "firm_id" }],
  policies: [
    {
      tablename: "invoices",
      policyname: "tenant",
      qual: "firm_id = current_setting('app.firm_id')::uuid",
      with_check: "firm_id = current_setting('app.firm_id')::uuid",
    },
  ],
  triggers: [
    {
      table_name: "invoices",
      name: "immutability",
      enabled: "O",
      definition: "BEFORE UPDATE",
    },
  ],
  functions: [
    { name: "meridian_block_mutations", definition: "RAISE EXCEPTION" },
  ],
  constraints: [
    {
      name: "revision_positive",
      validated: true,
      definition: "CHECK (content_revision > 0)",
    },
  ],
  indexes: [
    { name: "invoice_unique", valid: true, ready: true, definition: "UNIQUE" },
  ],
  migrations: [{ version: 50, name: "invoice_revisions" }],
};
const evidence = () =>
  ["backup", "restore_drill"].map((key) => ({
    key,
    last_succeeded_at: new Date().toISOString(),
    last_error: null,
    metadata: { sha256: "a".repeat(64) },
  }));
const manifest = {
  format: 1,
  source: { revision },
  ci: { runId: "1", repository: "fixture/repository" },
  contractVersion: "test",
  assets: [
    { file: "index.html", url: "/index.html", sha256: digest("built page") },
  ],
  database: catalog,
};

test("online release never enables push, and unsafe bootstrap/force/missing confirmation refuse", () => {
  assert.deepEqual(releaseOptions(["--yes"], env), { offline: false });
  assert.throws(() => releaseOptions([], env), /--yes/);
  assert.throws(
    () => releaseOptions(["--yes", "--offline-bootstrap"], env),
    /TRAFFIC_DRAINED/,
  );
  assert.throws(
    () => releaseOptions(["--yes"], { ...env, RELEASE_PUSH_FORCE: "1" }),
    /retired/,
  );
  assert.deepEqual(
    releaseOptions(["--yes", "--offline-bootstrap"], {
      ...env,
      RELEASE_TRAFFIC_DRAINED: "1",
    }),
    { offline: true },
  );
});

test("backup and restore evidence fail closed for absence, failure, old and future timestamps", () => {
  assertRecoveryEvidence(evidence());
  assert.throws(() => assertRecoveryEvidence([]), /backup/);
  for (const value of ["invalid", "2000-01-01", "2999-01-01"]) {
    const rows = evidence();
    rows[0].last_succeeded_at = value;
    assert.throws(() => assertRecoveryEvidence(rows), /backup/);
  }
  const rows = evidence();
  rows[1].last_error = "restore failed";
  assert.throws(() => assertRecoveryEvidence(rows), /restore_drill/);
});

test("semantic verification rejects weakened policies, role escalation, disabled triggers and constraint drift even with identical ledger", () => {
  compareSecurityCatalog(catalog, structuredClone(catalog));
  for (const mutate of [
    (c) => {
      c.policies[0].with_check = "true";
    },
    (c) => {
      c.policies[0].qual = "firm_id IS NOT NULL";
    },
    (c) => {
      c.role.rolbypassrls = true;
    },
    (c) => {
      c.memberships.push("postgres");
    },
    (c) => {
      c.tables[0].forced = false;
    },
    (c) => {
      c.tables[0].grants.push("TRUNCATE");
    },
    (c) => {
      c.triggers[0].enabled = "D";
    },
    (c) => {
      c.functions[0].definition = "RETURN NEW";
    },
    (c) => {
      c.constraints[0].definition = "CHECK (true)";
    },
    (c) => {
      c.indexes[0].valid = false;
    },
    (c) => {
      c.columns[0].column_name = "other_id";
    },
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed);
    assert.deepEqual(changed.migrations, catalog.migrations);
    assert.throws(() => compareSecurityCatalog(catalog, changed));
  }
});

test("catalog parity ignores physical order and generated names, not constraint or index meaning", () => {
  const original = structuredClone(catalog);
  original.tables[0].columns = ["id", "firm_id"];
  original.columns[0].ordinal_position = 2;
  original.indexes[0].definition =
    "CREATE UNIQUE INDEX generated_name ON public.invoices USING btree (firm_id, id)";
  const upgraded = structuredClone(original);
  upgraded.tables[0].columns.reverse();
  upgraded.columns[0].ordinal_position = 18;
  upgraded.constraints[0].name = "different_check_name";
  upgraded.indexes[0].name = "different index name";
  upgraded.indexes[0].definition =
    'CREATE UNIQUE INDEX "different index name" ON public.invoices USING btree (firm_id, id)';
  compareSecurityCatalog(original, upgraded);
  for (const definition of [
    "CREATE INDEX changed ON public.invoices USING btree (firm_id, id)",
    "CREATE UNIQUE INDEX changed ON public.invoices USING btree (id, firm_id)",
    "CREATE UNIQUE INDEX changed ON public.invoices USING btree (firm_id, id) WHERE firm_id IS NOT NULL",
  ]) {
    const changed = structuredClone(upgraded);
    changed.indexes[0].definition = definition;
    assert.throws(() => compareSecurityCatalog(original, changed), /indexes/);
  }
  const changed = structuredClone(upgraded);
  changed.constraints[0].definition = "CHECK (content_revision >= 0)";
  assert.throws(() => compareSecurityCatalog(original, changed), /constraints/);
  changed.constraints = [...upgraded.constraints, ...upgraded.constraints];
  assert.throws(() => compareSecurityCatalog(original, changed), /constraints/);
});

test("CI stamping and manifest tampering refuse; online mode executes zero migration commands", () => {
  assert.throws(() => stampManifest({}), /CI-only/);
  const dir = mkdtempSync(path.join(tmpdir(), "meridian-release-test-"));
  try {
    const file = path.join(dir, "manifest.json");
    const bytes = JSON.stringify(manifest);
    writeFileSync(file, bytes);
    assert.throws(
      () => loadManifest(file, "0".repeat(64)),
      /checksum mismatch/,
    );
    const options = {
      ...env,
      RELEASE_MANIFEST: file,
      RELEASE_MANIFEST_SHA256: digest(bytes),
    };
    let commands = 0;
    const deps = {
      verifyArtifact() {},
      query: () => JSON.stringify(evidence()),
      catalog: () => structuredClone(catalog),
      execute: () => {
        commands++;
        return { status: 1 };
      },
    };
    release(["--yes"], options, deps);
    assert.equal(commands, 0);
    assert.throws(
      () =>
        release(
          ["--yes", "--offline-bootstrap"],
          { ...options, RELEASE_TRAFFIC_DRAINED: "1" },
          deps,
        ),
      /keep ALL traffic stopped/,
    );
    assert.equal(
      commands,
      1,
      "failure stops before migrate or traffic restoration",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postdeploy compares exact source and bytes, checks readiness, and rejects stale builds", async () => {
  const fetcher =
    (changes = {}) =>
    async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      if (url.pathname === "/api/healthz")
        return Response.json({
          status: "ok",
          buildRevision: revision,
          contractVersion: "test",
          ...changes,
        });
      if (url.pathname === "/api/readyz")
        return Response.json({ status: "ready" });
      return new Response("built page");
    };
  await verifyDeployment("https://fixture.invalid", manifest, fetcher());
  await assert.rejects(
    verifyDeployment(
      "https://fixture.invalid",
      manifest,
      fetcher({ buildRevision: revision.slice(0, 7) }),
    ),
    /source mismatch/,
  );
  await assert.rejects(
    verifyDeployment(
      "https://fixture.invalid",
      manifest,
      fetcher({ contractVersion: "old" }),
    ),
    /contract mismatch/,
  );
  const stale = structuredClone(manifest);
  stale.assets[0].sha256 = digest("stale page");
  await assert.rejects(
    verifyDeployment("https://fixture.invalid", stale, fetcher()),
    /asset mismatch/,
  );
  await assert.rejects(
    verifyDeployment("http://remote.invalid", manifest, fetcher()),
    /HTTPS/,
  );
});
