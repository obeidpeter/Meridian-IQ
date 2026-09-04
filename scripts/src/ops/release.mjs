// Production preflight never pushes schema. Promote the verified immutable build
// externally, then run ops:postdeploy. Schema drift requires reviewed versioned SQL.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { psql, run, dbNameFromUrl, hostPortFromUrl } from "./common.mjs";
import { loadManifest, verifyLocalArtifact, ROOT } from "./build-manifest.mjs";
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
  assert.match(
    env.RELEASE_ROLLBACK_REVISION ?? "",
    /^[a-f0-9]{40}$/,
    "document and set RELEASE_ROLLBACK_REVISION to the compatible rollback build's full SHA",
  );
  return { offline };
}

export function assertRecoveryEvidence(rows, now = Date.now()) {
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
    if (key === "backup")
      assert.match(
        row.metadata?.sha256 ?? "",
        /^[a-f0-9]{64}$/,
        "backup checksum missing",
      );
  }
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
  console.log(
    `release: target ${hostPortFromUrl(env.DATABASE_URL)}/${dbNameFromUrl(env.DATABASE_URL)}; rollback ${env.RELEASE_ROLLBACK_REVISION}`,
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
