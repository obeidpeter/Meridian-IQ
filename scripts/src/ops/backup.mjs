// MeridianIQ backup tool: pg_dump (custom format) -> verify -> checksum -> prune.
//
// Run this OUTSIDE the app's failure domain — a cron/scheduler on the DB host
// or a separate runner, never the api-server process — and copy the dumps
// off-box: a backup sitting beside its database shares its fate (disk loss,
// region loss, a bad `rm -rf`). This tool does not schedule itself; your RPO
// is exactly as good as the cadence you run it on.
//
// Env:
//   DATABASE_URL  (required) connection to dump. Use a role that can bypass
//                 RLS (superuser/BYPASSRLS): several tables FORCE ROW LEVEL
//                 SECURITY and pg_dump fails closed on them for other roles —
//                 which is correct, a silently partial dump would be worse.
//   BACKUP_DIR    (default ./backups) where dumps land.
//   BACKUP_KEEP   (default 14) newest N dumps kept; older dumps + their
//                 .sha256 files are pruned.
//
// Usage: pnpm --filter @workspace/scripts run ops:backup
// Exit:  0 on success (dump written, verified, checksummed, retention applied);
//        non-zero on any failure. A dump that fails `pg_restore --list`
//        verification is deleted — an unlistable archive is not a backup.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, run, sha256File, utcStamp } from "./common.mjs";

const P = "backup";

const url = process.env.DATABASE_URL;
if (!url) {
  fail(P, "DATABASE_URL is not set — refusing to guess which database to dump. Set it to the Postgres connection string and re-run.", 2);
}

const dir = path.resolve(process.env.BACKUP_DIR || "./backups");
const keep = Number(process.env.BACKUP_KEEP ?? 14);
if (!Number.isInteger(keep) || keep < 1) {
  fail(P, `BACKUP_KEEP must be a positive integer (got ${JSON.stringify(process.env.BACKUP_KEEP)})`, 2);
}

mkdirSync(dir, { recursive: true });
const out = path.join(dir, `meridian-${utcStamp()}.dump`);

// 1. Dump (custom format: compressed, integrity-checked TOC, selective restore).
const dump = run("pg_dump", ["--format=custom", "--file", out, "--dbname", url]);
if (dump.status !== 0) {
  rmSync(out, { force: true });
  fail(P, `pg_dump failed (exit ${dump.status}): ${(dump.stderr || "").trim()}`);
}

// 2. Verify: an archive pg_restore cannot read the TOC of is not a backup.
const list = run("pg_restore", ["--list", out]);
if (list.status !== 0) {
  rmSync(out, { force: true });
  fail(P, `dump failed verification — pg_restore --list exited ${list.status}: ${(list.stderr || "").trim()} (dump deleted)`);
}
const tocEntries = list.stdout.split("\n").filter((l) => /^\d+;/.test(l)).length;
if (tocEntries === 0) {
  rmSync(out, { force: true });
  fail(P, "dump failed verification — pg_restore --list returned an empty TOC (dump deleted)");
}

// 3. Checksum, in `sha256sum -c`-compatible format, so off-box copies can be
//    verified after transfer.
const digest = await sha256File(out);
writeFileSync(`${out}.sha256`, `${digest}  ${path.basename(out)}\n`);

const size = statSync(out).size;
console.log(`${P}: wrote ${out} (${size} bytes, ${tocEntries} TOC entries)`);
console.log(`${P}: sha256 ${digest}`);

// 4. Retention: keep the newest BACKUP_KEEP dumps (the timestamped names sort
//    lexically), prune the rest along with their checksums.
const dumps = readdirSync(dir)
  .filter((f) => /^meridian-\d{8}T\d{6}Z\.dump$/.test(f))
  .sort()
  .reverse();
const pruned = dumps.slice(keep);
for (const f of pruned) {
  rmSync(path.join(dir, f), { force: true });
  rmSync(path.join(dir, `${f}.sha256`), { force: true });
}
console.log(
  `${P}: kept ${Math.min(dumps.length, keep)} dump(s), pruned ${pruned.length}` +
    (pruned.length ? ` (${pruned.join(", ")})` : ""),
);
