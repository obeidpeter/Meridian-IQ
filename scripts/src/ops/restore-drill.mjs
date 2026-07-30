// MeridianIQ restore drill: an untested backup is a hope, not a backup —
// this drill IS the test. Run it per-release (CI runs it on every merge):
// pg_dump the source -> sha256 round-trip -> drop/recreate the drill target
// -> pg_restore -> assert the migration ledger, sentinel row counts and the
// RLS posture all survived. The measured wall-clock it prints is your
// restore-time (RTO) shape at the current data volume.
//
// Env:
//   DATABASE_URL        (required) the SOURCE to dump (e.g. meridian_ci).
//                       Use a role that can bypass RLS (superuser/BYPASSRLS)
//                       or pg_dump fails closed on FORCE ROW LEVEL SECURITY
//                       tables and the row-count assertions see zero rows.
//   DRILL_DATABASE_URL  (required) the TARGET. THIS DATABASE IS DROPPED AND
//                       RECREATED — point it at a scratch name, never prod.
//   DRILL_ADMIN_URL     (optional) maintenance connection for DROP/CREATE
//                       DATABASE; defaults to DRILL_DATABASE_URL with the
//                       database swapped for `postgres`.
//
// Usage: pnpm --filter @workspace/scripts run ops:restore-drill
// Exit:  0 only when every assertion PASSes; 1 on any FAIL or step error.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbNameFromUrl, fail, hostPortFromUrl, migrationLedgerSummary, psql, redactUrl, run, sha256File } from "./common.mjs";

const P = "restore-drill";

const sourceUrl = process.env.DATABASE_URL;
const targetUrl = process.env.DRILL_DATABASE_URL;
if (!sourceUrl) fail(P, "DATABASE_URL (the source) is not set.", 2);
if (!targetUrl) {
  fail(P, "DRILL_DATABASE_URL (the scratch target) is not set. It will be DROPPED and recreated — point it at a scratch database.", 2);
}

const targetDb = dbNameFromUrl(targetUrl);
if (!/^[a-z_][a-z0-9_]*$/i.test(targetDb)) {
  fail(P, `refusing drill target database name ${JSON.stringify(targetDb)} — expected a plain identifier.`, 2);
}
// Never let the "drill" drop its own source.
if (targetDb === dbNameFromUrl(sourceUrl) && hostPortFromUrl(targetUrl) === hostPortFromUrl(sourceUrl)) {
  fail(P, "DRILL_DATABASE_URL points at the SOURCE database — refusing to drop it.", 2);
}

// Maintenance connection: you cannot drop a database you are connected to.
const adminUrl =
  process.env.DRILL_ADMIN_URL ||
  (() => {
    const u = new URL(targetUrl);
    u.pathname = "/postgres";
    return u.toString();
  })();

console.log(`${P}: source ${redactUrl(sourceUrl)}`);
console.log(`${P}: target ${redactUrl(targetUrl)} (will be dropped + recreated)`);

const t0 = Date.now();
const tmp = mkdtempSync(path.join(os.tmpdir(), "meridian-drill-"));
const dumpFile = path.join(tmp, "drill.dump");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

try {
  // 1. Dump the source (custom format).
  const dump = run("pg_dump", ["--format=custom", "--file", dumpFile, "--dbname", sourceUrl]);
  if (dump.status !== 0) fail(P, `pg_dump of source failed: ${(dump.stderr || "").trim()}`);
  const dumpSecs = ((Date.now() - t0) / 1000).toFixed(1);

  // 2. Integrity: the archive must list, and its checksum must round-trip
  //    (hash it, re-read it, hash again — catches torn writes/short reads
  //    before we bet a restore on it).
  const list = run("pg_restore", ["--list", dumpFile]);
  check("dump archive lists (pg_restore --list)", list.status === 0, (list.stderr || "").trim());
  const h1 = await sha256File(dumpFile);
  const h2 = await sha256File(dumpFile);
  check("sha256 round-trip stable", h1 === h2, h1 === h2 ? h1.slice(0, 16) : `${h1} != ${h2}`);
  if (failures) throw new Error("dump integrity failed — not attempting a restore from it");

  // 3. Drop + recreate the target via the maintenance connection.
  psql(adminUrl, `DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
  psql(adminUrl, `CREATE DATABASE "${targetDb}"`);

  // 4. Restore. --exit-on-error: a restore that limps past errors is not a
  //    proven restore path.
  const tRestore = Date.now();
  const restore = run("pg_restore", ["--exit-on-error", "--dbname", targetUrl, dumpFile]);
  check("pg_restore completed without error", restore.status === 0, (restore.stderr || "").trim().split("\n").pop() || "");
  if (restore.status !== 0) throw new Error("restore failed — skipping content assertions");
  const restoreSecs = ((Date.now() - tRestore) / 1000).toFixed(1);

  // 5. Content assertions, source vs restored target.
  const srcMig = migrationLedgerSummary(sourceUrl);
  const tgtMig = migrationLedgerSummary(targetUrl);
  check("_schema_migrations count|max(version) match", srcMig === tgtMig, `source ${srcMig}, target ${tgtMig}`);

  for (const table of ["invoices", "audit_events", "clerk_action_decisions"]) {
    const q = `SELECT count(*) FROM ${table}`;
    const src = psql(sourceUrl, q);
    const tgt = psql(targetUrl, q);
    check(`${table} row count matches`, src === tgt, `source ${src}, target ${tgt}`);
  }

  // 6. RLS posture: pg_restore carries ENABLE/FORCE ROW LEVEL SECURITY and
  //    CREATE POLICY — prove it, because a restore that silently sheds the
  //    tenant-isolation guardrails is a security incident, not a recovery.
  const rls = psql(targetUrl, "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'invoices'");
  check("invoices RLS enabled + forced on restored target", rls === "t", `got ${JSON.stringify(rls)}`);
  const policies = psql(targetUrl, "SELECT count(*) FROM pg_policy p JOIN pg_class c ON p.polrelid = c.oid WHERE c.relname = 'invoices'");
  check("invoices policies survived restore (count > 0)", Number(policies) > 0, `${policies} policy(ies)`);

  const totalSecs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${P}: dump ${dumpSecs}s, restore ${restoreSecs}s, total ${totalSecs}s`);
} catch (err) {
  console.error(`${P}: ${err.message}`);
  failures += 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`${P}: FAILED (${failures} failure(s)) — this backup path cannot be trusted for recovery.`);
  process.exit(1);
}
console.log(`${P}: OK — backup/restore round-trip proven.`);
