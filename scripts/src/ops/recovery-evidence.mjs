import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPS_OUTPUT_LIMIT, hostPortFromUrl, psql } from "./common.mjs";
import { assertSecurityCatalog } from "./security-catalog.mjs";
import { assertPrerequisites } from "./backup-prerequisites.mjs";
import {
  databaseRoleRoots,
  validateDatabaseSnapshot,
} from "./backup-database.mjs";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const BACKUP_MAX_AGE_MS = 24 * 3600_000;
export const snapshotDigest = ({
  catalog,
  rowCounts,
  roles,
  roleRoots,
  memberships,
  runtimeLogin,
  extensions,
  databaseProperties,
}) =>
  sha256(
    JSON.stringify({
      catalog,
      rowCounts,
      roles,
      roleRoots,
      memberships,
      runtimeLogin,
      extensions,
      databaseProperties,
    }),
  );
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function privateBackupDirectory(input) {
  assert.ok(
    input && path.isAbsolute(input),
    "BACKUP_DIR must be an absolute private directory outside the checkout",
  );
  const outside = (directory) => {
    const relative = path.relative(realpathSync(ROOT), directory);
    assert.ok(
      relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative),
      "backup artifacts must be outside the checkout",
    );
  };
  outside(path.resolve(input));
  assert.ok(
    lstatSync(path.dirname(input)).isDirectory(),
    "BACKUP_DIR parent must already exist",
  );
  mkdirSync(input, { recursive: true, mode: 0o700 });
  const stat = lstatSync(input);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "backup directory must not be a symlink",
  );
  const directory = realpathSync(input);
  outside(directory);
  if (process.platform !== "win32")
    assert.equal(
      stat.mode & 0o077,
      0,
      "backup directory must be private (0700)",
    );
  return directory;
}

export function loadBackupManifest(file, trustedSha256, now = Date.now()) {
  assert.ok(file, "BACKUP_MANIFEST is required");
  assert.match(
    trustedSha256 ?? "",
    /^[a-f0-9]{64}$/,
    "independently trusted BACKUP_MANIFEST_SHA256 is required",
  );
  const stat = lstatSync(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= OPS_OUTPUT_LIMIT,
    "invalid backup manifest file",
  );
  const bytes = readFileSync(file);
  assert.equal(
    sha256(bytes),
    trustedSha256,
    "backup manifest checksum mismatch",
  );
  const manifest = JSON.parse(bytes);
  assert.equal(
    manifest.format,
    2,
    "backup manifest format 2 is required for durable extension/membership evidence",
  );
  const age = now - Date.parse(manifest.createdAt);
  assert.ok(
    Number.isFinite(age) && age >= 0 && age <= BACKUP_MAX_AGE_MS,
    "backup is stale, future-dated or invalid",
  );
  assert.equal(typeof manifest.source?.database, "string");
  assert.equal(typeof manifest.source?.endpoint, "string");
  assert.match(
    manifest.archive?.file ?? "",
    /^meridian-\d{8}T\d{6}Z-[a-f0-9]{32}\.dump$/,
  );
  assert.match(manifest.archive.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0,
  );
  assertSecurityCatalog(manifest.catalog);
  assertPrerequisites(manifest);
  validateDatabaseSnapshot(manifest.databaseProperties);
  assert.equal(manifest.databaseProperties.database, manifest.source.database);
  for (const role of databaseRoleRoots(manifest.databaseProperties))
    assert.ok(
      manifest.roleRoots.includes(role),
      "database ACL/settings role missing from role prerequisites",
    );
  assert.deepEqual(
    Object.keys(manifest.rowCounts).sort(),
    manifest.catalog.tables.map((t) => t.name).sort(),
  );
  for (const rows of Object.values(manifest.rowCounts))
    assert.match(rows, /^\d+$/);
  assert.equal(
    snapshotDigest(manifest),
    manifest.snapshotSha256,
    "backup snapshot digest mismatch",
  );
  return {
    manifest,
    archive: path.join(path.dirname(path.resolve(file)), manifest.archive.file),
  };
}

export function drillTarget(env, manifest) {
  assert.equal(
    env.DRILL_DATABASE_DISPOSABLE,
    "1",
    "DRILL_DATABASE_DISPOSABLE=1 is required",
  );
  assert.ok(
    env.DATABASE_URL && env.DRILL_DATABASE_URL,
    "source and drill URLs are required",
  );
  const target = new URL(env.DRILL_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.ok(target.hostname && !target.hash);
  const database = decodeURIComponent(target.pathname.slice(1));
  assert.equal(
    env.DRILL_CONFIRM_TARGET,
    database,
    "DRILL_CONFIRM_TARGET must exactly name the fresh scratch database",
  );
  assert.match(
    database,
    /^meridian_drill_[a-z0-9_]{1,40}$/,
    "use a fresh meridian_drill_<unique> database",
  );
  assert.notEqual(
    database,
    manifest.source.database,
    "drill target is the source database",
  );
  assert.notEqual(
    database,
    decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)),
    "drill target matches source URL database regardless of host",
  );
  assert.equal(
    hostPortFromUrl(env.DATABASE_URL),
    manifest.source.endpoint,
    "source endpoint differs from backup",
  );
  const admin = new URL(env.DRILL_ADMIN_URL || env.DRILL_DATABASE_URL);
  if (!env.DRILL_ADMIN_URL) admin.pathname = "/postgres";
  assert.equal(admin.protocol, target.protocol, "drill admin protocol differs");
  assert.equal(
    hostPortFromUrl(admin.toString()),
    hostPortFromUrl(target.toString()),
    "drill admin endpoint differs",
  );
  assert.notEqual(
    decodeURIComponent(admin.pathname.slice(1)),
    database,
    "admin must use a maintenance database",
  );
  // Do not let libpq query parameters silently override the checked target.
  const allowed = new Set([
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "connect_timeout",
    "application_name",
    "channel_binding",
  ]);
  for (const url of [target, admin])
    for (const key of url.searchParams.keys())
      assert.ok(
        allowed.has(key),
        `unsupported drill connection parameter: ${key}`,
      );
  return { database, targetUrl: target.toString(), adminUrl: admin.toString() };
}

export function recordRecoveryHeartbeat(url, key, metadata, query = psql) {
  assert.ok(["backup", "restore_drill"].includes(key));
  const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64");
  // ON CONFLICT locks and checks the current row atomically, including backups
  // published from other directories. Older snapshots must not replace newer evidence.
  const newerSnapshot =
    key === "backup"
      ? `WHERE operational_heartbeats.metadata->>'createdAt' IS NULL
      OR (operational_heartbeats.metadata->>'createdAt')::timestamptz
        <= (excluded.metadata->>'createdAt')::timestamptz`
      : "";
  query(
    url,
    `BEGIN;
    SET LOCAL ROLE meridian_app;
    SELECT set_config('app.bypass', 'on', true);
    DO $heartbeat$ BEGIN
    INSERT INTO operational_heartbeats (key,last_started_at,last_succeeded_at,last_error,metadata,updated_at)
    VALUES ('${key}',now(),now(),NULL,convert_from(decode('${encoded}','base64'),'utf8')::jsonb,now())
    ON CONFLICT (key) DO UPDATE SET last_succeeded_at=excluded.last_succeeded_at,
      last_error=NULL,metadata=excluded.metadata,updated_at=now()
      ${newerSnapshot};
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refusing older backup snapshot; newer recovery evidence already exists';
    END IF;
    END $heartbeat$; COMMIT;`,
  );
}
