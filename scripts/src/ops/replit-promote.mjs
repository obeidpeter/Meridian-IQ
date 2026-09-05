// Native Publish validates staged CI output; it never compiles or downloads it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
import { loadMaintenancePlan } from "./recovery-plan.mjs";
import { loadActivationPermit } from "./activation-permit.mjs";
import { loadHeldEvidence } from "./postdeploy.mjs";
import {
  activationBindings,
  maintenanceIdentity,
  pilotIdentity,
  releaseProfile,
  runtimeState,
  startMaintenanceServer,
} from "./maintenance-server.mjs";

export const REPLIT_APPS = [
  "api-server",
  ...APPS.map(([app]) => app),
  "mobile",
];
const manifestPath = (root) => path.join(root, "release/build-manifest.json");

// The manifest checksum. Governed: only an independently supplied
// RELEASE_MANIFEST_SHA256 is trusted. Pilot: the sidecar CI wrote beside the
// manifest (`<sha256>  build-manifest.json`) is enough — it proves the staged
// bytes are the CI upload, which is the guarantee a pre-pilot needs; an
// explicit RELEASE_MANIFEST_SHA256 still wins when set.
function withManifestChecksum(env, root) {
  if (env.RELEASE_MANIFEST_SHA256 || releaseProfile(env) === "governed")
    return env;
  const sidecar = `${manifestPath(root)}.sha256`;
  assert.ok(
    existsSync(sidecar),
    "pilot Publish needs release/build-manifest.json.sha256 beside the staged manifest (or RELEASE_MANIFEST_SHA256)",
  );
  const checksum = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0] ?? "";
  assert.match(checksum, /^[a-f0-9]{64}$/, "malformed manifest checksum sidecar");
  return { ...env, RELEASE_MANIFEST_SHA256: checksum };
}

// Pilot profile: the API build syncs the target schema — plain `push` (a
// destructive diff prompts, gets EOF without a terminal and fails closed) and
// then the guardrail migrations — so an additive change lands with the
// deploy and anything destructive needs a reviewed migration. Only the API
// build touches the database; web builds verify bytes only.
function pilotSchemaSync(env, root, dependencies) {
  assert.ok(
    env.DATABASE_URL,
    "the pilot API build needs DATABASE_URL to sync the target schema",
  );
  const execute = dependencies.execute ?? run;
  for (const script of ["push", "migrate"]) {
    const result = execute("pnpm", ["--filter", "@workspace/db", "run", script], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    assert.equal(
      result.status,
      0,
      `schema ${script} failed: the Publish build stops here; a destructive diff needs a reviewed migration`,
    );
  }
}

function assertPublishable(app) {
  assert.ok(REPLIT_APPS.includes(app), `unsupported promotion app: ${app}`);
}

function logExecutionContext(identity, env) {
  const providerId =
    typeof env.REPL_ID === "string" &&
    env.REPL_ID.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      env.REPL_ID,
    )
      ? env.REPL_ID
      : "unavailable";
  console.log(
    `replit: operator-approved target ${identity.target.replId}; provider REPL_ID ${providerId} is execution context, not target attestation`,
  );
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
  env = withManifestChecksum(env, root);
  const profile = releaseProfile(env);
  const manifest = stagedManifest(app, env, root);
  const state = app === "api-server" ? runtimeState(env) : undefined;
  if (app === "api-server" && profile === "governed")
    logExecutionContext(maintenanceIdentity(manifest, env), env);
  if (state === "RUN" && profile === "governed")
    loadActivationPermit(env, activationBindings(manifest, env), {
      phase: "promotion",
    });
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
  // Only fixed JSON metadata names may accompany staged CI bytes. Arbitrary
  // configured paths must not exempt unreviewed source from the clean-tree gate.
  for (const [name, variable] of [
    ["recovery-plan", "RELEASE_RECOVERY_PLAN"],
    ["held-evidence", "RELEASE_HELD_EVIDENCE"],
    ["activation-permit", "RELEASE_ACTIVATION_PERMIT"],
  ]) {
    const file = `release/${name}.json`;
    if (
      env[variable] &&
      path.resolve(root, env[variable]) === path.join(root, file)
    )
      stagingFiles.add(file);
  }
  assert.deepEqual(
    untracked.stdout
      .split("\0")
      .filter((file) => file && !stagingFiles.has(file)),
    [],
    "unexpected untracked Publish source; only the staged manifest files are permitted",
  );
  verifyReplitArtifact(manifest, root);

  if (app === "api-server" && profile === "pilot") {
    pilotSchemaSync(env, root, dependencies);
    console.log(
      `replit: pilot profile — verified artifact ${manifest.source.revision}, schema synced; the API starts in ${state}`,
    );
  } else if (app === "api-server") {
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
    if (env.RELEASE_RECOVERY_MODE === "maintenance-forward") {
      // release() binds this exact approved plan to the actual backup heartbeat
      // and completion time. Reloading with our expected SHA also binds the env.
      const plan = loadMaintenancePlan(env, {
        revision: manifest.source.revision,
        backupSha256: env.RELEASE_BACKUP_SHA256,
      });
      if (state === "RUN") {
        const evidence = loadHeldEvidence(env, manifest, {
          notBefore: Date.parse(plan.approvedAt),
        });
        const permit = loadActivationPermit(
          env,
          activationBindings(manifest, env),
          { phase: "promotion" },
        );
        assert.ok(
          Date.parse(evidence.verifiedAt) <= Date.parse(permit.approvedAt),
          "activation approval must follow held verification",
        );
        console.log(
          `replit: activation ${permit.activationId} approved for RUN startup writes; repeated Publish with this active permit is the same logical activation, not single-use; keep external ingress and schedules held until real API readiness is verified`,
        );
      }
    }
    if (state === "HOLD")
      console.log(
        "replit: HOLD only; API bundle and workers will not start; rollback preflight does not authorize RUN",
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
  env = withManifestChecksum(env, root);
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
  if (app === "api-server" && releaseProfile(env) === "pilot") {
    const state = runtimeState(env);
    if (state === "HOLD") {
      assert.match(
        env.PORT ?? "",
        /^[1-9][0-9]{0,4}$/,
        "HOLD requires a valid PORT",
      );
      console.log(
        `replit: pilot HOLD revision ${manifest.source.revision}; API not imported; maintenance health is not API readiness`,
      );
      return startMaintenanceServer(pilotIdentity(manifest, env), {
        port: Number(env.PORT),
      });
    }
    console.log(
      `replit: pilot RUN revision ${manifest.source.revision}; no activation permit is required in this profile`,
    );
  } else if (app === "api-server") {
    const state = runtimeState(env);
    const identity = maintenanceIdentity(manifest, env);
    logExecutionContext(identity, env);
    if (state === "HOLD") {
      assert.match(
        env.PORT ?? "",
        /^[1-9][0-9]{0,4}$/,
        "HOLD requires a valid PORT",
      );
      console.log(
        `replit: HOLD revision ${manifest.source.revision}; API not imported, no database calls or workers; maintenance health is not API readiness`,
      );
      return startMaintenanceServer(identity, { port: Number(env.PORT) });
    }
    // The independently trusted permit is durable admission for this exact
    // deployment. Cold starts check bindings, not current promotion-time TTL.
    const permit = loadActivationPermit(
      env,
      activationBindings(manifest, env),
      { phase: "runtime" },
    );
    console.log(
      `replit: RUN activation ${permit.activationId}; startup writes authorized; external ingress and schedules must remain held pending real API readiness`,
    );
  }
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

export function releaseEnvForCli(extra, env = process.env) {
  if (extra.length === 0) return env;
  assert.equal(
    extra.length,
    2,
    "use --hold <rollback-revision> or omit release-mode arguments",
  );
  assert.equal(extra[0], "--hold", "unknown release-mode argument");
  assert.match(
    extra[1],
    /^[a-f0-9]{40}$/,
    "--hold requires a full rollback revision SHA",
  );
  return {
    ...env,
    RELEASE_RUNTIME_STATE: "HOLD",
    RELEASE_RECOVERY_MODE: "rollback",
    RELEASE_ROLLBACK_REVISION: extra[1],
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [action, app, ...extra] = process.argv.slice(2);
    assertPublishable(app);
    const env = releaseEnvForCli(extra);
    if (extra.length > 0)
      assert.equal(
        app,
        "api-server",
        "--hold is only valid for the API release gate",
      );
    if (action === "build") promoteReplit(app, env);
    else {
      assert.ok(
        action === "start" && ["api-server", "mobile"].includes(app),
        "use build <app> or start <api-server|mobile>",
      );
      env.NODE_ENV = "production";
      await startReplitService(app, env);
    }
  } catch (error) {
    console.error(`replit: REFUSED: ${error.message}`);
    process.exitCode = 1;
  }
}
