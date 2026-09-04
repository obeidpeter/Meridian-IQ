// Native Publish validates staged CI output; it never compiles or downloads it.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  APPS,
  ROOT,
  assetInventory,
  loadManifest,
  sourceIdentity,
  verifyLocalArtifact,
} from "./build-manifest.mjs";
import { run } from "./common.mjs";
import { release } from "./release.mjs";
import { MOBILE_DIR, validateMobileArtifact } from "./mobile-artifact.mjs";

export const REPLIT_APPS = [
  "api-server",
  ...APPS.map(([app]) => app),
  "mobile",
];
const manifestPath = (root) => path.join(root, "release/build-manifest.json");

function assertPublishable(app) {
  assert.ok(REPLIT_APPS.includes(app), `unsupported promotion app: ${app}`);
}

function stagedManifest(app, env, root) {
  assertPublishable(app);
  const manifest = loadManifest(
    manifestPath(root),
    env.RELEASE_MANIFEST_SHA256,
  );
  assert.match(
    manifest.source.tree ?? "",
    /^[a-f0-9]{40}$/,
    "missing source tree",
  );
  for (const field of ["sha256", "schemaSha256"])
    assert.match(
      manifest.source[field] ?? "",
      /^[a-f0-9]{64}$/,
      `missing source ${field}`,
    );
  assert.match(
    String(manifest.ci.runId),
    /^[1-9][0-9]*$/,
    "invalid CI run identity",
  );
  assert.match(
    manifest.ci.repository,
    /^[\w.-]+\/[\w.-]+$/,
    "invalid CI repository",
  );
  assert.equal(
    typeof manifest.contractVersion,
    "string",
    "missing contract identity",
  );
  return manifest;
}

function verifyReplitArtifact(manifest, root) {
  const local = sourceIdentity(root);
  // Native Publish may add an empty metadata commit. Only its commit identity
  // may differ: the full Git tree and both byte hashes remain authoritative.
  assert.deepEqual(
    { ...local, revision: manifest.source.revision },
    manifest.source,
    "source or schema differs from CI artifact (Replit permits metadata-only HEAD differences)",
  );
  verifyLocalArtifact({ ...manifest, source: local }, root);
  if (local.revision !== manifest.source.revision)
    console.log(
      `replit: local HEAD ${local.revision} differs from tested CI revision ${manifest.source.revision}; identical tree/source/schema verified; deployed revision remains the CI revision`,
    );
}

export function promoteReplit(
  app,
  env = process.env,
  root = ROOT,
  dependencies = {},
) {
  const manifest = stagedManifest(app, env, root);
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
  });
  assert.equal(
    status.status,
    0,
    "Publish build requires the matching Git checkout; no snapshot fallback",
  );
  assert.equal(
    status.stdout.trim(),
    "",
    "Publish source must be clean (including the index)",
  );
  const untracked = run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  );
  assert.equal(untracked.status, 0, "cannot inspect untracked Publish source");
  const stagingFiles = new Set([
    "release/build-manifest.json",
    "release/build-manifest.json.sha256",
  ]);
  assert.deepEqual(
    untracked.stdout
      .split("\0")
      .filter((file) => file && !stagingFiles.has(file)),
    [],
    "unexpected untracked Publish source; only the staged manifest files are permitted",
  );
  verifyReplitArtifact(manifest, root);

  if (app === "api-server") {
    // All services verify all seven builds. Only the API needs target DB credentials;
    // its mandatory read-only preflight retains recovery and semantic catalog gates.
    release(
      ["--yes"],
      { ...env, RELEASE_MANIFEST: manifestPath(root) },
      {
        ...dependencies,
        verifyArtifact: (value) => verifyReplitArtifact(value, root),
      },
    );
  }
  console.log(
    `replit: verified ${app}, all seven CI artifacts, revision ${manifest.source.revision}; no rebuild`,
  );
  return manifest;
}

export async function startReplitService(app, env = process.env, root = ROOT) {
  assert.ok(
    ["api-server", "mobile"].includes(app),
    "only packaged server apps can start",
  );
  assert.equal(
    env.NODE_ENV,
    "production",
    "Replit server startup requires NODE_ENV=production",
  );
  const manifest = stagedManifest(app, env, root);
  assert.deepEqual(
    assetInventory(root),
    manifest.assets,
    "packaged assets differ from CI artifact",
  );
  const mobile = validateMobileArtifact(root);
  assert.deepEqual(
    mobile,
    manifest.mobile,
    "mobile deployment identity differs from CI artifact",
  );
  if (app === "mobile") {
    if (env.BASE_PATH)
      assert.equal(
        env.BASE_PATH,
        mobile.basePath,
        "mobile runtime base path differs from tested build",
      );
    process.env.BASE_PATH = mobile.basePath;
  }

  // Do not consult Git or Replit's deployment UUID in the runtime snapshot.
  // Set both values before the original bundle evaluates its build-info module.
  process.env.BUILD_REVISION = manifest.source.revision;
  process.env.EXPECTED_BUILD_REVISION = manifest.source.revision;
  console.log(
    `replit: starting verified ${app} revision ${manifest.source.revision}`,
  );
  return import(
    pathToFileURL(
      path.join(
        root,
        app === "mobile"
          ? `${MOBILE_DIR}/server/serve.cjs`
          : "artifacts/api-server/dist/index.mjs",
      ),
    ).href
  );
}

export const startReplitApi = (env = process.env, root = ROOT) =>
  startReplitService("api-server", env, root);

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [action, app, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0, "unexpected promotion arguments");
    assertPublishable(app);
    if (action === "build") promoteReplit(app);
    else {
      assert.ok(
        action === "start" && ["api-server", "mobile"].includes(app),
        "use build <app> or start <api-server|mobile>",
      );
      process.env.NODE_ENV = "production";
      await startReplitService(app);
    }
  } catch (error) {
    console.error(`replit: REFUSED: ${error.message}`);
    process.exitCode = 1;
  }
}
