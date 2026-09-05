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
const rollbackRevision = "c".repeat(40);
const env = {
  DATABASE_URL: "postgres://localhost/disposable",
  RELEASE_MANIFEST: "manifest.json",
  RELEASE_MANIFEST_SHA256: "b".repeat(64),
  RELEASE_ROLLBACK_REVISION: rollbackRevision,
  RELEASE_ROLLBACK_APPROVAL: "rollback-approval.json",
  RELEASE_ROLLBACK_APPROVAL_SHA256: "d".repeat(64),
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
const evidence = (backupCompletedAt = new Date().toISOString()) => {
  const createdAt = new Date(
    Date.parse(backupCompletedAt) - 60_000,
  ).toISOString();
  return [
    {
      key: "backup",
      last_succeeded_at: backupCompletedAt,
      last_error: null,
      metadata: {
        evidenceVersion: 2,
        sha256: "a".repeat(64),
        snapshotSha256: "b".repeat(64),
        manifestSha256: "c".repeat(64),
        createdAt,
      },
    },
    {
      key: "restore_drill",
      last_succeeded_at: new Date().toISOString(),
      last_error: null,
      metadata: {
        evidenceVersion: 2,
        backupSha256: "a".repeat(64),
        snapshotSha256: "b".repeat(64),
        backupManifestSha256: "c".repeat(64),
        backupCreatedAt: createdAt,
        securityCatalogVerified: true,
        allTableCountsVerified: true,
      },
    },
  ];
};
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

test("recovery evidence requires the exact retained archive and complete restored security", () => {
  for (const index of [0, 1]) {
    const rows = evidence();
    rows[index].metadata.evidenceVersion = 1;
    assert.throws(
      () => assertRecoveryEvidence(rows),
      /evidence format is unverified/,
    );
  }
  for (const mutate of [
    (rows) => {
      delete rows[0].metadata.evidenceVersion;
    },
    (rows) => {
      rows[0].metadata.sha256 = "invalid";
    },
    (rows) => {
      rows[1].metadata.backupSha256 = "f".repeat(64);
    },
    (rows) => {
      rows[1].metadata.snapshotSha256 = "f".repeat(64);
    },
    (rows) => {
      rows[1].metadata.backupManifestSha256 = "f".repeat(64);
    },
    (rows) => {
      rows[1].metadata.securityCatalogVerified = false;
    },
    (rows) => {
      rows[1].metadata.allTableCountsVerified = false;
    },
    (rows) => {
      rows[0].metadata.createdAt = "2000-01-01T00:00:00Z";
    },
    (rows) => {
      rows[1].metadata.backupCreatedAt = "2000-01-01T00:00:00Z";
    },
    (rows) => {
      rows[1].last_succeeded_at = new Date(
        Date.parse(rows[0].last_succeeded_at) - 1000,
      ).toISOString();
    },
  ]) {
    const rows = evidence();
    mutate(rows);
    assert.throws(() => assertRecoveryEvidence(rows));
  }
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
    const rollbackApproval = {
      format: 1,
      mode: "rollback",
      revision,
      rollbackRevision,
      approved: true,
      approvedBy: "fixture-approver",
      approvedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      qualificationEvidence: "Synthetic staging qualification evidence",
    };
    const rollbackApprovalBytes = JSON.stringify(rollbackApproval);
    const rollbackApprovalFile = path.join(dir, "rollback-approval.json");
    writeFileSync(rollbackApprovalFile, rollbackApprovalBytes);
    options.RELEASE_ROLLBACK_APPROVAL = rollbackApprovalFile;
    options.RELEASE_ROLLBACK_APPROVAL_SHA256 = digest(rollbackApprovalBytes);
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

test("maintenance release binds the approved plan to the candidate and backup without executing migrations", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "meridian-maintenance-test-"));
  try {
    const at = (minutes) =>
      new Date(Date.now() + minutes * 60_000).toISOString();
    const stopped = (name) => ({
      state: "stopped",
      targets: [`fixture/${name}`],
      evidence: "Synthetic stopped-writer observation",
    });
    const plan = {
      format: 1,
      mode: "maintenance-forward",
      revision,
      approved: true,
      approvedBy: "synthetic-approver",
      approvedAt: at(-1),
      window: { start: at(-20), end: at(60) },
      drain: {
        confirmedBy: "synthetic-operator",
        confirmedAt: at(-15),
        api: stopped("api"),
        workers: stopped("workers"),
        schedules: stopped("schedules"),
        otherWriters: {
          state: "absent",
          targets: [],
          evidence: "Synthetic inventory only",
        },
      },
      backup: {
        sha256: "a".repeat(64),
        preChange: true,
        completedAt: at(-10),
        evidence: "Synthetic archive only",
      },
      forwardFix: {
        approved: true,
        owner: "synthetic-recovery-owner",
        procedure: "Review and verify an offline forward fix",
        writersRemainStopped: true,
        automaticResume: false,
        resumeCriteria: {
          artifactIdentity: "Exact approved artifact",
          migrationIntegrity: "Retained migration safeguards",
          securityCatalog: "Full catalog parity",
          applicationChecks: "Isolated recovery journeys",
          operatorSignoff: "Explicit final operator approval",
        },
      },
    };
    const manifestFile = path.join(dir, "manifest.json");
    const manifestBytes = JSON.stringify(manifest);
    writeFileSync(manifestFile, manifestBytes);
    const planFile = path.join(dir, "synthetic-plan.json");
    const optionsFor = (value) => {
      const bytes = JSON.stringify(value);
      writeFileSync(planFile, bytes);
      return {
        ...env,
        RELEASE_ROLLBACK_REVISION: undefined,
        RELEASE_MANIFEST: manifestFile,
        RELEASE_MANIFEST_SHA256: digest(manifestBytes),
        RELEASE_RECOVERY_MODE: "maintenance-forward",
        RELEASE_TRAFFIC_DRAINED: "1",
        RELEASE_RECOVERY_PLAN: planFile,
        RELEASE_RECOVERY_PLAN_SHA256: digest(bytes),
      };
    };
    let catalogReads = 0;
    const deps = {
      verifyArtifact() {},
      query: () => JSON.stringify(evidence(plan.backup.completedAt)),
      catalog: () => {
        catalogReads++;
        return structuredClone(catalog);
      },
      execute: () =>
        assert.fail(
          "maintenance preflight must not run migrations or resume traffic",
        ),
    };
    release(["--yes"], optionsFor(plan), deps);
    assert.equal(catalogReads, 1);
    assert.throws(
      () => release(["--yes", "--offline-bootstrap"], optionsFor(plan), deps),
      /never enables schema push/,
    );
    for (const mutate of [
      (copy) => {
        copy.revision = "f".repeat(40);
      },
      (copy) => {
        copy.backup.sha256 = "f".repeat(64);
      },
      (copy) => {
        copy.approved = false;
      },
      (copy) => {
        copy.window.end = at(-2);
      },
      (copy) => {
        copy.forwardFix.automaticResume = true;
      },
      (copy) => {
        copy.backup.completedAt = at(-9);
      },
    ]) {
      const copy = structuredClone(plan);
      mutate(copy);
      catalogReads = 0;
      assert.throws(() => release(["--yes"], optionsFor(copy), deps));
      assert.equal(catalogReads, 0, "an invalid recovery plan stops preflight");
    }
    const validOptions = optionsFor(plan);
    const preDrainRows = evidence(plan.backup.completedAt);
    const preDrainSnapshot = at(-16);
    preDrainRows[0].metadata.createdAt = preDrainSnapshot;
    preDrainRows[1].metadata.backupCreatedAt = preDrainSnapshot;
    catalogReads = 0;
    assert.throws(
      () =>
        release(["--yes"], validOptions, {
          ...deps,
          query: () => JSON.stringify(preDrainRows),
        }),
      /snapshot predates the confirmed writer drain/,
    );
    assert.equal(
      catalogReads,
      0,
      "pre-drain snapshots stop preflight even when backup completes after drain",
    );
    assert.throws(
      () =>
        release(
          ["--yes"],
          { ...validOptions, RELEASE_RECOVERY_PLAN_SHA256: "0".repeat(64) },
          deps,
        ),
      /checksum mismatch/,
    );
    assert.throws(
      () =>
        release(
          ["--yes"],
          { ...validOptions, RELEASE_TRAFFIC_DRAINED: "0" },
          deps,
        ),
      /TRAFFIC_DRAINED/,
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
