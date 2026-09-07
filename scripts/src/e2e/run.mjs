// E2E harness: boots the conformance fake rail, then the BUILT api-server
// (stamping over HTTP through that rail) and the BUILT frontends behind a
// path-router (mirroring the production origin), then drives the user
// journeys headless. Requires DATABASE_URL pointing at a scratch database —
// the server seeds demo data at boot and journeys assume that seed.
//
//   pnpm --filter @workspace/scripts run e2e
//
// Prerequisites (CI builds these in earlier steps):
//   node scripts/src/ops/mobile-artifact.mjs build
//   node scripts/src/ops/mobile-artifact.mjs check
//   pnpm --filter @workspace/api-server run build
//   BASE_PATH=/ PORT=1 pnpm --filter @workspace/landing run build
//   BASE_PATH=/console/ PORT=1 pnpm --filter @workspace/console run build
//   BASE_PATH=/app/ PORT=1 pnpm --filter @workspace/sme-compliance run build
//   BASE_PATH=/buyer/ PORT=1 pnpm --filter @workspace/buyer-portal run build
//   BASE_PATH=/penalty-calculator/ PORT=1 pnpm --filter @workspace/penalty-calculator run build
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { EXPECTED_E2E_CHECKS } from "./expected-count.mjs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStaticServer, startWebhookReceiver } from "./serve.mjs";
import { runJourneys } from "./journeys/index.mjs";
import { DEMO_PASSWORD } from "./journeys/shared.mjs";
import { stampManifest } from "../ops/build-manifest.mjs";
import { verifyDeployment } from "../ops/postdeploy.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const API_PORT = Number(process.env.E2E_API_PORT ?? 5100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8091);
// Local receiver the integration journey registers a firm webhook against.
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 8093);
// The conformance fake rail (R95): the api-server's rail_primary points at it
// so the WHOLE run stamps over HTTP through a scriptable access point — the
// boot-time transport selection is proven end to end, not just in unit tests.
const RAIL_PORT = Number(process.env.E2E_RAIL_PORT ?? 5199);
const RAIL_URL = `http://127.0.0.1:${RAIL_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

if (process.env.E2E_DATABASE_DISPOSABLE !== "1" || !process.env.DATABASE_URL) {
  throw new Error(
    "E2E requires a migrated scratch DATABASE_URL and E2E_DATABASE_DISPOSABLE=1; never point it at serving data",
  );
}

// Machine-rail credentials, defined once: set on the api-server env below
// AND threaded into runJourneys, so the server and the journeys cannot
// drift. The collections rail runs on a KEY RING (R100: the provider signs
// each request with a key id, timestamp and body HMAC); the payment webhook
// and the sweep trigger keep the pre-key-ring single token, so both halves
// of the dual path are exercised.
const PAYMENT_WEBHOOK_TOKEN = "e2e-pay-hook";
const COLLECTION_WEBHOOK_KEY = {
  id: "e2e-k1",
  secret: "e2e-collect-hook-signing-secret-0123456789",
};
const COLLECTION_WEBHOOK_KEYS = `${COLLECTION_WEBHOOK_KEY.id}:${COLLECTION_WEBHOOK_KEY.secret}`;
const SWEEP_TOKEN = "e2e-sweep-trigger";
// The bearer the fake rail demands and the api-server presents on every
// submission (RAIL_PRIMARY_TOKEN): an unauthorized call would surface as
// RAIL_UNAUTHORIZED retries, so the credential half of the transport is
// exercised by every stamping in the run.
const FAKE_RAIL_TOKEN = "e2e-rail-token";

const REQUIRED = [
  "artifacts/api-server/dist/index.mjs",
  "artifacts/landing/dist/public/index.html",
  "artifacts/console/dist/public/index.html",
  "artifacts/sme-compliance/dist/public/index.html",
  "artifacts/buyer-portal/dist/public/index.html",
  "artifacts/penalty-calculator/dist/public/index.html",
];

function fail(msg) {
  console.error(`E2E: ${msg}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail(
    "DATABASE_URL must point at a scratch Postgres database (it will be seeded).",
  );
}
for (const rel of REQUIRED) {
  if (!existsSync(path.join(ROOT, rel))) {
    fail(
      `missing build artifact ${rel} — run the builds listed at the top of run.mjs.`,
    );
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

// Poll a health URL until it answers 2xx (both spawned processes print a
// ready line, but a port that ANSWERS is the only readiness that matters).
async function waitForOk(url, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not become healthy in time`);
}

const tail = (log, lines) => log.split("\n").slice(-lines).join("\n");

// Readiness is a RACE between the health poll and the child itself dying:
// a spawn error (ENOENT on the tsx shim) or an early exit (EADDRINUSE on
// the port, a crash at boot) must reject NOW with the cause and the child's
// log tail, not after the 30 s poll gives up. The listeners are detached
// once the race settles so a later, deliberate SIGTERM never surfaces as a
// stray rejection.
async function untilHealthy(child, what, url, log) {
  let onError;
  let onExit;
  const died = new Promise((_, reject) => {
    onError = (err) =>
      reject(
        new Error(
          `${what} could not be spawned: ${err.code ?? err.message}\n--- ${what} log tail ---\n${tail(log(), 10)}`,
        ),
      );
    onExit = (code, signal) =>
      reject(
        new Error(
          `${what} exited before it became healthy (${signal ? `signal ${signal}` : `exit code ${code}`})\n--- ${what} log tail ---\n${tail(log(), 10)}`,
        ),
      );
    child.once("error", onError);
    child.once("exit", onExit);
  });
  try {
    await Promise.race([waitForOk(url, what), died]);
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

// Wait (briefly) for a signalled child to actually leave, so its final log
// lines land before the noise report below reads the buffers.
function exited(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// pino writes JSON in production ({"level":40|50,…}) and pino-pretty text in
// development (`WARN (pid): msg`, coloured, with the payload indented on the
// lines that follow). Both shapes are kept, ANSI stripped, continuation
// lines attached to the warning they belong to.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function isWarnOrError(line) {
  if (!line.startsWith("{")) return /\b(WARN|ERROR|FATAL)\b/.test(line);
  try {
    return Number(JSON.parse(line).level) >= 40;
  } catch {
    return false;
  }
}
function warnOrErrorLines(log) {
  const kept = [];
  let carry = false;
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "");
    if (line.trim() === "") {
      carry = false;
      continue;
    }
    if (isWarnOrError(line)) {
      kept.push(line);
      carry = true;
    } else if (carry && /^\s/.test(line)) {
      kept.push(line);
    } else {
      carry = false;
    }
  }
  return kept;
}

const NOISE_CAP = 60;
function printCapped(heading, lines) {
  const shown = lines.slice(-NOISE_CAP);
  const elided = lines.length - shown.length;
  console.error(
    `--- ${heading} (${lines.length}${elided ? `, last ${shown.length} shown` : ""}) ---`,
  );
  console.error(shown.length ? shown.join("\n") : "(none)");
}

// Prefer an explicitly provided browser, then the preinstalled one, then
// playwright's own download (CI runs `playwright install chromium`).
function browserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (existsSync("/opt/pw-browsers/chromium"))
    return "/opt/pw-browsers/chromium";
  return undefined;
}

// The fake rail is a dev tool, not part of the api-server's built dist: it
// runs from source via tsx (a workspace dev dependency, so CI has it after
// `pnpm install`). It boots FIRST and must answer before the api-server is
// spawned, so the server's first rail call never races the rail's listen.
const rail = spawn(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("tsx/cli"),
    "artifacts/api-server/src/fake-rail-main.ts",
  ],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(RAIL_PORT), FAKE_RAIL_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let railLog = "";
let railErr = "";
rail.stdout.on("data", (d) => (railLog += d));
rail.stderr.on("data", (d) => {
  railLog += d;
  railErr += d;
});
// A ChildProcess with no "error" listener throws the spawn error as an
// uncaught exception; keep it in the log so the readiness race reports it.
rail.on("error", (err) => (railLog += `[spawn] ${err.message}\n`));

let api;
let apiLog = "";
let staticServer;
let hookReceiver;
let browser;
let exitCode;
try {
  await untilHealthy(
    rail,
    "fake rail",
    `${RAIL_URL}/__fake/healthz`,
    () => railLog,
  );

  api = spawn(
    "node",
    ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(API_PORT),
        NODE_ENV: "development",
        SEED_DEMO: "true",
        DEMO_PASSWORD,
        // The suite signs in as many roles from one loopback address. Preserve
        // the per-credential throttle assertions while preventing the aggregate
        // production IP cap from terminating unrelated later journeys.
        LOGIN_IP_ATTEMPT_MAX: "1000",
        // Lights the payment-confirmation machine rail (fail-closed: 404 while
        // unset). The env is read per call server-side; the integration journey
        // presents this token as x-op-token to settle its payment intent.
        PAYMENT_WEBHOOK_TOKEN,
        // Lights the inbound collection webhook (same fail-closed posture: the
        // rail 404s while its ring is empty). The collections journey SIGNS its
        // settlement with this key (x-op-key-id / x-op-timestamp /
        // x-op-signature) and also proves the legacy x-op-token path still
        // admits the ring's secret.
        COLLECTION_WEBHOOK_KEYS,
        // Lights /api/internal/sweep (fail-closed: 404 while unset). The
        // integration journey polls the sweep to drain the pipeline + webhook
        // outbox synchronously, presenting this token as x-op-token.
        SWEEP_TOKEN,
        // Binds the HTTP rail transport to the fake rail for rail_primary ONLY
        // (RAIL_SECONDARY_URL deliberately unset): one lit rail, so
        // /operator/rail-config shows rail_secondary Dark and every stamping
        // in the run rides rail_primary over HTTP. The environment is stamp
        // provenance, never inferred from the URL.
        RAIL_PRIMARY_URL: RAIL_URL,
        RAIL_PRIMARY_TOKEN: FAKE_RAIL_TOKEN,
        RAIL_ENVIRONMENT: "sandbox",
        // Pinned EMPTY (httpRailConfigFromEnv trims empties to unset) so a
        // developer shell that exports a secondary rail or a custom timeout
        // cannot light rail_secondary or reshape the run's transport.
        RAIL_SECONDARY_URL: "",
        RAIL_SECONDARY_TOKEN: "",
        RAIL_TIMEOUT_MS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  api.stdout.on("data", (d) => (apiLog += d));
  api.stderr.on("data", (d) => (apiLog += d));
  api.on("error", (err) => (apiLog += `[spawn] ${err.message}\n`));

  await untilHealthy(
    api,
    "api-server",
    `http://127.0.0.1:${API_PORT}/api/healthz`,
    () => apiLog,
  );
  staticServer = await startStaticServer({ port: WEB_PORT, apiPort: API_PORT });
  hookReceiver = await startWebhookReceiver({ port: HOOK_PORT });

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
  });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 },
  });

  await runJourneys(page, BASE, check, {
    hookReceiver,
    paymentWebhookToken: PAYMENT_WEBHOOK_TOKEN,
    collectionWebhookKey: COLLECTION_WEBHOOK_KEY,
    sweepToken: SWEEP_TOKEN,
    fakeRailUrl: RAIL_URL,
    fakeRailToken: FAKE_RAIL_TOKEN,
  });

  const failed = results.filter((r) => !r.ok);
  if (process.env.GITHUB_ACTIONS === "true" && failed.length === 0) {
    await verifyDeployment(BASE, stampManifest());
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  exitCode = failed.length ? 1 : 0;
  if (results.length !== EXPECTED_E2E_CHECKS) {
    const drift = `e2e check count is ${results.length}; the documented count (scripts/src/e2e/expected-count.mjs) is ${EXPECTED_E2E_CHECKS} — update the constant and the docs together`;
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(drift);
      exitCode = exitCode || 1;
    } else console.warn(drift);
  }
} catch (err) {
  console.error("E2E crashed:", err);
  console.error(
    "--- api-server log tail ---\n" + apiLog.split("\n").slice(-30).join("\n"),
  );
  console.error(
    "--- fake rail log tail ---\n" + railLog.split("\n").slice(-30).join("\n"),
  );
  exitCode = 2;
} finally {
  if (exitCode !== 0) {
    const output = path.join(ROOT, "test-results");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "api-server.log"), apiLog);
    writeFileSync(path.join(output, "fake-rail.log"), railLog);
  }
  await browser?.close().catch(() => {});
  hookReceiver?.close();
  staticServer?.close();
  api?.kill("SIGTERM");
  rail.kill("SIGTERM");
  await Promise.all([exited(api), exited(rail)]);
}
// On EVERY exit path — a green run included — surface what the api-server
// warned or errored about (rail-transport warnings ride this channel: an
// unexpected rail answer, a refused credential, a redirect) and anything the
// fake rail wrote to stderr. The crash tails above stay as they are; this is
// the signal a passing run would otherwise bury.
printCapped("api-server warn/error lines", warnOrErrorLines(apiLog));
printCapped(
  "fake rail stderr",
  railErr.split("\n").filter((l) => l !== ""),
);
process.exit(exitCode);
