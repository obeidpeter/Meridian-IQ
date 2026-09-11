/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { operatorResponses } from "./fixtures.ts";

// Use the same built assets and static path router as the full CI journeys.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const { startStaticServer } = await import(
  pathToFileURL(path.join(root, "scripts/src/e2e/serve.mjs")).href
);
const { chromium } = await import(
  pathToFileURL(path.join(root, "scripts/node_modules/playwright/index.mjs"))
    .href
);
const { collectAccessibilityIssues, tabTo } = await import(
  pathToFileURL(path.join(root, "scripts/src/e2e/accessibility.mjs")).href
);
const { API_CONTRACT_VERSION } = await import(
  pathToFileURL(path.join(root, "lib/api-zod/src/generated/version.ts")).href
);
const out = path.join(
  root,
  "tmp/control-centre-a11y-r198",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await access(path.join(root, "artifacts/console/dist/public/index.html"));
await mkdir(out, { recursive: true });
const server = await startStaticServer({ port: 0, apiPort: 1 });
let browser;
const base = new URL(`http://127.0.0.1:${server.address().port}`);
const report = {
  generatedAt: new Date().toISOString(),
  browser: null,
  syntheticApi: true,
  cases: [],
  failures: [],
};
const routes = [
  ["activation", "Evidence and activation", "Evidence gates"],
  ["buyers", "Buyer pilots", "Pilot portfolio"],
  ["cases", "Compliance cases", "Review pending compliance evidence"],
  ["reliability", "Integration reliability", "Connection estate"],
  ["evidence", "Saved compliance evidence", "Enterprise trust controls"],
  ["clerk", "Clerk quality and safety", "Safety checks"],
];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  report.browser = browser.version();
  for (const [routeName, title, content] of routes) {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 390, 1360]) {
        const id = `${routeName}-${theme}-${width}`;
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 900 },
          serviceWorkers: "block",
          colorScheme: theme,
        });
        const unexpected = [];
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== base.origin) return route.abort();
            if (!url.pathname.startsWith("/api/")) return route.continue();
            if (route.request().method() !== "GET") {
              unexpected.push(
                `Blocked mutation: ${route.request().method()} ${url.pathname}`,
              );
              return route.fulfill({
                status: 405,
                contentType: "application/json",
                body: JSON.stringify({ error: "READ_ONLY_FIXTURE" }),
              });
            }
            let body = operatorResponses[url.pathname];
            if (url.pathname === "/api/notifications")
              body = { items: [], nextCursor: null, unreadCount: 0 };
            if (url.pathname === "/api/operations")
              body = { operations: [], nextCursor: null };
            if (url.pathname === "/api/me")
              body = {
                userId: "fixture-operator",
                firmId: "fixture-firm",
                role: "operator",
                fullName: "Control Centre Verification Operator",
                email: "control-centre-verification@example.test",
                workspaceName: "Control Centre fixture practice",
                capabilities: ["operator.queue.read"],
                features: [],
                consentCaptured: true,
                clientPartyId: null,
              };
            if (url.pathname === "/api/healthz")
              body = {
                status: "ok",
                contractVersion: API_CONTRACT_VERSION,
                buildRevision: "a".repeat(40),
              };
            if (!body) unexpected.push(`Unimplemented GET: ${url.pathname}`);
            await route.fulfill({
              status: body ? 200 : 501,
              contentType: "application/json",
              body: JSON.stringify(body ?? { error: "UNIMPLEMENTED_FIXTURE" }),
            });
          });
          await page.goto(
            new URL(`/console/control-centre/${routeName}`, base).href,
          );
          await page
            .getByRole("heading", { name: title, exact: true, level: 1 })
            .waitFor({ state: "visible" });
          await page
            .getByText(content, { exact: true })
            .first()
            .waitFor({ state: "visible" });
          await page.evaluate(
            (theme) =>
              document.documentElement.classList.toggle(
                "dark",
                theme === "dark",
              ),
            theme,
          );
          await page.waitForFunction(() =>
            document
              .getAnimations()
              .every((animation) => animation.playState !== "running"),
          );
          const progress = await page
            .getByRole("progressbar")
            .evaluateAll((elements) =>
              elements.map((element) => ({
                name: element.getAttribute("aria-label"),
                value: element.getAttribute("aria-valuenow"),
              })),
            );
          assert.equal(
            progress.length,
            routeName === "activation" ? 6 : routeName === "buyers" ? 3 : 0,
          );
          for (const item of progress)
            assert(
              item.name && item.value !== null,
              `${id}: named determinate progress`,
            );
          if (routeName === "clerk")
            assert.equal(
              await page
                .getByRole("complementary", { name: "Clerk assurance results" })
                .count(),
              1,
            );
          let axe;
          const issues = await collectAccessibilityIssues(page, {
            reportAxe: (result) => {
              axe = result;
            },
          });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({
            path: path.join(out, `${id}.png`),
            fullPage: true,
          });
          await writeFile(
            path.join(out, `${id}.axe.json`),
            JSON.stringify(axe, null, 2),
          );
          if (routeName === "clerk") {
            await page
              .getByRole("link", { name: "Open", exact: true })
              .first()
              .hover();
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .every((animation) => animation.playState !== "running"),
            );
            const hoverIssues = await collectAccessibilityIssues(page, {
              reportAxe: (result) => {
                axe = result;
              },
            });
            issues.push(
              ...hoverIssues.map((issue) => `Open action hover: ${issue}`),
            );
            await writeFile(
              path.join(out, `${id}-hover.axe.json`),
              JSON.stringify(axe, null, 2),
            );
          }
          const focusStates = [];
          const workspaceNav = page.getByRole("navigation", {
            name: "Control centre workspaces",
          });
          const focusTargets = [
            workspaceNav.locator('[aria-current="page"]'),
            workspaceNav.locator("a:not([aria-current])").first(),
          ];
          if (routeName === "clerk")
            focusTargets.push(
              page.getByRole("link", {
                name: "Open review queue",
                exact: true,
              }),
              page.getByRole("link", { name: "Detailed health", exact: true }),
              page.getByRole("link", { name: "Open", exact: true }).first(),
            );
          for (const [index, target] of focusTargets.entries()) {
            await tabTo(page, target, 120);
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .every((animation) => animation.playState !== "running"),
            );
            const state = await target.evaluate((element) => {
              const style = getComputedStyle(element);
              const surface = element.closest("nav, section");
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d", {
                willReadFrequently: true,
              });
              const luminance = (color) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(
                  0,
                  3,
                );
                return rgb
                  .map((value) => {
                    const channel = value / 255;
                    return channel <= 0.04045
                      ? channel / 12.92
                      : ((channel + 0.055) / 1.055) ** 2.4;
                  })
                  .reduce(
                    (sum, value, index) =>
                      sum + value * [0.2126, 0.7152, 0.0722][index],
                    0,
                  );
              };
              const ring = style.getPropertyValue("--tw-ring-color").trim();
              const outline = {
                style: style.outlineStyle,
                color: style.outlineColor,
                width: Number.parseFloat(style.outlineWidth),
                offset: Number.parseFloat(style.outlineOffset),
              };
              const hasOutline =
                outline.style === "solid" && outline.width >= 2;
              const indicatorColor = hasOutline ? outline.color : ring;
              const background = getComputedStyle(surface).backgroundColor;
              const levels = [luminance(indicatorColor), luminance(background)];
              return {
                text: element.textContent.trim(),
                focused:
                  element === document.activeElement &&
                  element.matches(":focus-visible"),
                shadow: style.boxShadow,
                ring,
                outline,
                hasOutline,
                indicatorColor,
                background,
                contrast:
                  (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05),
              };
            });
            focusStates.push(state);
            if (
              !state.focused ||
              (!state.hasOutline && state.shadow === "none") ||
              !state.indicatorColor ||
              state.contrast < 3
            )
              issues.push(`Focus indicator: ${JSON.stringify(state)}`);
            await page.screenshot({
              path: path.join(out, `${id}-focus-${index}.png`),
            });
          }
          issues.push(
            ...unexpected,
            ...errors.map((error) => `Page error: ${error}`),
          );
          report.cases.push({
            id,
            progress,
            focusStates,
            unexpected,
            errors,
            issues,
          });
          if (issues.length) report.failures.push({ id, issues });
          console.log(`${id}: ${issues.length} issues`);
        } catch (error) {
          report.failures.push({
            id,
            error: String(error),
            unexpected,
            errors,
          });
          console.log(`${id}: ${error}`);
        } finally {
          await page.close();
        }
      }
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await writeFile(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
assert.equal(report.cases.length, 36, "Every route/theme/viewport must render");
assert.equal(
  report.failures.length,
  0,
  JSON.stringify(report.failures, null, 2),
);
console.log(`Evidence: ${out}; 36 cases; no exclusions`);
