import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  startReplitApi,
} from "./replit-promote.mjs";
import {
  validateMobileArtifact,
  verifyMobileServing,
} from "./mobile-artifact.mjs";
import { startStaticServer } from "../e2e/serve.mjs";

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
    replId: null,
  };
  const eas = {
    build: { production: { env: { EXPO_PUBLIC_DOMAIN: mobileConfig.domain } } },
  };
  write("artifacts/mobile/eas.json", JSON.stringify(eas));
  for (const name of [
    "replit-promote",
    "build-manifest",
    "release",
    "security-catalog",
    "common",
    "mobile-artifact",
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
    `console.log(JSON.stringify({ executed: true, revision: process.env.BUILD_REVISION, expected: process.env.EXPECTED_BUILD_REVISION }));\n`,
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
  return { root, write, git, manifest, env, stamp, cli };
}

function recovery() {
  return JSON.stringify(
    ["backup", "restore_drill"].map((key) => ({
      key,
      last_succeeded_at: new Date(Date.now() - 1000).toISOString(),
      last_error: null,
      metadata: { sha256: "b".repeat(64) },
    })),
  );
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
    () => promoteReplit("landing", f.env, f.root),
    /artifact directory must be real/,
  );
});

test("API startup needs no Git and sets exact CI revision before importing unchanged dist", (t) => {
  const f = fixture(t);
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
    query: recovery,
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
    assert.match(
      production,
      new RegExp(
        `\\[\\s*"node", "scripts/src/ops/replit-promote\\.mjs", "build", "${app}"\\s*\\]`,
      ),
    );
    if (app === "api-server") {
      assert.ok(
        production.includes(
          '["node", "--enable-source-maps", "scripts/src/ops/replit-promote.mjs", "start", "api-server"]',
        ),
      );
      assert.ok(production.includes('path = "/api/healthz"'));
    } else if (app !== "mobile") {
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
    query: recovery,
    catalog: () => structuredClone(catalog),
    execute: () =>
      assert.fail("metadata promotion must not execute migrations"),
  };
  for (const app of ["landing", "api-server"])
    assert.deepEqual(
      promoteReplit(app, f.env, f.root, dependencies),
      f.manifest,
    );
  const started = f.cli("start", "api-server");
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout.trim().split("\n").at(-1)), {
    executed: true,
    revision: f.manifest.source.revision,
    expected: f.manifest.source.revision,
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
