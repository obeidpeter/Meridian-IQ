/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAxeResults, tabTo } from "./accessibility.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidence = path.join(
  root,
  "tmp/clerk-wht-accessibility",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const me = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId: "00000000-0000-4000-8000-000000000002",
  clientPartyId: "00000000-0000-4000-8000-000000000003",
  buyerPartyId: null,
  role: "firm_staff",
  email: "fixture@valo.example",
  fullName: "Local fixture",
  capabilities: ["invoice.read", "clerk.ask", "clerk.use", "claims.read"],
  features: ["clerk_ai", "invoice_lifecycle"],
  consentCaptured: true,
  workspaceName: "Local fixture firm",
  releaseTag: "R4",
};
const metrics = {
  windowDays: 30,
  narrationMatch: { suggested: 0, kept: 0, overridden: 0, abstained: 0 },
  grounding: { violations: 0, bySurface: [] },
  cases: { total: 0, byStatus: {}, byKind: {} },
  inference: {
    total: 0,
    byOutcome: {},
    invalidRate: 0,
    errorRate: 0,
    cohorts: [],
  },
  cost: { promptTokens: 0, completionTokens: 0, callsWithUsage: 0 },
  economics: { byPurpose: [], months: [] },
  corrections: [],
  supplierAccuracy: [],
  ask: { total: 0, answered: 0, refused: 0, refusalRate: 0 },
  platformSpend: {
    month: "2026-09",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    firmFundedTokens: 0,
    platformFundedTokens: 0,
    estimatedUsd: null,
    projectedTokens: 0,
    projectedUsd: null,
  },
  injectionTrend: { months: [], byPromptVersion: [] },
};
const fixtures = new Map([
  ["/api/me", me],
  ["/api/healthz", { contractVersion: "0.100.0" }],
  ["/api/notifications", { items: [], unreadCount: 0, nextCursor: null }],
  ["/api/feature-flags", [{ key: "clerk_ai", enabled: true }]],
  ["/api/firms", []],
  ["/api/parties", []],
  ["/api/clerk/cases", []],
  ["/api/clerk/batches", []],
  ["/api/claims", []],
  [
    "/api/clerk/claim-gaps",
    { windowDays: 30, refusedTotal: 0, byReason: [], uncovered: [] },
  ],
  ["/api/clerk/metrics", metrics],
  [
    "/api/clerk/tier-report",
    { windowDays: 30, baseModel: "fixture", rows: [] },
  ],
  [
    "/api/clerk/ask-feedback",
    {
      totals: { helpful: 0, notHelpful: 0, rated: 0 },
      byIntent: [],
      recentNotHelpful: [],
    },
  ],
  ["/api/clerk/eval/runs", []],
  ["/api/clerk/eval/intent-runs", []],
  ["/api/clerk/eval/intent-fixtures", []],
  ["/api/clerk/eval/phrasing-runs", []],
  ["/api/clerk/eval/retrieval-runs", []],
  ["/api/clerk/eval/fixtures", { fixtures: [] }],
  [
    "/api/clerk/eval/prompt",
    { promptVersion: "fixture", system: "Local inert fixture" },
  ],
  [
    "/api/clerk/digest-impact",
    {
      windowDays: 30,
      delivered: { pairs: 0, meanUrgentDelta: null, improvedShare: null },
      undelivered: { pairs: 0, meanUrgentDelta: null, improvedShare: null },
      note: "Local fixture",
    },
  ],
  [
    "/api/wht/credits",
    {
      credits: [
        {
          id: "whc-1",
          firmId: me.firmId,
          clientPartyId: me.clientPartyId,
          invoiceId: "inv-1",
          invoiceNumber: "INV-1001",
          category: "services_5",
          amount: "7500.00",
          deductedDate: "2026-07-20",
          source: "manual",
          status: "awaiting_note",
          noteReference: null,
          noteDate: null,
          createdAt: "2026-07-20T10:00:00Z",
          updatedAt: "2026-07-20T10:00:00Z",
        },
      ],
      totals: {
        awaitingNote: 1,
        noteReceived: 0,
        awaitingAmount: "7500.00",
        totalAmount: "7500.00",
      },
    },
  ],
]);
const routes = [
  {
    path: "/app/clerk/ask",
    ready: (page) => page.getByLabel("Your question", { exact: true }),
  },
  { path: "/app/wht", ready: (page) => page.getByTestId("row-wht-whc-1") },
  {
    path: "/console/clerk",
    ready: (page) => page.getByText("No documents read yet", { exact: true }),
  },
  {
    path: "/console/clerk/ask",
    ready: (page) => page.getByTestId("input-ask-question"),
  },
  {
    path: "/console/clerk/claims",
    ready: (page) =>
      page.getByText("No claims in the register yet", { exact: true }),
  },
  {
    path: "/console/clerk/health",
    ready: (page) => page.getByTestId("stat-cases-total"),
  },
];

async function assertVisibleFocus(locator) {
  assert.ok(
    await locator.evaluate(
      (element) =>
        element === document.activeElement &&
        element.matches(":focus-visible") &&
        getComputedStyle(element).boxShadow !== "none",
    ),
    "keyboard focus is visibly indicated",
  );
}

test(
  "Clerk and WHT accessibility across narrow and desktop viewports",
  { timeout: 180_000 },
  async (t) => {
    for (const app of ["console", "sme-compliance"])
      await access(path.join(root, `artifacts/${app}/dist/public/index.html`));
    await mkdir(evidence, { recursive: true });
    let server;
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        if (server?.listening)
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
      }
    });
    // Browser interception fulfills every API request. No database/API process
    // is started, and the unused proxy port must never be reached.
    server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    for (const width of [320, 390, 1360]) {
      for (const scenario of routes) {
        await t.test(
          `${scenario.path} at ${width}px`,
          { timeout: 30_000 },
          async () => {
            const name = `${scenario.path.replaceAll("/", "_")}-${width}`;
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              serviceWorkers: "block",
            });
            let page;
            let axe;
            const pageErrors = [];
            const unknownRequests = [];
            try {
              await context.tracing.start({
                screenshots: true,
                snapshots: true,
                sources: true,
              });
              await context.route("**/*", (route) => {
                const request = route.request();
                const url = new URL(request.url());
                if (url.origin !== origin) return route.abort();
                if (!url.pathname.startsWith("/api/")) return route.continue();
                const known =
                  request.method() === "GET" && fixtures.has(url.pathname);
                if (!known)
                  unknownRequests.push(`${request.method()} ${url.pathname}`);
                return route.fulfill({
                  status: known ? 200 : 501,
                  contentType: "application/json",
                  body: JSON.stringify(
                    known
                      ? fixtures.get(url.pathname)
                      : { error: "UNIMPLEMENTED_FIXTURE" },
                  ),
                });
              });
              page = await context.newPage();
              page.setDefaultTimeout(10_000);
              page.on("pageerror", (error) => pageErrors.push(error.message));
              await page.goto(`${origin}${scenario.path}`);
              await scenario.ready(page).waitFor({ state: "visible" });
              assert.equal(await page.getByRole("main").count(), 1);
              assert.equal(
                await page.getByRole("heading", { level: 1 }).count(),
                1,
              );
              if (scenario.path === "/app/clerk/ask") {
                const link = page.getByRole("link", {
                  name: "Send it to Clerk",
                  exact: true,
                });
                await page.mouse.move(0, 0);
                assert.equal(await link.getAttribute("href"), "/app/clerk");
                assert.ok(
                  await link.evaluate((element) =>
                    getComputedStyle(element).textDecorationLine.includes(
                      "underline",
                    ),
                  ),
                  "capture link is distinguished without hover",
                );
                await tabTo(page, link);
                await assertVisibleFocus(link);
              } else if (scenario.path === "/app/wht") {
                const table = page.getByRole("table", { name: "WHT credits" });
                const scroller = page.getByRole("group", {
                  name: "WHT credits",
                  exact: true,
                });
                assert.equal(
                  await scroller
                    .getByRole("table", { name: "WHT credits" })
                    .count(),
                  1,
                );
                await tabTo(page, scroller);
                await assertVisibleFocus(scroller);
                assert.equal(
                  await table.locator("button, a, input").count(),
                  0,
                );
                if (width < 768) {
                  assert.ok(
                    await scroller.evaluate(
                      (element) => element.scrollWidth > element.clientWidth,
                    ),
                    "fixture actually overflows at narrow width",
                  );
                  const before = await scroller.evaluate(
                    (element) => element.scrollLeft,
                  );
                  await page.keyboard.press("ArrowRight");
                  await page.waitForFunction(
                    ({ before }) => document.activeElement.scrollLeft > before,
                    { before },
                  );
                  const after = await scroller.evaluate(
                    (element) => element.scrollLeft,
                  );
                  await page.keyboard.press("ArrowLeft");
                  await page.waitForFunction(
                    ({ after }) => document.activeElement.scrollLeft < after,
                    { after },
                  );
                }
              } else {
                const banner = page.getByRole("banner");
                assert.equal(
                  await banner.count(),
                  1,
                  "one visible header landmark at each breakpoint",
                );
                if (width < 768) {
                  assert.equal(
                    await banner.getByText("Clerk AI", { exact: true }).count(),
                    1,
                  );
                  const back = banner.getByRole("link", {
                    name: "Back to console",
                    exact: true,
                  });
                  assert.equal(await back.getAttribute("href"), "/console/");
                  await tabTo(page, back);
                  await assertVisibleFocus(back);
                }
                const nav = page.getByRole("navigation", {
                  name: "Clerk",
                  exact: true,
                });
                assert.equal(await nav.getByRole("link").count(), 4);
                const active = nav.locator('[aria-current="page"]');
                assert.equal(await active.getAttribute("href"), scenario.path);
                await tabTo(page, active);
                await assertVisibleFocus(active);
                await page.keyboard.press("Enter");
                assert.equal(new URL(page.url()).pathname, scenario.path);
              }
              axe = await collectAxeResults(page);
              assert.deepEqual(
                axe.violations.map(({ id, nodes }) => ({
                  id,
                  targets: nodes.map(({ target }) => target),
                })),
                [],
                "full axe scan has no exclusions",
              );
              assert.deepEqual(pageErrors, []);
              assert.deepEqual(unknownRequests, []);
            } finally {
              try {
                if (page) {
                  await page.screenshot({
                    path: path.join(evidence, `${name}.png`),
                    fullPage: true,
                  });
                  await writeFile(
                    path.join(evidence, `${name}.json`),
                    JSON.stringify(
                      {
                        browser: browser.version(),
                        pageErrors,
                        unknownRequests,
                        axe:
                          axe ??
                          (await collectAxeResults(page).catch((error) => ({
                            captureError: error.message,
                          }))),
                      },
                      null,
                      2,
                    ),
                  );
                }
              } finally {
                try {
                  await context.tracing.stop({
                    path: path.join(evidence, `${name}.zip`),
                  });
                } finally {
                  await context.close();
                }
              }
            }
          },
        );
      }
    }
    t.diagnostic(`${browser.version()}; evidence: ${evidence}`);
  },
);
