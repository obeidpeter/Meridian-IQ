// UX snapshot harness: boots the built stack the way run.mjs does, signs in
// as the seeded demo identities, and captures (a) the e2e accessibility
// check's issue list and (b) a full-page screenshot for a fixed set of key
// pages. Used to measure before/after states of UX rounds — run it on a
// scratch database, never a shared one.
//
//   DATABASE_URL=postgresql://…/meridian_uxsnap \
//   OUT_DIR=/tmp/ux-baseline node src/e2e/ux-snapshot.mjs
//
// Prereqs: the same builds run.mjs needs, plus `db run push` on the scratch DB.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues } from "./accessibility.mjs";
import { apiLogin, apiLogout, DEMO_PASSWORD } from "./journeys/shared.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const API_PORT = Number(process.env.UX_API_PORT ?? 5140);
const WEB_PORT = Number(process.env.UX_WEB_PORT ?? 8095);
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT_DIR = process.env.OUT_DIR ?? path.join(ROOT, "ux-snapshot");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must point at a scratch database (it will be seeded).");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// page id → { url, identity } — identity null means public.
const PAGES = [
  ["landing", "/", null],
  ["login", "/login", null],
  ["sme-dashboard", "/app", "owner@adaezefoods.example"],
  ["sme-invoices", "/app/invoices", "owner@adaezefoods.example"],
  ["sme-invoice-new", "/app/invoices/new", "owner@adaezefoods.example"],
  ["sme-import", "/app/import", "owner@adaezefoods.example"],
  ["sme-calendar", "/app/calendar", "owner@adaezefoods.example"],
  ["sme-month-end", "/app/month-end", "owner@adaezefoods.example"],
  ["sme-vat", "/app/vat", "owner@adaezefoods.example"],
  ["console-portfolio", "/console", "demo.admin@meridianiq.example"],
  ["console-pipeline", "/console/pipeline", "demo.admin@meridianiq.example"],
  ["console-invitations", "/console/invitations", "demo.admin@meridianiq.example"],
  ["console-advisory", "/console/advisory", "demo.admin@meridianiq.example"],
  ["console-notifications", "/console/notifications", "demo.admin@meridianiq.example"],
];

function browserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  return "/opt/pw-browsers/chromium";
}

async function waitForApi(timeoutMs = 60000) {
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

const api = spawn("node", ["artifacts/api-server/dist/index.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: "development",
    SEED_DEMO: "true",
    DEMO_PASSWORD,
    LOGIN_IP_ATTEMPT_MAX: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let apiLog = "";
api.stdout.on("data", (d) => (apiLog += d));
api.stderr.on("data", (d) => (apiLog += d));

let staticServer;
let browser;
let exitCode = 0;
try {
  await waitForApi();
  staticServer = await startStaticServer({ port: WEB_PORT, apiPort: API_PORT });
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

  const report = [];
  let identity = null;
  for (const [id, url, who] of PAGES) {
    if (who !== identity) {
      if (who) await apiLogin(page, BASE, who);
      else await apiLogout(page, BASE);
      identity = who;
    }
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    // Settle render-on-success cards before measuring.
    await page.waitForTimeout(750);
    const issues = await collectAccessibilityIssues(page);
    await page.screenshot({ path: path.join(OUT_DIR, `${id}.png`), fullPage: true });
    report.push({ id, url, identity: who, issueCount: issues.length, issues });
    console.log(`${id}: ${issues.length} accessibility issue(s)`);
  }
  writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  const total = report.reduce((n, r) => n + r.issueCount, 0);
  console.log(`ux-snapshot: ${report.length} pages, ${total} total issues -> ${OUT_DIR}`);
} catch (err) {
  console.error("ux-snapshot crashed:", err);
  console.error("--- api log tail ---\n" + apiLog.split("\n").slice(-20).join("\n"));
  exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  staticServer?.close();
  api.kill("SIGTERM");
}
process.exit(exitCode);
