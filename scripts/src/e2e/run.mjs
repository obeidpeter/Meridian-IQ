// E2E harness: boots the BUILT api-server and the BUILT frontends behind a
// path-router (mirroring the production origin), then drives the user
// journeys headless. Requires DATABASE_URL pointing at a scratch database —
// the server seeds demo data at boot and journeys assume that seed.
//
//   pnpm --filter @workspace/scripts run e2e
//
// Prerequisites (CI builds these in earlier steps):
//   pnpm --filter @workspace/api-server run build
//   BASE_PATH=/ PORT=1 pnpm --filter @workspace/landing run build
//   BASE_PATH=/console/ PORT=1 pnpm --filter @workspace/console run build
//   BASE_PATH=/app/ PORT=1 pnpm --filter @workspace/sme-compliance run build
//   BASE_PATH=/buyer/ PORT=1 pnpm --filter @workspace/buyer-portal run build
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { runJourneys } from "./journeys.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const API_PORT = Number(process.env.E2E_API_PORT ?? 5100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8091);
const BASE = `http://127.0.0.1:${WEB_PORT}`;

const REQUIRED = [
  "artifacts/api-server/dist/index.mjs",
  "artifacts/landing/dist/public/index.html",
  "artifacts/console/dist/public/index.html",
  "artifacts/sme-compliance/dist/public/index.html",
  "artifacts/buyer-portal/dist/public/index.html",
];

function fail(msg) {
  console.error(`E2E: ${msg}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail("DATABASE_URL must point at a scratch Postgres database (it will be seeded).");
}
for (const rel of REQUIRED) {
  if (!existsSync(path.join(ROOT, rel))) {
    fail(`missing build artifact ${rel} — run the builds listed at the top of run.mjs.`);
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForApi(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("api-server did not become healthy in time");
}

// Prefer an explicitly provided browser, then the preinstalled one, then
// playwright's own download (CI runs `playwright install chromium`).
function browserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (existsSync("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  return undefined;
}

const api = spawn("node", ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: "development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let apiLog = "";
api.stdout.on("data", (d) => (apiLog += d));
api.stderr.on("data", (d) => (apiLog += d));

let staticServer;
let browser;
let exitCode;
try {
  await waitForApi();
  staticServer = await startStaticServer({ port: WEB_PORT, apiPort: API_PORT });

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

  await runJourneys(page, BASE, check);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("E2E crashed:", err);
  console.error("--- api-server log tail ---\n" + apiLog.split("\n").slice(-30).join("\n"));
  exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  staticServer?.close();
  api.kill("SIGTERM");
}
process.exit(exitCode);
