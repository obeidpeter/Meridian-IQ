import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ROOT,
  APPS,
  assetInventory,
  digest,
  sourceIdentity,
  verifyLocalArtifact,
} from "./build-manifest.mjs";
import {
  promoteReplit,
  REPLIT_APPS,
  releaseEnvForCli,
  startReplitApi,
} from "./replit-promote.mjs";
import {
  validateMobileArtifact,
  verifyMobileServing,
} from "./mobile-artifact.mjs";
import { startStaticServer } from "../e2e/serve.mjs";

const targetReplId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const providerReplId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rollbackRevision = "a".repeat(40);

test("explicit HOLD CLI mode overrides inherited RUN release values", () => {
  const inherited = {
    RELEASE_RUNTIME_STATE: "RUN",
    RELEASE_RECOVERY_MODE: "maintenance-forward",
    RELEASE_ROLLBACK_REVISION: "b".repeat(40),
  };
  const env = releaseEnvForCli(["--hold", rollbackRevision], inherited);
  assert.equal(env.RELEASE_RUNTIME_STATE, "HOLD");
  assert.equal(env.RELEASE_RECOVERY_MODE, "rollback");
  assert.equal(env.RELEASE_ROLLBACK_REVISION, rollbackRevision);
  assert.equal(inherited.RELEASE_RUNTIME_STATE, "RUN");
});

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
  functions: [{ name: "guard", definition: "RAISE EXCEPTION" }],
  constraints: [
    {
      name: "positive",
      validated: true,
      definition: "CHECK (content_revision > 0)",
    },
  ],
  indexes: [
    {
      name: "unique_line",
      valid: true,
      ready: true,
      definition:
        "CREATE UNIQUE INDEX unique_line ON public.invoices USING btree (firm_id)",
    },
  ],
  migrations: [{ version: 54, name: "import_runs" }],
};

function fixture(t) {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "meridian-replit-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith("meridian-replit-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const write = (file, value) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  write("source.txt", "reviewed source\n");
  write("lib/db/src/schema/fixture.ts", "// reviewed schema\n");
  write(".gitignore", "dist/\n");
  const mobileConfig = {
    format: 1,
    domain: "fixture.invalid",
    basePath: "/mobile/",
    replId: targetReplId,
  };
  const eas = {
    build: {
      production: {
        env: {
          EXPO_PUBLIC_DOMAIN: mobileConfig.domain,
          EXPO_PUBLIC_REPL_ID: mobileConfig.replId,
        },
      },
    },
  };
  write("artifacts/mobile/eas.json", JSON.stringify(eas));
  for (const name of [
    "replit-promote",
    "build-manifest",
    "release",
    "security-catalog",
    "common",
    "mobile-artifact",
    "recovery-plan",
    "activation-permit",
    "postdeploy",
    "maintenance-server",
  ]) {
    const file = `scripts/src/ops/${name}.mjs`;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  // Commits exist only in the disposable fixture, never in the shared worktree.
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  for (const [app] of APPS)
    write(`artifacts/${app}/dist/public/index.html`, `<main>${app}</main>`);
  write(
    "artifacts/api-server/dist/index.mjs",
    `console.log(JSON.stringify({ executed: true, revision: process.env.BUILD_REVISION, expected: process.env.EXPECTED_BUILD_REVISION, providerReplId: process.env.REPL_ID }));\n`,
  );
  write("artifacts/api-server/dist/data/font.afm", "fixture font bytes");
  write("artifacts/mobile/dist/deployment.json", JSON.stringify(mobileConfig));
  write("artifacts/mobile/dist/eas.json", JSON.stringify(eas));
  write(
    "artifacts/mobile/dist/app.json",
    JSON.stringify({ expo: { name: "Fixture mobile" } }),
  );
  write(
    "artifacts/mobile/dist/server/templates/landing-page.html",
    "<h1>APP_NAME_PLACEHOLDER</h1>",
  );
  write(
    "artifacts/mobile/dist/server/serve.cjs",
    "console.log(JSON.stringify({ executed: true, revision: process.env.BUILD_REVISION, basePath: process.env.BASE_PATH }));",
  );
  for (const platform of ["ios", "android"]) {
    write(
      `artifacts/mobile/dist/static-build/${platform}/bundle.js`,
      `fixture ${platform} bundle`,
    );
    write(
      `artifacts/mobile/dist/static-build/${platform}/manifest.json`,
      JSON.stringify({
        launchAsset: {
          url: `https://fixture.invalid/mobile/${platform}/bundle.js`,
        },
        assets: [],
      }),
    );
  }
  const manifest = {
    format: 1,
    source: sourceIdentity(root),
    contractVersion: "fixture-contract",
    ci: { repository: "fixture/repository", runId: "123", attempt: "1" },
    assets: assetInventory(root),
    mobile: mobileConfig,
    database: catalog,
  };
  const env = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/disposable",
    RELEASE_ROLLBACK_REVISION: "a".repeat(40),
    RELEASE_BASE_URL: "https://fixture.invalid",
    RELEASE_TARGET_REPL_ID: targetReplId,
    REPL_ID: providerReplId,
    RELEASE_RECOVERY_PLAN_SHA256: "c".repeat(64),
    RELEASE_BACKUP_SHA256: "b".repeat(64),
  };
  const stamp = (value = manifest) => {
    const bytes = JSON.stringify(value);
    write("release/build-manifest.json", bytes);
    env.RELEASE_MANIFEST_SHA256 = digest(bytes);
  };
  stamp();
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      ["scripts/src/ops/replit-promote.mjs", ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 15_000,
      },
    );
  const authorize = (offset = 0) => {
    const at = (minutes) =>
      new Date(Date.now() + offset + minutes * 60_000).toISOString();
    const stopped = (name) => ({
      state: "stopped",
      targets: [`fixture/${name}`],
      evidence: "Synthetic stopped-writer observation",
    });
    const plan = {
      format: 1,
      mode: "maintenance-forward",
      revision: manifest.source.revision,
      approved: true,
      approvedBy: "synthetic-approver",
      approvedAt: at(-10),
      window: { start: at(-30), end: at(60) },
      drain: {
        confirmedBy: "synthetic-operator",
        confirmedAt: at(-20),
        api: stopped("api"),
        workers: stopped("workers"),
        schedules: stopped("schedules"),
        otherWriters: {
          state: "absent",
          targets: [],
          evidence: "Synthetic inventory",
        },
      },
      backup: {
        sha256: "b".repeat(64),
        preChange: true,
        completedAt: at(-15),
        evidence: "Synthetic archive",
      },
      forwardFix: {
        approved: true,
        owner: "synthetic-owner",
        procedure: "Review an offline forward fix",
        writersRemainStopped: true,
        automaticResume: false,
        resumeCriteria: {
          artifactIdentity: "Exact artifact",
          migrationIntegrity: "Retained migrations",
          securityCatalog: "Catalog parity",
          applicationChecks: "Recovery checks",
          operatorSignoff: "Explicit approval",
        },
      },
    };
    const record = (name, variable, value) => {
      const bytes = JSON.stringify(value);
      const file = `release/${name}.json`;
      write(file, bytes);
      env[variable] = path.join(root, file);
      env[`${variable}_SHA256`] = digest(bytes);
    };
    record("recovery-plan", "RELEASE_RECOVERY_PLAN", plan);
    env.RELEASE_RECOVERY_MODE = "maintenance-forward";
    env.RELEASE_TRAFFIC_DRAINED = "1";
    env.RELEASE_RUNTIME_STATE = "RUN";
    const held = {
      format: 1,
      kind: "held-verification",
      revision: manifest.source.revision,
      manifestSha256: env.RELEASE_MANIFEST_SHA256,
      target: {
        origin: env.RELEASE_BASE_URL,
        replId: env.RELEASE_TARGET_REPL_ID,
      },
      recoveryPlanSha256: env.RELEASE_RECOVERY_PLAN_SHA256,
      backupSha256: env.RELEASE_BACKUP_SHA256,
      verifiedAt: at(-5),
      apiReadinessVerified: false,
      checks: {
        maintenanceHealth: true,
        businessRejected: true,
        readinessRejected: true,
        immutableAssets: true,
        securityCatalog: true,
        ciProvenance: true,
      },
    };
    record("held-evidence", "RELEASE_HELD_EVIDENCE", held);
    env.RELEASE_ACTIVATION_ID = "22222222-2222-4222-8222-222222222222";
    const permit = {
      format: 1,
      mode: "maintenance-forward",
      activationId: env.RELEASE_ACTIVATION_ID,
      revision: manifest.source.revision,
      manifestSha256: env.RELEASE_MANIFEST_SHA256,
      target: held.target,
      recoveryPlanSha256: env.RELEASE_RECOVERY_PLAN_SHA256,
      backupSha256: env.RELEASE_BACKUP_SHA256,
      heldEvidenceSha256: env.RELEASE_HELD_EVIDENCE_SHA256,
      approved: true,
      approvedBy: "synthetic-approver",
      approvedAt: at(-1),
      expiresAt: at(10),
      authorizeStartupWrites: true,
      externalIngressAndSchedulesRemainHeld: true,
      requirePostRunReadiness: true,
    };
    record("activation-permit", "RELEASE_ACTIVATION_PERMIT", permit);
    return { plan, held, permit, record };
  };
  return { root, write, git, manifest, env, stamp, cli, authorize };
}

function recovery(completedAt = new Date(Date.now() - 1000).toISOString()) {
  const createdAt = new Date(Date.parse(completedAt) - 60_000).toISOString();
  return JSON.stringify([
    {
      key: "backup",
      last_succeeded_at: completedAt,
      last_error: null,
      metadata: {
        evidenceVersion: 2,
        sha256: "b".repeat(64),
        snapshotSha256: "c".repeat(64),
        manifestSha256: "d".repeat(64),
        createdAt,
      },
    },
    {
      key: "restore_drill",
      last_succeeded_at: new Date().toISOString(),
      last_error: null,
      metadata: {
        evidenceVersion: 2,
        backupSha256: "b".repeat(64),
        snapshotSha256: "c".repeat(64),
        backupManifestSha256: "d".repeat(64),
        backupCreatedAt: createdAt,
        securityCatalogVerified: true,
        allTableCountsVerified: true,
      },
    },
  ]);
}

test("all seven native builds promote the identical staged bytes; API retains read-only release checks", (t) => {
  const f = fixture(t);
  let queries = 0;
  let catalogs = 0;
  const dependencies = {
    query: () => {
      queries++;
      return recovery();
    },
    catalog: () => {
      catalogs++;
      return structuredClone(catalog);
    },
    execute: () =>
      assert.fail("promotion must not rebuild, install, download or migrate"),
  };
  for (const app of REPLIT_APPS)
    assert.deepEqual(
      promoteReplit(app, f.env, f.root, dependencies),
      f.manifest,
    );
  assert.equal(queries, 1);
  assert.equal(catalogs, 1);
  assert.deepEqual(assetInventory(f.root), f.manifest.assets);
  const result = f.cli("build", "landing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all seven CI artifacts/);
});

test("missing manifest, trusted checksum and CI provenance refuse", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      promoteReplit(
        "landing",
        { ...f.env, RELEASE_MANIFEST_SHA256: undefined },
        f.root,
      ),
    /trusted CI/,
  );
  assert.throws(
    () =>
      promoteReplit(
        "landing",
        { ...f.env, RELEASE_MANIFEST_SHA256: "0".repeat(64) },
        f.root,
      ),
    /checksum mismatch/,
  );
  const withoutProvenance = structuredClone(f.manifest);
  delete withoutProvenance.ci;
  f.stamp(withoutProvenance);
  assert.throws(() => promoteReplit("landing", f.env, f.root), /CI provenance/);
  f.stamp();
  f.write(
    "release/build-manifest.json",
    JSON.stringify({ ...f.manifest, contractVersion: "tampered" }),
  );
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /checksum mismatch/,
  );
  rmSync(path.join(f.root, "release/build-manifest.json"));
  assert.throws(() => promoteReplit("landing", f.env, f.root), /ENOENT/);
});

test("unknown app and wrong-app inventory cannot be promoted", (t) => {
  const f = fixture(t);
  assert.throws(
    () => promoteReplit("not-an-app", f.env, f.root),
    /unsupported promotion app/,
  );
  assert.throws(
    () => promoteReplit("../api-server", f.env, f.root),
    /unsupported promotion app/,
  );
  const wrong = structuredClone(f.manifest);
  wrong.assets.find((a) => a.file.includes("landing/")).url =
    "/buyer/index.html";
  f.stamp(wrong);
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /built assets differ/,
  );
  f.stamp({
    ...f.manifest,
    assets: f.manifest.assets.filter((a) => !a.file.includes("buyer-portal/")),
  });
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /built assets differ/,
  );
});

test("dirty/untracked source, staged edits, wrong source hash and wrong schema hash refuse", (t) => {
  const f = fixture(t);
  f.write("untracked.mjs", "throw new Error('unreviewed source')");
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /unexpected untracked Publish source/,
  );
  rmSync(path.join(f.root, "untracked.mjs"));
  f.write("source.txt", "unreviewed source\n");
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /source must be clean/,
  );
  f.git("add", "source.txt");
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /source must be clean/,
  );
  f.write("source.txt", "reviewed source\n");
  f.git("add", "source.txt");
  for (const field of ["tree", "sha256", "schemaSha256"]) {
    const wrong = structuredClone(f.manifest);
    wrong.source[field] = "0".repeat(wrong.source[field].length);
    f.stamp(wrong);
    assert.throws(
      () => promoteReplit("landing", f.env, f.root),
      /source or schema differs/,
    );
  }
  f.stamp();
  f.git("update-index", "--assume-unchanged", "source.txt");
  f.write("source.txt", "hidden dirty content\n");
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /source or schema differs/,
  );
});

test("tampering any of the seven apps blocks build and runtime before API evaluation", async (t) => {
  const f = fixture(t);
  for (const asset of f.manifest.assets) {
    const original = readFileSync(path.join(f.root, asset.file));
    f.write(asset.file, "tampered\n");
    assert.throws(
      () => promoteReplit("landing", f.env, f.root),
      /built assets differ/,
    );
    await assert.rejects(
      startReplitApi(f.env, f.root),
      /packaged assets differ/,
    );
    f.write(asset.file, original);
  }
  f.write("artifacts/console/dist/public/extra.js", "unreviewed extra file");
  await assert.rejects(startReplitApi(f.env, f.root), /packaged assets differ/);
});

test("missing sibling build and symlinked dist roots refuse", (t) => {
  const f = fixture(t);
  const directory = path.join(f.root, "artifacts/console/dist");
  const relocated = path.join(f.root, "dist");
  renameSync(directory, relocated);
  assert.throws(() => promoteReplit("landing", f.env, f.root), /ENOENT/);
  symlinkSync(
    relocated,
    directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => assetInventory(f.root),
    /artifact directory must be real/,
  );
  // Git reports Linux directory symlinks as untracked files; Windows junctions
  // reach the inventory guard instead. Both must refuse before promotion.
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /artifact directory must be real|unexpected untracked Publish source/,
  );
});

test("API startup needs no Git and sets exact CI revision before importing unchanged dist", (t) => {
  const f = fixture(t);
  f.authorize();
  rmSync(path.join(f.root, ".git"), { recursive: true });
  const build = f.cli("build", "api-server");
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /matching Git checkout/);
  f.env.PATH = "";
  f.env.BUILD_REVISION = "old-revision";
  f.env.EXPECTED_BUILD_REVISION = "old-expected";
  f.env.REPLIT_DEPLOYMENT_ID = "deployment-uuid-not-a-source-sha";
  const started = f.cli("start", "api-server");
  assert.equal(started.status, 0, started.stderr);
  const output = JSON.parse(started.stdout.trim().split("\n").at(-1));
  assert.deepEqual(output, {
    executed: true,
    revision: f.manifest.source.revision,
    expected: f.manifest.source.revision,
    providerReplId: f.env.REPL_ID,
  });
  assert.deepEqual(assetInventory(f.root), f.manifest.assets);
});

test("runtime fails closed before executing API on missing checksum, missing manifest or tampering", (t) => {
  const f = fixture(t);
  const rejected = () => {
    const result = f.cli("start", "api-server");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSED/);
    assert.doesNotMatch(result.stdout, /executed/);
  };
  f.env.RELEASE_MANIFEST_SHA256 = "";
  rejected();
  f.stamp();
  f.write("artifacts/landing/dist/public/index.html", "changed after build");
  rejected();
  rmSync(path.join(f.root, "release/build-manifest.json"));
  rejected();
});

test("native API promotion cannot bypass missing recovery, drift or rollback configuration", (t) => {
  const f = fixture(t);
  const dependencies = {
    query: () => recovery(),
    catalog: () => structuredClone(catalog),
    execute: () => assert.fail("native Publish is read-only"),
  };
  assert.throws(
    () =>
      promoteReplit(
        "api-server",
        { ...f.env, DATABASE_URL: "" },
        f.root,
        dependencies,
      ),
    /DATABASE_URL/,
  );
  assert.throws(
    () =>
      promoteReplit(
        "api-server",
        { ...f.env, RELEASE_ROLLBACK_REVISION: "" },
        f.root,
        dependencies,
      ),
    /RELEASE_ROLLBACK_REVISION/,
  );
  assert.throws(
    () =>
      promoteReplit("api-server", f.env, f.root, {
        ...dependencies,
        query: () => "[]",
      }),
    /backup evidence/,
  );
  const changed = structuredClone(catalog);
  changed.triggers[0].enabled = "D";
  assert.throws(
    () =>
      promoteReplit("api-server", f.env, f.root, {
        ...dependencies,
        catalog: () => changed,
      }),
    /trigger disabled/,
  );
});

test("seven production descriptors use verified promotion and preserve development/public paths", () => {
  for (const app of REPLIT_APPS) {
    const descriptor = readFileSync(
      path.join(ROOT, `artifacts/${app}/.replit-artifact/artifact.toml`),
      "utf8",
    );
    assert.ok(
      descriptor.includes(`run = "pnpm --filter @workspace/${app} run dev"`),
    );
    const production = descriptor.slice(
      descriptor.indexOf("[services.production]"),
    );
    assert.doesNotMatch(production, /"pnpm"/);
    if (app === "api-server") {
      assert.ok(
        production.includes(
          '["node", "scripts/src/ops/replit-promote.mjs", "build", "api-server", "--hold", "ea275be456a2c19babd06139de10cdbe322bc049"]',
        ),
      );
      assert.ok(
        production.includes(
          '["node", "--enable-source-maps", "scripts/src/ops/replit-promote.mjs", "start", "api-server", "--hold", "ea275be456a2c19babd06139de10cdbe322bc049"]',
        ),
      );
      assert.ok(production.includes('path = "/api/healthz"'));
    } else {
      assert.match(
        production,
        new RegExp(
          `\\[\\s*"node", "scripts/src/ops/replit-promote\\.mjs", "build", "${app}"\\s*\\]`,
        ),
      );
    }
    if (app !== "api-server" && app !== "mobile") {
      assert.ok(
        production.includes(`publicDir = "artifacts/${app}/dist/public"`),
      );
      assert.ok(production.includes('serve = "static"'));
    }
  }
});

test("native mobile promotes and starts immutable outputs without Git; Expo dev stays intact", (t) => {
  const f = fixture(t);
  const built = f.cli("build", "mobile");
  assert.equal(built.status, 0, built.stderr);
  rmSync(path.join(f.root, ".git"), { recursive: true });
  const result = f.cli("start", "mobile");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    executed: true,
    revision: f.manifest.source.revision,
    basePath: "/mobile/",
  });
  assert.deepEqual(assetInventory(f.root), f.manifest.assets);
  const descriptor = readFileSync(
    path.join(ROOT, "artifacts/mobile/.replit-artifact/artifact.toml"),
    "utf8",
  );
  assert.ok(descriptor.includes('router = "expo-domain"'));
  assert.ok(descriptor.includes('previewPath = "/mobile/"'));
  assert.ok(
    descriptor.includes('run = "pnpm --filter @workspace/mobile run dev"'),
  );
  const production = descriptor.slice(
    descriptor.indexOf("[services.production]"),
  );
  assert.doesNotMatch(production, /"pnpm"/);
  assert.ok(
    production.includes(
      'build = [ "node", "scripts/src/ops/replit-promote.mjs", "build", "mobile" ]',
    ),
  );
  assert.ok(
    production.includes(
      'run = [ "node", "scripts/src/ops/replit-promote.mjs", "start", "mobile" ]',
    ),
  );
});

test("mobile target configuration and packaged platform assets are enforced", async (t) => {
  const f = fixture(t);
  assert.deepEqual(validateMobileArtifact(f.root), f.manifest.mobile);
  f.write(
    "artifacts/mobile/dist/deployment.json",
    JSON.stringify({ ...f.manifest.mobile, domain: "wrong.invalid" }),
  );
  assert.throws(() => validateMobileArtifact(f.root), /EAS\/config mismatch/);
  f.write(
    "artifacts/mobile/dist/deployment.json",
    JSON.stringify(f.manifest.mobile),
  );
  f.write(
    "artifacts/mobile/dist/static-build/ios/manifest.json",
    JSON.stringify({
      launchAsset: { url: "https://elsewhere.invalid/bundle.js" },
    }),
  );
  assert.throws(() => validateMobileArtifact(f.root), /unpackaged ios asset/);
  f.env.BASE_PATH = "/wrong/";
  const result = f.cli("start", "mobile");
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /executed/);
});

test("packaged original mobile server serves exact native manifests and bundle bytes", async (t) => {
  const f = fixture(t);
  copyFileSync(
    path.join(ROOT, "artifacts/mobile/server/serve.js"),
    path.join(f.root, "artifacts/mobile/dist/server/serve.cjs"),
  );
  await verifyMobileServing(f.root);
});

test("E2E parity router serves mobile bytes without a landing SPA fallback", async (t) => {
  const f = fixture(t);
  const server = await startStaticServer({ port: 0, apiPort: 1, root: f.root });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/mobile/ios/bundle.js`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fixture ios bundle");
    const missing = await fetch(`${origin}/mobile/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Replit empty metadata commits preserve the CI deployed revision; strict release and changed trees still refuse", (t) => {
  const f = fixture(t);
  const commit = (message, empty = false) =>
    f.git(
      "-c",
      "user.name=Release Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      ...(empty ? ["--allow-empty"] : []),
      "-m",
      message,
    );
  commit("Published your App", true);
  const local = sourceIdentity(f.root);
  assert.notEqual(local.revision, f.manifest.source.revision);
  assert.equal(local.tree, f.manifest.source.tree);
  assert.throws(
    () => verifyLocalArtifact(f.manifest, f.root),
    /source or schema differs/,
  );
  const dependencies = {
    query: () => recovery(),
    catalog: () => structuredClone(catalog),
    execute: () =>
      assert.fail("metadata promotion must not execute migrations"),
  };
  for (const app of ["landing", "api-server"])
    assert.deepEqual(
      promoteReplit(app, f.env, f.root, dependencies),
      f.manifest,
    );
  f.authorize();
  const started = f.cli("start", "api-server");
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout.trim().split("\n").at(-1)), {
    executed: true,
    revision: f.manifest.source.revision,
    expected: f.manifest.source.revision,
    providerReplId: f.env.REPL_ID,
  });
  f.write("source.txt", "changed source content\n");
  f.git("add", "source.txt");
  commit("Not metadata only");
  assert.notEqual(sourceIdentity(f.root).tree, f.manifest.source.tree);
  assert.throws(
    () => promoteReplit("landing", f.env, f.root),
    /source or schema differs/,
  );
});

test("default HOLD serves health only without Git, DB clients, API evaluation or a resume route", async (t) => {
  const f = fixture(t);
  f.authorize(-7 * 86400_000);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  rmSync(path.join(f.root, ".git"), { recursive: true });
  const child = spawn(
    process.execPath,
    ["scripts/src/ops/replit-promote.mjs", "start", "api-server"],
    {
      cwd: f.root,
      windowsHide: true,
      env: {
        ...process.env,
        ...f.env,
        REPL_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        PORT: String(port),
        PATH: "",
        DATABASE_URL: "invalid-no-db-client",
        RELEASE_RUNTIME_STATE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        health = await fetch(`${base}/api/healthz`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(health, output);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, "maintenance");
    assert.equal(body.apiImported, false);
    assert.equal(body.mode, "hold");
    assert.equal(body.buildRevision, f.manifest.source.revision);
    assert.equal(body.manifestSha256, f.env.RELEASE_MANIFEST_SHA256);
    assert.deepEqual(body.target, {
      origin: f.env.RELEASE_BASE_URL,
      replId: f.env.RELEASE_TARGET_REPL_ID,
    });
    assert.equal(
      JSON.stringify(body).includes("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      false,
    );
    assert.match(health.headers.get("cache-control"), /no-store/);
    for (const route of [
      "/api/readyz",
      "/api/invoices",
      "/api/auth/login",
      "/resume",
      "/activate",
      "/api/healthz?resume=1",
      "/",
      "/index.html",
    ]) {
      for (const method of [
        "GET",
        "POST",
        "PATCH",
        "PUT",
        "DELETE",
        "OPTIONS",
        "HEAD",
      ]) {
        const response = await fetch(`${base}${route}`, { method });
        assert.equal(response.status, 503, `${method} ${route}`);
        if (method === "HEAD") assert.equal(await response.text(), "");
        else assert.deepEqual(await response.json(), body);
      }
    }
    assert.equal(
      (await fetch(`${base}/api/healthz`, { method: "POST" })).status,
      503,
    );
    assert.equal(
      (await fetch(`${base}/api/healthz`, { method: "HEAD" })).status,
      200,
    );
    assert.doesNotMatch(output, /"executed":true/);
    assert.deepEqual(assetInventory(f.root), f.manifest.assets);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});

test("HOLD and repeated RUN promotion/runtime retain one stable activation across provider IDs", (t) => {
  const f = fixture(t);
  const { plan } = f.authorize();
  let queries = 0;
  let catalogs = 0;
  const deps = {
    query: () => {
      queries++;
      return recovery(plan.backup.completedAt);
    },
    catalog: () => {
      catalogs++;
      return catalog;
    },
    execute: () =>
      assert.fail(
        "no migrations, build or writer startup in Publish verification",
      ),
  };
  f.env.RELEASE_RUNTIME_STATE = "HOLD";
  promoteReplit("api-server", Object.freeze({ ...f.env }), f.root, deps);
  f.env.RELEASE_RUNTIME_STATE = "RUN";
  const originalPermit = readFileSync(f.env.RELEASE_ACTIVATION_PERMIT);
  const originalHeld = readFileSync(f.env.RELEASE_HELD_EVIDENCE);
  for (const provider of ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", undefined]) {
    f.env.REPL_ID = provider;
    const env = Object.freeze({ ...f.env });
    promoteReplit("api-server", env, f.root, deps);
    assert.equal(env.REPL_ID, provider);
    const started = f.cli("start", "api-server");
    assert.equal(started.status, 0, started.stderr);
    const body = JSON.parse(started.stdout.trim().split("\n").at(-1));
    assert.equal(body.executed, true);
    assert.equal(
      body.providerReplId,
      provider,
      "runtime must not rewrite provider identity",
    );
  }
  assert.equal(queries, 3);
  assert.equal(catalogs, 3);
  assert.deepEqual(
    readFileSync(f.env.RELEASE_ACTIVATION_PERMIT),
    originalPermit,
  );
  assert.deepEqual(readFileSync(f.env.RELEASE_HELD_EVIDENCE), originalHeld);
  assert.deepEqual(assetInventory(f.root), f.manifest.assets);
});

test("expired permits refuse new Publish but bound cold starts remain admitted after all approval TTLs", (t) => {
  const f = fixture(t);
  f.authorize(-7 * 86400_000);
  assert.throws(
    () =>
      promoteReplit("api-server", f.env, f.root, {
        query: () => assert.fail("expired promotion stops before DB preflight"),
      }),
    /expired for promotion/,
  );
  rmSync(path.join(f.root, ".git"), { recursive: true });
  rmSync(f.env.RELEASE_RECOVERY_PLAN);
  rmSync(f.env.RELEASE_HELD_EVIDENCE);
  f.env.PATH = "";
  f.env.DATABASE_URL = "invalid-no-db-client";
  const started = f.cli("start", "api-server");
  assert.equal(started.status, 0, started.stderr);
  assert.equal(
    JSON.parse(started.stdout.trim().split("\n").at(-1)).executed,
    true,
  );
  assert.deepEqual(assetInventory(f.root), f.manifest.assets);
});

test("runtime scope, control-plane admission and invalid actions fail before API import", (t) => {
  const f = fixture(t);
  f.authorize();
  const original = { ...f.env };
  for (const changes of [
    { RELEASE_RUNTIME_STATE: "run" },
    { RELEASE_RUNTIME_STATE: "" },
    { RELEASE_RUNTIME_STATE: "RESUME" },
    { RELEASE_RECOVERY_MODE: "rollback" },
    { RELEASE_RECOVERY_MODE: undefined },
    { RELEASE_TRAFFIC_DRAINED: "0" },
    { RELEASE_ACTIVATION_PERMIT_SHA256: undefined },
    { RELEASE_ACTIVATION_PERMIT_SHA256: "0".repeat(64) },
    { RELEASE_ACTIVATION_ID: "33333333-3333-4333-8333-333333333333" },
    { RELEASE_BASE_URL: "https://elsewhere.invalid" },
    { RELEASE_TARGET_REPL_ID: undefined, REPL_ID: targetReplId },
    { RELEASE_TARGET_REPL_ID: "different-target" },
    { RELEASE_TARGET_REPL_ID: providerReplId },
    { RELEASE_RECOVERY_PLAN_SHA256: "0".repeat(64) },
    { RELEASE_BACKUP_SHA256: "0".repeat(64) },
    { RELEASE_HELD_EVIDENCE_SHA256: "0".repeat(64) },
  ]) {
    Object.assign(f.env, original, changes);
    const result = f.cli("start", "api-server");
    assert.notEqual(result.status, 0, JSON.stringify(changes));
    assert.match(result.stderr, /REFUSED/);
    assert.doesNotMatch(result.stdout, /"executed":true/);
  }
  Object.assign(f.env, original);
  for (const args of [
    ["resume", "api-server"],
    ["activate", "api-server"],
    ["start", "landing"],
    ["start", "api-server", "RUN"],
    ["build", "api-server", "--skip-checks"],
    ["start", "../api-server"],
    [],
  ]) {
    const result = f.cli(...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.doesNotMatch(result.stdout, /"executed":true/);
  }
});

test("activation binds actual backup heartbeat, plan, verified held evidence and approval ordering", (t) => {
  const f = fixture(t);
  const initial = f.authorize();
  const deps = {
    query: () => recovery(initial.plan.backup.completedAt),
    catalog: () => catalog,
  };
  const { permit, record } = initial;
  const backupWrong = { ...permit, backupSha256: "0".repeat(64) };
  f.env.RELEASE_BACKUP_SHA256 = backupWrong.backupSha256;
  record("activation-permit", "RELEASE_ACTIVATION_PERMIT", backupWrong);
  assert.throws(
    () => promoteReplit("api-server", f.env, f.root, deps),
    /pre-change backup checksum mismatch/,
  );
  f.env.RELEASE_BACKUP_SHA256 = "b".repeat(64);
  record("activation-permit", "RELEASE_ACTIVATION_PERMIT", permit);
  assert.throws(
    () =>
      promoteReplit("api-server", f.env, f.root, {
        ...deps,
        query: () => recovery(),
      }),
    /backup completion differs/,
  );
  for (const mutate of [
    (held) => {
      held.apiReadinessVerified = true;
    },
    (held) => {
      held.checks.securityCatalog = false;
    },
    (held) => {
      held.checks.extra = true;
    },
    (held) => {
      held.verifiedAt = new Date(
        Date.parse(permit.approvedAt) + 1000,
      ).toISOString();
    },
    (held) => {
      held.verifiedAt = new Date(
        Date.parse(initial.plan.approvedAt) - 1000,
      ).toISOString();
    },
    (held) => {
      held.target.origin = "https://elsewhere.invalid";
    },
  ]) {
    const held = structuredClone(initial.held);
    mutate(held);
    record("held-evidence", "RELEASE_HELD_EVIDENCE", held);
    record("activation-permit", "RELEASE_ACTIVATION_PERMIT", {
      ...permit,
      heldEvidenceSha256: f.env.RELEASE_HELD_EVIDENCE_SHA256,
    });
    assert.throws(() => promoteReplit("api-server", f.env, f.root, deps));
  }
  record("held-evidence", "RELEASE_HELD_EVIDENCE", initial.held);
  record("activation-permit", "RELEASE_ACTIVATION_PERMIT", permit);
  f.write("release/held-evidence.json", "{}");
  assert.throws(
    () => promoteReplit("api-server", f.env, f.root, deps),
    /held evidence checksum mismatch/,
  );
});

test("CI production origin and mandatory stable Repl ID bindings cannot drift", async (t) => {
  const f = fixture(t);
  const { manifest } = f;
  const mobile = {
    ...manifest.mobile,
    replId: "44444444-4444-4444-8444-444444444444",
  };
  const changed = { ...manifest, mobile };
  f.stamp(changed);
  assert.throws(
    () => promoteReplit("api-server", f.env, f.root),
    /RELEASE_TARGET_REPL_ID differs/,
  );
  f.stamp();
  for (const origin of [
    "https://wrong.invalid",
    "https://fixture.invalid/app",
    "https://user:pass@fixture.invalid",
    "https://fixture.invalid?x=1",
  ]) {
    await assert.rejects(
      startReplitApi({ ...f.env, RELEASE_BASE_URL: origin }, f.root),
    );
  }
});

test("HOLD and RUN refuse missing, malformed or foreign stable targets before IO without provider fallback", async (t) => {
  const f = fixture(t);
  f.authorize();
  for (const state of ["HOLD", "RUN"]) {
    for (const target of [
      undefined,
      null,
      "",
      "not-a-uuid",
      targetReplId.toUpperCase(),
      ` ${targetReplId}`,
      `${targetReplId}\n`,
      providerReplId,
    ]) {
      const env = {
        ...f.env,
        RELEASE_RUNTIME_STATE: state,
        RELEASE_TARGET_REPL_ID: target,
        REPL_ID: targetReplId,
        EXPO_PUBLIC_REPL_ID: targetReplId,
      };
      assert.throws(
        () =>
          promoteReplit("api-server", env, f.root, {
            query: () =>
              assert.fail("invalid target must precede DB preflight"),
            catalog: () =>
              assert.fail("invalid target must precede catalog IO"),
          }),
        /RELEASE_TARGET_REPL_ID/,
      );
      await assert.rejects(
        startReplitApi(env, f.root),
        /RELEASE_TARGET_REPL_ID/,
      );
    }
  }
});

test("promotion requires a canonical CI mobile target rather than falling back to configured identity", (t) => {
  const f = fixture(t);
  for (const target of [
    undefined,
    null,
    "",
    "not-a-uuid",
    targetReplId.toUpperCase(),
    `${targetReplId}\n`,
  ]) {
    f.stamp({
      ...f.manifest,
      mobile: { ...f.manifest.mobile, replId: target },
    });
    assert.throws(
      () =>
        promoteReplit("api-server", f.env, f.root, {
          query: () =>
            assert.fail("invalid manifest target must precede DB preflight"),
        }),
      /CI mobile production Repl ID.*canonical UUID/,
    );
  }
});

test("provider diagnostics are sanitized in promotion and runtime without rewriting the provider value", (t) => {
  const f = fixture(t);
  const { plan } = f.authorize();
  const logs = [];
  t.mock.method(console, "log", (...values) => logs.push(values.join(" ")));
  for (const provider of [
    providerReplId,
    `${providerReplId}\n`,
    "not-an-id\nforged diagnostic",
    "x".repeat(4096),
  ]) {
    f.env.REPL_ID = provider;
    const expected = provider === providerReplId ? provider : "unavailable";
    const diagnostic =
      `replit: operator-approved target ${targetReplId}; provider REPL_ID ` +
      `${expected} is execution context, not target attestation`;
    logs.length = 0;
    promoteReplit("api-server", Object.freeze({ ...f.env }), f.root, {
      query: () => recovery(plan.backup.completedAt),
      catalog: () => catalog,
    });
    assert.deepEqual(
      logs.filter((line) => line.includes("provider REPL_ID")),
      [diagnostic],
    );
    const result = f.cli("start", "api-server");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.includes("provider REPL_ID")),
      [diagnostic],
    );
    const body = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(body.providerReplId, provider);
  }
});
