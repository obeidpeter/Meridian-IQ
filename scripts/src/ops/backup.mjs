// Portable operator backup: Node + psql/pg_dump/pg_restore, with one held MVCC snapshot.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostPortFromUrl,
  postgresConnection,
  redactedPostgresError,
  psql,
  run,
  sha256File,
  utcStamp,
} from "./common.mjs";
import { withBackupSnapshot } from "./backup-snapshot.mjs";
import {
  runtimeRoleName,
  assertPrerequisites,
} from "./backup-prerequisites.mjs";
import { syncBackupDirectory } from "./backup-durability.mjs";
import {
  validateDatabaseSnapshot,
  databaseRoleRoots,
} from "./backup-database.mjs";
import {
  privateBackupDirectory,
  recordRecoveryHeartbeat,
  sha256,
  snapshotDigest,
} from "./recovery-evidence.mjs";

export function pruneBackups(directory, keep, current) {
  const entries = new Set(readdirSync(directory));
  const names = [...entries]
    .filter((name) => /^meridian-\d{8}T\d{6}Z-[a-f0-9]{32}\.dump$/.test(name))
    .sort()
    .reverse();
  // Refuse symlinks/non-files before removing any member of a retained bundle.
  for (const name of names)
    for (const suffix of ["", ".sha256", ".manifest.json"]) {
      const file = path.join(directory, name + suffix);
      try {
        const stat = lstatSync(file);
        assert.ok(
          stat.isFile() && !stat.isSymbolicLink(),
          "unsafe backup retention entry",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  const complete = names.filter(
    (name) =>
      entries.has(`${name}.manifest.json`) && entries.has(`${name}.sha256`),
  );
  const retained = new Set([
    current,
    ...complete.filter((name) => name !== current).slice(0, keep - 1),
  ]);
  for (const name of complete.filter((name) => !retained.has(name)))
    for (const suffix of ["", ".sha256", ".manifest.json"])
      rmSync(path.join(directory, name + suffix), { force: true });
}

export async function backup(env = process.env, dependencies = {}) {
  assert.ok(env.DATABASE_URL, "DATABASE_URL is required");
  const runtimeRole = runtimeRoleName(env.BACKUP_RUNTIME_ROLE);
  const connection = postgresConnection(env.DATABASE_URL);
  const directory = privateBackupDirectory(env.BACKUP_DIR);
  const keep = Number(env.BACKUP_KEEP ?? 14);
  assert.ok(Number.isInteger(keep) && keep > 0, "BACKUP_KEEP must be positive");
  const execute = dependencies.run ?? run;
  const snapshot = dependencies.snapshot ?? withBackupSnapshot;
  const query = dependencies.query ?? psql;
  const log = dependencies.log ?? console.log;
  const syncFile = dependencies.syncFile ?? fsyncSync;
  const syncDirectory = dependencies.syncDirectory ?? syncBackupDirectory;
  const writeSynced = (file, bytes) => {
    const fileFd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fileFd, bytes);
      syncFile(fileFd, file);
    } finally {
      closeSync(fileFd);
    }
  };
  const out = path.join(
    directory,
    `meridian-${utcStamp()}-${randomUUID().replaceAll("-", "")}.dump`,
  );
  const manifestFile = `${out}.manifest.json`;
  let fd;
  let ownsArchive = false;
  let retainArchive = false;
  const lock = path.join(directory, ".meridian-backup-operation.lock");
  // Serialize this directory before any snapshot can be taken. An occupied or
  // abandoned lock refuses without touching another invocation's files.
  const operation = openSync(lock, "wx", 0o600);
  try {
    fd = openSync(out, "wx", 0o600);
    ownsArchive = true;
    const baseline = await snapshot(
      env.DATABASE_URL,
      async (baseline) => {
        assertPrerequisites(baseline);
        assert.equal(baseline.runtimeLogin.name, runtimeRole);
        validateDatabaseSnapshot(baseline.databaseProperties);
        assert.equal(baseline.databaseProperties.database, baseline.database);
        for (const role of databaseRoleRoots(baseline.databaseProperties))
          assert.ok(
            baseline.roleRoots.includes(role),
            "database role prerequisite missing",
          );
        // Write to an exclusively opened descriptor, never truncate/follow a path.
        const result = execute(
          "pg_dump",
          [
            "--format=custom",
            "--no-password",
            "--snapshot",
            baseline.snapshot,
            "--dbname",
            connection.url,
          ],
          {
            stdio: ["ignore", fd, "pipe"],
            timeout: 14 * 60_000,
            env: connection.env,
          },
        );
        assert.equal(
          result.status,
          0,
          "pg_dump failed; no backup evidence recorded",
        );
        assert.ok(fstatSync(fd).size > 0, "empty backup archive");
        // pg_dump writes to stdout here, so it does not sync this archive for us.
        syncFile(fd, out);
        return baseline;
      },
      runtimeRole,
    );
    const opened = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    const stat = lstatSync(out);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.dev === opened.dev &&
        stat.ino === opened.ino,
      "backup archive was replaced",
    );
    const list = execute("pg_restore", ["--list", out]);
    assert.equal(list.status, 0, "backup archive cannot be listed");
    const tocEntries = list.stdout
      .split("\n")
      .filter((line) => /^\d+;/.test(line)).length;
    assert.ok(tocEntries > 0, "backup archive has an empty TOC");
    const digest = await sha256File(out);
    retainArchive = true;
    const manifest = {
      format: 2,
      createdAt: baseline.createdAt,
      source: {
        database: baseline.database,
        endpoint: hostPortFromUrl(env.DATABASE_URL),
      },
      archive: {
        file: path.basename(out),
        sha256: digest,
        bytes: stat.size,
        tocEntries,
      },
      catalog: baseline.catalog,
      roles: baseline.roles,
      roleRoots: baseline.roleRoots,
      memberships: baseline.memberships,
      runtimeLogin: baseline.runtimeLogin,
      extensions: baseline.extensions,
      databaseProperties: baseline.databaseProperties,
      rowCounts: baseline.rowCounts,
      snapshotSha256: snapshotDigest(baseline),
    };
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    const manifestSha256 = sha256(manifestBytes);
    writeSynced(manifestFile, manifestBytes);
    writeSynced(`${out}.sha256`, `${digest}  ${path.basename(out)}\n`);
    syncDirectory(directory);
    const metadata = {
      evidenceVersion: 2,
      file: path.basename(out),
      manifestFile: path.basename(manifestFile),
      sha256: digest,
      snapshotSha256: manifest.snapshotSha256,
      manifestSha256,
      bytes: stat.size,
      tocEntries,
      createdAt: baseline.createdAt,
    };
    recordRecoveryHeartbeat(env.DATABASE_URL, "backup", metadata, query);
    pruneBackups(directory, keep, path.basename(out));
    log(`backup: retained ${out}`);
    log(`backup: trusted producer manifest SHA256 ${manifestSha256}`);
    // CI consumes the checksum directly from this trusted producer step, not a sidecar.
    if (env.GITHUB_ACTIONS === "true" && env.GITHUB_OUTPUT) {
      assert.ok(!/[\r\n]/.test(manifestFile));
      appendFileSync(
        env.GITHUB_OUTPUT,
        `manifest=${manifestFile}\nmanifest_sha256=${manifestSha256}\n`,
      );
    }
    return { manifestFile, manifestSha256, manifest, metadata };
  } catch (error) {
    if (retainArchive)
      log(
        `backup: verified archive retained after failure at ${out}; inspect publication status`,
      );
    throw redactedPostgresError(error, connection);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
      if (ownsArchive && !retainArchive)
        for (const file of [out, `${out}.sha256`, manifestFile])
          rmSync(file, { force: true });
    } finally {
      closeSync(operation);
      rmSync(lock);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  backup().catch((error) => {
    console.error(`backup: FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
