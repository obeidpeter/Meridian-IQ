// Production preflight never pushes schema. Promote the verified immutable build
// externally, then run ops:postdeploy. Schema drift requires reviewed versioned SQL.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { psql, run, dbNameFromUrl, hostPortFromUrl } from "./common.mjs";
import { loadManifest, verifyLocalArtifact, ROOT } from "./build-manifest.mjs";
import { recoveryMode, loadMaintenancePlan } from "./recovery-plan.mjs";
import {
  compareSecurityCatalog,
  readSecurityCatalog,
} from "./security-catalog.mjs";

export function releaseOptions(args, env) {
  assert.ok(
    env.DATABASE_URL,
    "DATABASE_URL must name the intended release target",
  );
  assert.ok(args.includes("--yes"), "refusing release without --yes");
  assert.ok(
    !env.RELEASE_PUSH_FORCE,
    "RELEASE_PUSH_FORCE is retired; destructive schema push is not supported",
  );
  const offline = args.includes("--offline-bootstrap");
  if (offline)
    assert.equal(
      env.RELEASE_TRAFFIC_DRAINED,
      "1",
      "offline bootstrap requires RELEASE_TRAFFIC_DRAINED=1 after all web/worker traffic is externally stopped",
    );
  assert.ok(
    env.RELEASE_MANIFEST && env.RELEASE_MANIFEST_SHA256,
    "a trusted CI manifest and checksum are required",
  );
  const mode = recoveryMode(env);
  assert.ok(
    !(offline && mode === "maintenance-forward"),
    "maintenance-forward never enables schema push; apply separately reviewed versioned migrations",
  );
  return { offline };
}

export function assertRecoveryEvidence(rows, now = Date.now()) {
  assert.ok(Array.isArray(rows), "recovery evidence must be an array");
  for (const [key, maxAge] of [
    ["backup", 24 * 3600_000],
    ["restore_drill", 30 * 86400_000],
  ]) {
    const row = rows.find((entry) => entry.key === key);
    const age = now - Date.parse(row?.last_succeeded_at);
    assert.ok(
      row &&
        !row.last_error &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= maxAge,
      `missing, failed, or stale ${key} evidence`,
    );
    assert.equal(
      row.metadata?.evidenceVersion,
      2,
      `${key} evidence format is unverified`,
    );
  }
  const backup = rows.find((row) => row.key === "backup");
  const drill = rows.find((row) => row.key === "restore_drill");
  for (const key of ["sha256", "snapshotSha256", "manifestSha256"]) {
    assert.match(
      backup.metadata[key] ?? "",
      /^[a-f0-9]{64}$/,
      `backup ${key} missing`,
    );
  }
  assert.equal(
    drill.metadata.backupSha256,
    backup.metadata.sha256,
    "restore drill did not verify the current retained backup",
  );
  assert.equal(
    drill.metadata.snapshotSha256,
    backup.metadata.snapshotSha256,
    "restore snapshot baseline mismatch",
  );
  assert.equal(
    drill.metadata.backupManifestSha256,
    backup.metadata.manifestSha256,
    "restore backup manifest mismatch",
  );
  assert.equal(
    drill.metadata.securityCatalogVerified,
    true,
    "restored security catalog was not verified",
  );
  assert.equal(
    drill.metadata.allTableCountsVerified,
    true,
    "restored table counts were not verified",
  );
  const createdAt = Date.parse(backup.metadata.createdAt);
  const backedUpAt = Date.parse(backup.last_succeeded_at);
  const restoredAt = Date.parse(drill.last_succeeded_at);
  assert.ok(
    Number.isFinite(createdAt) &&
      createdAt <= backedUpAt &&
      now - createdAt <= 24 * 3600_000,
    "backup snapshot is stale or newer than its completion evidence",
  );
  assert.equal(
    Date.parse(drill.metadata.backupCreatedAt),
    createdAt,
    "restore backup timestamp mismatch",
  );
  assert.ok(
    restoredAt >= backedUpAt,
    "restore drill predates the retained backup",
  );
}

export function release(
  args = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const { offline } = releaseOptions(args, env);
  const verifyArtifact = dependencies.verifyArtifact ?? verifyLocalArtifact;
  const query = dependencies.query ?? psql;
  const catalog = dependencies.catalog ?? readSecurityCatalog;
  const execute = dependencies.execute ?? run;
  const manifest = loadManifest(
    env.RELEASE_MANIFEST,
    env.RELEASE_MANIFEST_SHA256,
  );
  verifyArtifact(manifest);
  const evidence = JSON.parse(
    query(
      env.DATABASE_URL,
      "SELECT coalesce(json_agg(row_to_json(h)), '[]') FROM (SELECT key, last_succeeded_at, last_error, metadata FROM public.operational_heartbeats WHERE key IN ('backup','restore_drill')) h",
    ),
  );
  assertRecoveryEvidence(evidence);
  const mode = recoveryMode(env);
  if (mode === "maintenance-forward") {
    const backup = evidence.find((row) => row.key === "backup");
    const plan = loadMaintenancePlan(env, {
      revision: manifest.source.revision,
      backupSha256: backup.metadata.sha256,
    });
    assert.equal(
      Date.parse(plan.backup.completedAt),
      Date.parse(backup.last_succeeded_at),
      "maintenance plan backup completion differs from verified evidence",
    );
    assert.ok(
      Date.parse(backup.metadata.createdAt) >=
        Date.parse(plan.drain.confirmedAt),
      "maintenance backup snapshot predates the confirmed writer drain",
    );
  }
  console.log(
    `release: target ${hostPortFromUrl(env.DATABASE_URL)}/${dbNameFromUrl(env.DATABASE_URL)}; recovery ${mode}${mode === "rollback" ? ` ${env.RELEASE_ROLLBACK_REVISION}` : "; writers remain stopped until verified forward recovery"}`,
  );
  if (offline) {
    // Explicitly not a migration converter or an online release path.
    // Failure leaves maintenance in place; this tool never restarts traffic.
    for (const script of ["push", "migrate"]) {
      const result = execute(
        "pnpm",
        ["--filter", "@workspace/db", "run", script],
        { cwd: ROOT, env, stdio: "inherit" },
      );
      assert.equal(
        result.status,
        0,
        `${script} failed: keep ALL traffic stopped; restore or repair offline`,
      );
    }
  }
  compareSecurityCatalog(manifest.database, catalog(env.DATABASE_URL));
  console.log(
    `release: preflight verified ${manifest.source.revision}; no deployment performed. Promote these exact assets, set BUILD_REVISION=${manifest.source.revision}, and require ops:postdeploy before reopening traffic.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    release();
  } catch (error) {
    console.error(
      `release: REFUSED: ${error.message}\nDo not resume traffic after an offline failure. No automatic rollback or schema conversion is attempted.`,
    );
    process.exitCode = 1;
  }
}
