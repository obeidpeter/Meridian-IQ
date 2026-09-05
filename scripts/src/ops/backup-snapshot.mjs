import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CATALOG_SQL, assertSecurityCatalog } from "./security-catalog.mjs";
import { OPS_OUTPUT_LIMIT, postgresConnection } from "./common.mjs";
import {
  assertPrerequisites,
  INSTALLED_EXTENSIONS_SQL,
  rolePrerequisitesSql,
} from "./backup-prerequisites.mjs";
import {
  DATABASE_SNAPSHOT_SQL,
  databaseRoleRoots,
  validateDatabaseSnapshot,
} from "./backup-database.mjs";

export const snapshotSql = (
  runtimeRole,
) => `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '15min';
SELECT json_build_object('snapshot', pg_export_snapshot(),
  'database', current_database(), 'createdAt', transaction_timestamp());
${CATALOG_SQL}
${rolePrerequisitesSql(runtimeRole)}
${INSTALLED_EXTENSIONS_SQL}
${DATABASE_SNAPSHOT_SQL}
SELECT format('SELECT json_build_object(''table'', %L, ''rows'', count(*)::text) FROM public.%I', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname
\\gexec
SELECT 'MERIDIAN_BACKUP_SNAPSHOT_READY';
`;

export function parseSnapshot(lines) {
  const [
    identity,
    catalog,
    prerequisites,
    extensions,
    databaseProperties,
    ...counts
  ] = lines.map((line) => JSON.parse(line));
  assert.match(identity.snapshot, /^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/);
  assert.equal(typeof identity.database, "string");
  assert.ok(Number.isFinite(Date.parse(identity.createdAt)));
  assertSecurityCatalog(catalog);
  const rowCounts = Object.fromEntries(
    counts.map(({ table, rows }) => {
      assert.equal(typeof table, "string");
      assert.match(rows, /^\d+$/);
      return [table, rows];
    }),
  );
  assert.equal(Object.keys(rowCounts).length, counts.length, "duplicate count");
  assert.deepEqual(
    Object.keys(rowCounts).sort(),
    catalog.tables.map((t) => t.name).sort(),
  );
  assertPrerequisites({ ...prerequisites, extensions });
  validateDatabaseSnapshot(databaseProperties);
  assert.equal(databaseProperties.database, identity.database);
  for (const role of databaseRoleRoots(databaseProperties))
    assert.ok(
      prerequisites.roleRoots.includes(role),
      "database ACL/settings role missing from snapshot roots",
    );
  return {
    ...identity,
    catalog,
    ...prerequisites,
    extensions,
    databaseProperties,
    rowCounts,
  };
}

// Keep the exporting session open until pg_dump has imported and used its snapshot.
// psql is deliberately the only database dependency of these operator scripts.
export async function withBackupSnapshot(
  url,
  useSnapshot,
  runtimeRole,
  launch = spawn,
) {
  const sql = snapshotSql(runtimeRole);
  const connection = postgresConnection(url);
  const child = launch(
    "psql",
    [connection.url, "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: connection.env,
    },
  );
  let ended = false;
  let buffer = "";
  let bytes = 0;
  const lines = [];
  const closed = new Promise((resolve) =>
    child.once("close", (code) => {
      ended = true;
      resolve(code);
    }),
  );
  let timer;
  const ready = new Promise((resolve, reject) => {
    const abort = (message) => {
      reject(new Error(message));
      child.kill();
    };
    timer = setTimeout(
      () => abort("backup snapshot capture timed out"),
      120_000,
    );
    child.once("error", () => abort("could not start backup snapshot psql"));
    child.stdin.on("error", () => abort("backup snapshot input closed"));
    child.once("close", (code) =>
      reject(new Error(`backup snapshot exited before completion (${code})`)),
    );
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > OPS_OUTPUT_LIMIT)
        abort("backup snapshot output limit exceeded");
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OPS_OUTPUT_LIMIT)
        return abort("backup snapshot output limit exceeded");
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "MERIDIAN_BACKUP_SNAPSHOT_READY") {
          clearTimeout(timer);
          try {
            resolve(parseSnapshot(lines));
          } catch (error) {
            reject(error);
          }
        } else if (line) lines.push(line);
      }
    });
    child.stdin.write(sql);
  });
  try {
    const snapshot = await ready;
    const result = await useSnapshot(snapshot);
    assert.equal(ended, false, "exported snapshot session ended during backup");
    child.stdin.end("ROLLBACK;\n\\quit\n");
    assert.equal(await closed, 0, "backup snapshot session failed");
    return result;
  } finally {
    clearTimeout(timer);
    if (!ended) child.kill();
    await closed;
  }
}
