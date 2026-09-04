// Restore a specific retained archive. Never create a new dump or overwrite a database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  postgresConnection,
  redactedPostgresError,
  psql,
  run,
  sha256File,
} from "./common.mjs";
import {
  AVAILABLE_EXTENSIONS_SQL,
  INSTALLED_EXTENSIONS_SQL,
  assertExtensionAvailability,
  compareExtensions,
  compareRolePrerequisites,
  rolePrerequisitesSql,
} from "./backup-prerequisites.mjs";
import {
  DATABASE_SNAPSHOT_SQL,
  compareDatabaseCreation,
  compareDatabaseSnapshot,
  createDatabaseSql,
  restoreDatabaseSql,
} from "./backup-database.mjs";
import {
  compareSecurityCatalog,
  readSecurityCatalog,
} from "./security-catalog.mjs";
import {
  drillTarget,
  loadBackupManifest,
  recordRecoveryHeartbeat,
} from "./recovery-evidence.mjs";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

export async function restoreDrill(env = process.env, dependencies = {}) {
  const { manifest, archive } = loadBackupManifest(
    env.BACKUP_MANIFEST,
    env.BACKUP_MANIFEST_SHA256,
  );
  const { database, targetUrl, adminUrl } = drillTarget(env, manifest);
  const connection = postgresConnection(targetUrl);
  const sourceConnection = postgresConnection(env.DATABASE_URL);
  const adminConnection = postgresConnection(adminUrl);
  const query = dependencies.query ?? psql;
  const execute = dependencies.run ?? run;
  const catalog = dependencies.catalog ?? readSecurityCatalog;
  const log = dependencies.log ?? console.log;
  const started = Date.now();
  const stat = lstatSync(archive);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    "backup archive must be a regular file",
  );
  assert.equal(
    stat.size,
    manifest.archive.bytes,
    "backup archive size differs",
  );
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "meridian-verified-restore-"),
  );
  const verifiedCopy = path.join(temporary, "verified.dump");
  try {
    // A private verified copy prevents a later path replacement changing the restored bytes.
    copyFileSync(archive, verifiedCopy);
    assert.equal(
      await sha256File(verifiedCopy),
      manifest.archive.sha256,
      "backup archive checksum mismatch",
    );
    assert.equal(
      execute("pg_restore", ["--list", verifiedCopy]).status,
      0,
      "backup archive is not readable",
    );
    assert.equal(
      query(env.DATABASE_URL, "SELECT current_database()"),
      manifest.source.database,
      "source database differs from backup",
    );
    const roleSql = rolePrerequisitesSql(
      manifest.runtimeLogin.name,
      manifest.roleRoots,
    );
    const verifyRoles = () =>
      compareRolePrerequisites(manifest, JSON.parse(query(adminUrl, roleSql)));
    verifyRoles();
    assertExtensionAvailability(
      manifest.extensions,
      JSON.parse(query(adminUrl, AVAILABLE_EXTENSIONS_SQL)),
    );
    // No DROP, --clean, or IF NOT EXISTS: an occupied target is always refused.
    query(adminUrl, createDatabaseSql(manifest.databaseProperties, database));
    const marker = `meridian-restore-drill:${randomUUID()}`;
    query(
      adminUrl,
      `COMMENT ON DATABASE ${identifier(database)} IS ${literal(marker)}`,
    );
    const actual = JSON.parse(
      query(
        targetUrl,
        "SELECT json_build_object('database',current_database(),'marker',shobj_description(oid,'pg_database')) FROM pg_database WHERE datname=current_database()",
      ),
    );
    assert.deepEqual(
      actual,
      { database, marker },
      "target connection did not reach the newly created drill database",
    );
    compareDatabaseCreation(
      manifest.databaseProperties,
      JSON.parse(query(targetUrl, DATABASE_SNAPSHOT_SQL)),
      database,
    );
    const restored = execute(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-password",
        "--dbname",
        connection.url,
        verifiedCopy,
      ],
      { timeout: 14 * 60_000, env: connection.env },
    );
    assert.equal(restored.status, 0, "retained archive restore failed");
    query(adminUrl, restoreDatabaseSql(manifest.databaseProperties, database));
    compareDatabaseSnapshot(
      manifest.databaseProperties,
      JSON.parse(query(targetUrl, DATABASE_SNAPSHOT_SQL)),
      database,
    );
    compareExtensions(
      manifest.extensions,
      JSON.parse(query(targetUrl, INSTALLED_EXTENSIONS_SQL)),
    );
    verifyRoles();
    // Impersonation checks actual SET ROLE permissions without exporting passwords.
    // The isolated target connection must be its admin or the intended login.
    const probe = query(
      targetUrl,
      `BEGIN READ ONLY;
      SET LOCAL SESSION AUTHORIZATION ${identifier(manifest.runtimeLogin.name)};
      SET LOCAL ROLE meridian_app;
      SELECT json_build_object('sessionUser',session_user,'currentUser',current_user);
      ROLLBACK;`,
    );
    assert.deepEqual(
      JSON.parse(probe.split("\n").find((line) => line.startsWith("{"))),
      { sessionUser: manifest.runtimeLogin.name, currentUser: "meridian_app" },
      "intended runtime login could not assume meridian_app",
    );
    // The source may now be on a newer migration. Only the backup-time baseline is valid here.
    compareSecurityCatalog(manifest.catalog, catalog(targetUrl));
    for (const [table, rows] of Object.entries(manifest.rowCounts)) {
      assert.equal(
        query(
          targetUrl,
          `SELECT count(*)::text FROM public.${identifier(table)}`,
        ),
        rows,
        `restored count differs: ${table}`,
      );
    }
    const metadata = {
      evidenceVersion: 2,
      backupSha256: manifest.archive.sha256,
      snapshotSha256: manifest.snapshotSha256,
      backupManifestSha256: env.BACKUP_MANIFEST_SHA256,
      backupCreatedAt: manifest.createdAt,
      targetDatabase: database,
      durationSeconds: (Date.now() - started) / 1000,
      securityCatalogVerified: true,
      allTableCountsVerified: true,
    };
    recordRecoveryHeartbeat(env.DATABASE_URL, "restore_drill", metadata, query);
    log(
      `restore-drill: retained archive, backup-time catalog and all table counts verified in ${database}`,
    );
    log(
      "restore-drill: database retained for inspection; this tool never drops databases",
    );
    return metadata;
  } catch (error) {
    throw redactedPostgresError(
      error,
      sourceConnection,
      adminConnection,
      connection,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  restoreDrill().catch((error) => {
    console.error(`restore-drill: FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
