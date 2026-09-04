// Shared plumbing for the ops scripts (backup / restore-drill / release).
// Node builtins + the Postgres client binaries (pg_dump / pg_restore / psql)
// only — no workspace or npm dependencies, so these run anywhere the DB is
// reachable, including a bare cron runner with nothing installed but node
// and postgresql-client.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

// Two full schema/security catalogs exceed Node's default 1 MiB pipe limit.
export const OPS_OUTPUT_LIMIT = 16 * 1024 * 1024;

// Run a child process synchronously, capturing output. Never throws on a
// non-zero exit (callers decide); throws only when the binary cannot start.
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: OPS_OUTPUT_LIMIT,
    windowsHide: true,
    ...opts,
  });
  if (res.error) {
    throw new Error(`${cmd} could not be started: ${res.error.message}`);
  }
  return res;
}

// Single-statement query helper over the psql binary. -X skips psqlrc,
// -A -t gives bare machine-readable tuples, ON_ERROR_STOP makes SQL errors
// fatal. Throws (with stderr) on failure.
export function postgresConnection(raw, environment = process.env) {
  let url;
  try {
    url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("invalid PostgreSQL connection URL");
  }
  for (const key of url.searchParams.keys())
    if (/password|passfile|service/i.test(key))
      throw new Error(
        "password/service connection query parameters are not permitted",
      );
  const encoded = url.password;
  let password;
  try {
    password = encoded ? decodeURIComponent(encoded) : environment.PGPASSWORD;
  } catch {
    throw new Error("invalid PostgreSQL password encoding");
  }
  url.password = "";
  const env = { ...environment };
  if (password !== undefined) env.PGPASSWORD = password;
  else delete env.PGPASSWORD;
  const secrets = [
    ...new Set(
      [raw, encoded, password].filter(
        (value) => typeof value === "string" && value.length,
      ),
    ),
  ];
  return {
    url: url.toString(),
    env,
    redact: (message) =>
      secrets.reduce(
        (text, secret) => text.replaceAll(secret, "[redacted]"),
        String(message),
      ),
  };
}

export function redactedPostgresError(error, ...connections) {
  const redact = (value) =>
    connections.reduce(
      (text, connection) => connection.redact(text),
      String(value),
    );
  // Preserve useful cause/stack context without retaining a credential-bearing
  // original Error object anywhere in the exception chain.
  const cause = new Error(redact(error.stack ?? error.message));
  return new Error(redact(error.message), { cause });
}

export function psql(url, sql, execute = run) {
  const connection = postgresConnection(url);
  let res;
  try {
    res = execute(
      "psql",
      [
        connection.url,
        "-X",
        "-A",
        "-t",
        "-w",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { env: connection.env },
    );
  } catch (error) {
    throw redactedPostgresError(error, connection);
  }
  if (res.status !== 0) {
    throw new Error(
      connection.redact(
        `psql failed: ${(res.stderr || "").trim() || `exit ${res.status}`}`,
      ),
    );
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
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function fail(prefix, msg, code = 1) {
  console.error(`${prefix}: ${msg}`);
  process.exit(code);
}
