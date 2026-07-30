// MeridianIQ release sequencer: runs the exact production DB steps in order
// so the manual two-step disappears. The hazard this kills: `drizzle push`
// can drop the guardrail RLS policies/triggers (they are not in the Drizzle
// schema — they live in the numbered migrations), and they only come back
// when `migrate` re-asserts them. A push without an immediate migrate — or a
// forgotten migrate — leaves a window where tenant isolation is OFF. Here
// the two are one command, verified at the end.
//
// Sequence:
//   1. confirm     — refuses unless DATABASE_URL is set AND --yes is passed
//   2. backup      — optional pre-flight dump when RELEASE_BACKUP=1
//   3. push        — pnpm --filter @workspace/db run push   (what CI runs;
//                    RELEASE_PUSH_FORCE=1 swaps in `push-force` for
//                    destructive diffs, where plain push prompts and hangs)
//   4. migrate     — pnpm --filter @workspace/db run migrate
//   5. verify      — _schema_migrations count + max(version) must equal the
//                    registry in lib/db/src/migrations/index.ts; prints the
//                    API contract version to compare against /api/healthz
//                    after the Redeploy/restart.
//
// Any step failing aborts and lists the steps that did NOT run — finish them
// by hand or re-run once the cause is fixed (push and migrate are idempotent).
//
// Usage: DATABASE_URL=postgres://... pnpm --filter @workspace/scripts run ops:release -- --yes
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbNameFromUrl, fail, hostPortFromUrl, migrationLedgerSummary, redactUrl, run } from "./common.mjs";

const P = "release";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

// -- 1. confirm ---------------------------------------------------------------
const url = process.env.DATABASE_URL;
if (!url) {
  fail(P, "DATABASE_URL is not set. This script runs schema push + guardrail migrations against a live database — set DATABASE_URL explicitly to the release target.", 2);
}
if (!process.argv.includes("--yes")) {
  console.error(`${P}: target is ${hostPortFromUrl(url)} database "${dbNameFromUrl(url)}" (${redactUrl(url)})`);
  fail(P, "refusing to run without --yes. Re-run with:  pnpm --filter @workspace/scripts run ops:release -- --yes", 2);
}
console.log(`${P}: target ${hostPortFromUrl(url)} database "${dbNameFromUrl(url)}" (${redactUrl(url)})`);

// -- step runner --------------------------------------------------------------
const steps = [];
function step(name, fn) {
  steps.push({ name, fn });
}
function pnpmStep(name, args) {
  step(name, () => {
    const res = run("pnpm", args, { cwd: ROOT, stdio: "inherit", encoding: undefined });
    if (res.status !== 0) throw new Error(`pnpm ${args.join(" ")} exited ${res.status}`);
  });
}

// -- 2. optional pre-flight backup -------------------------------------------
if (process.env.RELEASE_BACKUP === "1") {
  step("pre-flight backup (RELEASE_BACKUP=1)", () => {
    const res = run(process.execPath, [path.join(HERE, "backup.mjs")], { stdio: "inherit", encoding: undefined });
    if (res.status !== 0) throw new Error(`backup.mjs exited ${res.status}`);
  });
} else {
  console.log(`${P}: pre-flight backup skipped (set RELEASE_BACKUP=1 to dump first)`);
}

// -- 3 + 4. push then migrate — the pair that must never be separated ---------
const pushScript = process.env.RELEASE_PUSH_FORCE === "1" ? "push-force" : "push";
pnpmStep(`schema push (db run ${pushScript})`, ["--filter", "@workspace/db", "run", pushScript]);
pnpmStep("guardrail migrations (db run migrate)", ["--filter", "@workspace/db", "run", "migrate"]);

// -- 5. verify ----------------------------------------------------------------
step("verify migrations + contract version", () => {
  // Expected shape comes from the migration registry source at runtime, so a
  // newly added migration can never leave this check stale.
  const registrySrc = readFileSync(path.join(ROOT, "lib/db/src/migrations/index.ts"), "utf8");
  const block = registrySrc.match(/export const migrations[^=]*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("could not locate the migrations array in lib/db/src/migrations/index.ts");
  const versions = [...block[1].matchAll(/migration0*(\d+)/g)].map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error("parsed zero migrations from the registry — refusing to verify against nothing");
  const expectedCount = versions.length;
  const expectedMax = Math.max(...versions);

  const got = migrationLedgerSummary(url);
  const want = `${expectedCount}|${expectedMax}`;
  if (got !== want) {
    throw new Error(`_schema_migrations mismatch: database has count|max ${got}, registry expects ${want}`);
  }
  console.log(`${P}: _schema_migrations OK — ${expectedCount} applied, max version ${expectedMax}`);

  const versionSrc = readFileSync(path.join(ROOT, "lib/api-zod/src/generated/version.ts"), "utf8");
  const contract = versionSrc.match(/API_CONTRACT_VERSION = "([^"]+)"/)?.[1] ?? "<unknown>";
  console.log(`${P}: API contract version ${contract} — after the Redeploy/restart, /api/healthz must report the same or the version-skew banner fires.`);
});

// -- run ----------------------------------------------------------------------
for (let i = 0; i < steps.length; i++) {
  const { name, fn } = steps[i];
  console.log(`${P}: [${i + 1}/${steps.length}] ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`${P}: STEP FAILED — ${name}: ${err.message}`);
    const remaining = steps.slice(i + 1).map((s) => s.name);
    if (remaining.length) {
      console.error(`${P}: steps NOT run: ${remaining.join("; ")}`);
      console.error(`${P}: the database may be mid-release (push without migrate drops guardrails) — fix the cause and re-run to completion.`);
    }
    process.exit(1);
  }
}
console.log(`${P}: done — push + migrate applied and verified.`);
