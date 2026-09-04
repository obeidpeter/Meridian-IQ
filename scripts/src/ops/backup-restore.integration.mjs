import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup } from "./backup.mjs";
import { withBackupSnapshot } from "./backup-snapshot.mjs";
import { restoreDrill } from "./restore-drill.mjs";
import { psql } from "./common.mjs";
import { recordRecoveryHeartbeat } from "./recovery-evidence.mjs";
import {
  DATABASE_SNAPSHOT_SQL,
  compareDatabaseSnapshot,
} from "./backup-database.mjs";

const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const literal = (value) =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

test("retained archive and baseline share MVCC snapshot despite later data and schema changes", async () => {
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "disposable real PostgreSQL required",
  );
  assert.ok(process.env.DATABASE_URL);
  const source = process.env.DATABASE_URL;
  const id = randomUUID().replaceAll("-", "");
  const table = `backup_snapshot_${id}`;
  const target = `meridian_drill_${id}`;
  const runtimeRole = `meridian_probe_${id}`;
  const targetUrl = new URL(source);
  targetUrl.pathname = `/${target}`;
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "meridian-backup-integration-"),
  );
  let created = false;
  let roleCreated = false;
  let initialDatabase;
  let metadataChanged = false;
  try {
    initialDatabase = JSON.parse(psql(source, DATABASE_SNAPSHOT_SQL));
    psql(
      source,
      `CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    psql(source, `GRANT meridian_app TO ${runtimeRole} WITH SET TRUE`);
    metadataChanged = true;
    psql(
      source,
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${identifier(initialDatabase.database)} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${identifier(initialDatabase.database)} TO ${runtimeRole};
      ALTER DATABASE ${identifier(initialDatabase.database)} SET application_name TO 'meridian-backup-fixture';
      ALTER ROLE ${runtimeRole} IN DATABASE ${identifier(initialDatabase.database)} SET search_path TO public, pg_catalog;`,
    );
    psql(source, `CREATE TABLE public.${table} (id integer PRIMARY KEY)`);
    created = true;
    const saved = await backup(
      {
        DATABASE_URL: source,
        BACKUP_DIR: directory,
        BACKUP_RUNTIME_ROLE: runtimeRole,
      },
      {
        snapshot: (url, use, login) =>
          withBackupSnapshot(
            url,
            async (baseline) => {
              assert.equal(baseline.rowCounts[table], "0");
              // Commit AFTER snapshot export, BEFORE pg_dump imports that same snapshot.
              psql(source, `INSERT INTO public.${table} VALUES (1)`);
              return use(baseline);
            },
            login,
          ),
      },
    );
    const drillEnv = {
      DATABASE_URL: source,
      BACKUP_MANIFEST: saved.manifestFile,
      BACKUP_MANIFEST_SHA256: saved.manifestSha256,
      DRILL_DATABASE_DISPOSABLE: "1",
      DRILL_CONFIRM_TARGET: target,
      DRILL_DATABASE_URL: targetUrl.toString(),
    };
    // Even on the same CI cluster, its superuser connection must not hide a
    // missing incoming runtime membership. Refusal must happen before CREATE DB.
    psql(source, `REVOKE meridian_app FROM ${runtimeRole}`);
    assert.equal(
      psql(source, `SELECT pg_has_role('${runtimeRole}','meridian_app','SET')`),
      "f",
    );
    await assert.rejects(
      restoreDrill(drillEnv),
      /prerequisites differ|capability differs/,
    );
    assert.equal(
      psql(
        source,
        `SELECT count(*) FROM pg_database WHERE datname='${target}'`,
      ),
      "0",
    );
    psql(source, `GRANT meridian_app TO ${runtimeRole} WITH SET TRUE`);
    const heartbeatSql =
      "SELECT row_to_json(h) FROM operational_heartbeats h WHERE key='backup'";
    const currentHeartbeat = psql(source, heartbeatSql);
    assert.throws(
      () =>
        recordRecoveryHeartbeat(source, "backup", {
          ...saved.metadata,
          createdAt: new Date(
            Date.parse(saved.metadata.createdAt) - 60_000,
          ).toISOString(),
        }),
      /refusing older backup snapshot/,
    );
    assert.equal(
      psql(source, heartbeatSql),
      currentHeartbeat,
      "older publication must preserve newer evidence and completion time",
    );
    psql(source, `ALTER TABLE public.${table} ADD COLUMN after_backup text`);
    const evidence = await restoreDrill(drillEnv);
    assert.equal(evidence.evidenceVersion, 2);
    compareDatabaseSnapshot(
      saved.manifest.databaseProperties,
      JSON.parse(psql(targetUrl.toString(), DATABASE_SNAPSHOT_SQL)),
      target,
    );
    assert.equal(evidence.backupSha256, saved.metadata.sha256);
    assert.equal(evidence.snapshotSha256, saved.metadata.snapshotSha256);
    assert.equal(
      psql(targetUrl.toString(), `SELECT count(*) FROM public.${table}`),
      "0",
    );
    assert.equal(psql(source, `SELECT count(*) FROM public.${table}`), "1");
  } finally {
    if (created) psql(source, `DROP TABLE public.${table}`);
    if (metadataChanged) {
      const database = identifier(initialDatabase.database);
      psql(
        source,
        `REVOKE CONNECT ON DATABASE ${database} FROM ${runtimeRole};
        ALTER ROLE ${runtimeRole} IN DATABASE ${database} RESET ALL;
        REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC;`,
      );
      for (const acl of initialDatabase.acl.filter(
        (entry) =>
          entry.grantee === null &&
          ["CONNECT", "TEMPORARY"].includes(entry.privilege),
      ))
        psql(
          source,
          `GRANT ${acl.privilege} ON DATABASE ${database} TO PUBLIC`,
        );
      const previous = initialDatabase.settings.find(
        (setting) =>
          setting.role === null && setting.name === "application_name",
      );
      psql(
        source,
        previous
          ? `ALTER DATABASE ${database} SET application_name TO ${literal(previous.value)}`
          : `ALTER DATABASE ${database} RESET application_name`,
      );
    }
    if (roleCreated) {
      psql(source, `REVOKE meridian_app FROM ${runtimeRole}`);
      // A restored database may reference this fixture role in its ACL/settings.
      // Retain both for CI service teardown; never CASCADE or drop an arbitrary DB.
      if (
        psql(
          source,
          `SELECT count(*) FROM pg_database WHERE datname='${target}'`,
        ) === "0"
      )
        psql(source, `DROP ROLE ${runtimeRole}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
