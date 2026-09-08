/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { startStaticServer } from "../../../scripts/src/e2e/serve.mjs";
import { collectAccessibilityIssues } from "../../../scripts/src/e2e/accessibility.mjs";

// Reuse the repository's browser harness without adding package dependencies.
const require = createRequire(
  new URL("../../../scripts/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(
  root,
  "tmp/platform-refinement",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const identity = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId: "00000000-0000-4000-8000-000000000002",
  clientPartyId: null,
  buyerPartyId: null,
  email: "fixture@valo.example",
  fullName: "Workspace reviewer",
  workspaceName: "Valo Advisory Partners",
  capabilities: ["console.portfolio.read", "invoice.read", "invoice.write"],
  features: ["invoice_lifecycle"],
  consentCaptured: true,
  releaseTag: "R4",
};
const today = {
  generatedAt: "2026-09-08T08:00:00Z",
  summary: {
    total: 3,
    urgent: 1,
    dueSoon: 2,
    blocked: 1,
    completedSetupSteps: 1,
    totalSetupSteps: 2,
  },
  items: [
    {
      id: "review",
      title: "Review invoice INV-2026-0042",
      description: "Supporting evidence is ready for review.",
      priority: "urgent",
      status: "open",
      dueAt: "2026-09-09T08:00:00Z",
      href: "/",
      clientName: "Acme Ltd",
      source: "invoice",
    },
    {
      id: "filing",
      title: "Prepare the monthly compliance record",
      description: "Reconcile invoices and retained payment records.",
      priority: "high",
      status: "open",
      dueAt: "2026-09-10T08:00:00Z",
      href: "/",
      clientName: "Sunrise Traders",
      source: "team_work",
    },
    {
      id: "evidence",
      title: "Check supporting documents",
      description: "Confirm the delivery note and customer reference.",
      priority: "normal",
      status: "open",
      dueAt: null,
      href: "/",
      clientName: null,
      source: "team_work",
    },
  ],
  setup: [
    {
      id: "profile",
      label: "Business profile",
      description: "Workspace details are complete.",
      complete: true,
      href: "/",
    },
    {
      id: "records",
      label: "Supporting records",
      description: "Connect the first invoice and its evidence.",
      complete: false,
      href: "/",
    },
  ],
};

test(
  "signed-in workspace reference palette, focus and reflow",
  { timeout: 180_000 },
  async (t) => {
    await mkdir(output, { recursive: true });
    const server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    for (const app of [
      { prefix: "console", role: "firm_admin", title: "What needs attention" },
      { prefix: "app", role: "client_user", title: "Your business today" },
      { prefix: "buyer", role: "buyer_user", title: "Buyer work today" },
    ]) {
      for (const width of [320, 768, 1360]) {
        for (const theme of ["light", "dark"]) {
          await t.test(`${app.prefix} ${theme} at ${width}px`, async () => {
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              serviceWorkers: "block",
              colorScheme: theme,
            });
            try {
              const unexpected = [];
              await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                if (!url.pathname.startsWith("/api/")) return route.continue();
                const fixtures = {
                  "/api/me": {
                    ...identity,
                    role: app.role,
                    clientPartyId:
                      app.prefix === "app" ? identity.userId : null,
                    buyerPartyId:
                      app.prefix === "buyer" ? identity.userId : null,
                  },
                  "/api/healthz": { contractVersion: "0.100.0" },
                  "/api/notifications": {
                    items: [],
                    unreadCount: 0,
                    nextCursor: null,
                  },
                  "/api/operations": { operations: [], nextCursor: null },
                  "/api/workspace/today": today,
                };
                const body =
                  route.request().method() === "GET"
                    ? fixtures[url.pathname]
                    : undefined;
                if (!body)
                  unexpected.push(
                    `${route.request().method()} ${url.pathname}`,
                  );
                return route.fulfill({
                  status: body ? 200 : 501,
                  contentType: "application/json",
                  body: JSON.stringify(
                    body ?? { error: "UNIMPLEMENTED_FIXTURE" },
                  ),
                });
              });
              const page = await context.newPage();
              const pageErrors = [];
              page.on("pageerror", (error) => pageErrors.push(error.message));
              await page.goto(`${origin}/${app.prefix}/`);
              await page
                .getByRole("heading", { name: app.title, exact: true })
                .waitFor();
              await page.evaluate(
                (mode) =>
                  document.documentElement.classList.toggle(
                    "dark",
                    mode === "dark",
                  ),
                theme,
              );
              await page.evaluate(async () => {
                await Promise.all(
                  document
                    .getAnimations()
                    .filter(
                      (animation) =>
                        animation.effect?.getTiming().iterations !== Infinity,
                    )
                    .map((animation) => animation.finished.catch(() => {})),
                );
              });
              const measured = await page.evaluate(() => {
                const shell = document.querySelector(".mi-platform");
                const header = document.querySelector(".mi-topbar");
                const main = document.querySelector("main");
                const visible = (el) =>
                  el.getBoundingClientRect().width &&
                  el.getBoundingClientRect().height;
                const controls = [
                  ...document.querySelectorAll(
                    ".mi-mobilebar button, .mi-topbar__action, .mi-today__open, .mi-today__text-action, .mi-today__setup-list button, .mi-workspace-header button",
                  ),
                ].filter(visible);
                return {
                  canvas: getComputedStyle(shell).backgroundColor,
                  paper: getComputedStyle(header).backgroundColor,
                  overflow:
                    document.documentElement.scrollWidth >
                    document.documentElement.clientWidth,
                  mainOverflow: main.scrollWidth > main.clientWidth,
                  smallControls: controls
                    .filter(
                      (el) =>
                        el.getBoundingClientRect().height < 44 ||
                        el.getBoundingClientRect().width < 44,
                    )
                    .map((el) => el.outerHTML),
                  icons: document.querySelectorAll(".mi-metric__icon svg")
                    .length,
                };
              });
              assert.equal(
                measured.canvas,
                theme === "dark" ? "rgb(27, 29, 28)" : "rgb(245, 246, 243)",
              );
              assert.equal(
                measured.paper,
                theme === "dark" ? "rgb(36, 39, 37)" : "rgb(255, 255, 255)",
              );
              assert.equal(measured.overflow, false);
              assert.equal(measured.mainOverflow, false);
              assert.deepEqual(measured.smallControls, []);
              assert.equal(measured.icons, 4);
              const name = `${app.prefix}-${theme}-${width}`;
              await page.screenshot({
                path: path.join(output, `${name}.png`),
                fullPage: true,
              });
              const issues = await collectAccessibilityIssues(page);
              await writeFile(
                path.join(output, `${name}.json`),
                JSON.stringify(
                  { measured, issues, unexpected, pageErrors },
                  null,
                  2,
                ),
              );
              assert.deepEqual(issues, []);
              assert.deepEqual(unexpected, []);
              assert.deepEqual(pageErrors, []);
              const skipLink = page.getByRole("link", {
                name: "Skip to content",
              });
              await skipLink.focus();
              assert.equal(
                await skipLink.evaluate((el) => document.activeElement === el),
                true,
              );
              await page.keyboard.press("Enter");
              assert.equal(
                await page
                  .locator("main")
                  .evaluate((el) => document.activeElement === el),
                true,
              );
              const search =
                width < 1024
                  ? page.getByRole("button", { name: /Search.*workspace/ })
                  : page.getByTestId("button-command-menu");
              await search.focus();
              const focus = await search.evaluate((el) => ({
                outline: getComputedStyle(el).outlineStyle,
                width: getComputedStyle(el).outlineWidth,
              }));
              assert.equal(focus.outline, "solid");
              assert.equal(focus.width, "2px");
              await page.keyboard.press("Enter");
              await page.getByRole("dialog").waitFor();
              assert.equal(
                await page
                  .getByRole("searchbox")
                  .evaluate((el) => document.activeElement === el),
                true,
                "dialog must own keyboard focus as soon as it is visible",
              );
              await page.keyboard.press("Escape");
              await page.getByRole("dialog").waitFor({ state: "hidden" });
              await page.waitForFunction(
                (element) => document.activeElement === element,
                await search.elementHandle(),
                { timeout: 5_000 },
              );
              assert.equal(
                await search.evaluate((el) => document.activeElement === el),
                true,
              );
            } finally {
              await context.close();
            }
          });
        }
      }
    }
    t.diagnostic(`Evidence: ${output}`);
  },
);
