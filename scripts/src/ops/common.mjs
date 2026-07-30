// Shared plumbing for the ops scripts (backup / restore-drill / release).
// Node builtins + the Postgres client binaries (pg_dump / pg_restore / psql)
// only — no workspace or npm dependencies, so these run anywhere the DB is
// reachable, including a bare cron runner with nothing installed but node
// and postgresql-client.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

// Run a child process synchronously, capturing output. Never throws on a
// non-zero exit (callers decide); throws only when the binary cannot start.
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error) {
    throw new Error(`${cmd} could not be started: ${res.error.message}`);
  }
  return res;
}

// Single-statement query helper over the psql binary. -X skips psqlrc,
// -A -t gives bare machine-readable tuples, ON_ERROR_STOP makes SQL errors
// fatal. Throws (with stderr) on failure.
export function psql(url, sql) {
  const res = run("psql", [url, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql]);
  if (res.status !== 0) {
    throw new Error(`psql failed: ${(res.stderr || "").trim() || `exit ${res.status}`}`);
  }
  return res.stdout.trim();
}

// The migration-ledger summary — "count|max(version)" over
// _schema_migrations — that both restore-drill (source vs restored target)
// and release (database vs the migration registry) assert on. One home so
// the ledger's table name and summary shape can never drift between them.
export function migrationLedgerSummary(url) {
  return psql(
    url,
    "SELECT count(*) || '|' || coalesce(max(version), 0) FROM _schema_migrations",
  );
}

// Streaming sha256 so multi-GB dumps do not need to fit in memory.
export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Connection URL with the password masked — safe for logs.
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable connection URL>";
  }
}

export function dbNameFromUrl(raw) {
  return new URL(raw).pathname.replace(/^\//, "");
}

export function hostPortFromUrl(raw) {
  const u = new URL(raw);
  return `${u.hostname}:${u.port || "5432"}`;
}

// UTC timestamp that is filesystem-safe and lexically sortable:
// 2026-07-30T12:34:56.789Z -> 20260730T123456Z
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function fail(prefix, msg, code = 1) {
  console.error(`${prefix}: ${msg}`);
  process.exit(code);
}
