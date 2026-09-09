/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues, tabTo } from "./accessibility.mjs";
import { shellFixtures } from "./workspace-usability-fixtures.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(
  root,
  "tmp/workspace-usability-hooks",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const nextLabel = `Add ${"LongClientReference".repeat(10)}`;
const setup = [
  {
    id: "first_client",
    label: nextLabel,
    description:
      "Prepare the first client's workspace details before continuing.",
    href: "/clients",
    complete: false,
  },
  {
    id: "first_invoice",
    label: "Prepare the first invoice",
    description:
      "The draft stays unfinished until required details are recorded.",
    href: "/invoices",
    complete: false,
    blockedReason: `Review ${"UnbrokenDiagnostic".repeat(12)}`,
  },
  {
    id: "invoice_validation",
    label: "Validate the invoice",
    description: "Review validation findings before submission.",
    href: "/invoices",
    complete: false,
  },
];
const item = {
  id: "fixture-task",
  clientPartyId: null,
  clientName: "Fixture client",
  title: "Review the client handoff",
  description: "Confirm supporting records.",
  status: "open",
  priority: "normal",
  dueAt: null,
  assignedTo: null,
  assignedToName: null,
  createdByName: "Fixture accountant",
  href: null,
  version: 1,
  updatedAt: "2026-09-09T08:00:00Z",
};

async function capture(page, id, selector) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  const measurements = await page.locator(selector).evaluate((scope) => {
    const selectors =
      ".mi-today__next-step, .mi-today__next-step p, .mi-today__next-step button, .mi-today__step-blocker, .mi-today__setup-list button, .mi-collaboration__error, .mi-collaboration__error > span, .mi-collaboration__error > button, .mi-collaboration__list > p, .mi-collaboration__list > button";
    const elements = [...scope.querySelectorAll(selectors)];
    const clipped = elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          (element.scrollWidth > element.clientWidth + 1 ||
            rect.left < 0 ||
            rect.right > document.documentElement.clientWidth + 1)
        );
      })
      .map((element) => element.className);
    const buttons = elements.filter((element) => element.tagName === "BUTTON");
    const smallTargets = buttons
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      })
      .map((element) => element.textContent.trim());
    const warningText = [
      ...scope.querySelectorAll(
        '.mi-today__step-blocker, li[data-blocked="true"] .mi-today__step-status',
      ),
    ].map((element) => getComputedStyle(element).color);
    const probe = document.createElement("span");
    probe.style.cssText = "color:var(--mi-warning);transition:none";
    scope.append(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    const next = scope.querySelector(".mi-today__next-step");
    const nextStyle = next && getComputedStyle(next);
    const arrow = scope.querySelector(".mi-today__next-step button svg");
    const arrowWidth = arrow?.getBoundingClientRect().width;
    const alertsOverlap = [
      ...scope.querySelectorAll(".mi-collaboration__error"),
    ].some((alert) => {
      const message = alert.querySelector("span")?.getBoundingClientRect();
      const button = alert.querySelector("button")?.getBoundingClientRect();
      return (
        message &&
        button &&
        Math.min(message.right, button.right) -
          Math.max(message.left, button.left) >
          1 &&
        Math.min(message.bottom, button.bottom) -
          Math.max(message.top, button.top) >
          1
      );
    });
    return {
      clipped,
      smallTargets,
      warningText,
      warning,
      arrowWidth,
      alertsOverlap,
      nextBorder: nextStyle?.borderTopWidth,
      nextRadius: nextStyle?.borderRadius,
      disabledOpacity: buttons
        .filter((button) => button.disabled)
        .map((button) => getComputedStyle(button).opacity),
    };
  });
  let axe;
  const issues = await collectAccessibilityIssues(page, {
    reportAxe: (result) => {
      axe = result;
    },
  });
  await page.screenshot({
    path: path.join(output, `${id}.png`),
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(
    path.join(output, `${id}.json`),
    JSON.stringify(
      {
        scope: "Synthetic compiled Today/work pages; no human validation",
        measurements,
        issues,
        axe,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(measurements.clipped, [], `${id}: clipping`);
  assert.deepEqual(measurements.smallTargets, [], `${id}: touch targets`);
  assert.equal(
    measurements.alertsOverlap,
    false,
    `${id}: alert message/retry overlap`,
  );
  assert.ok(
    measurements.disabledOpacity.every((opacity) => opacity === "1"),
    `${id}: disabled text remains readable`,
  );
  assert.ok(
    measurements.warningText.every((color) => color === measurements.warning),
    `${id}: blockers retain warning tone`,
  );
  if (measurements.arrowWidth !== undefined) {
    assert.equal(measurements.arrowWidth, 16);
    assert.equal(measurements.nextBorder, "0px");
    assert.equal(measurements.nextRadius, "0px");
  }
  assert.deepEqual(issues, [], `${id}: whole-page accessibility`);
}

test(
  "Today and collaboration styling hooks: wrapping, disabled state and recovery",
  { timeout: 180_000 },
  async (t) => {
    await access(path.join(root, "artifacts/console/dist/public/index.html"));
    await mkdir(output, { recursive: true });
    const server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        t.diagnostic(`Synthetic hook evidence: ${output}`);
      }
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    for (const width of [320, 768, 1440])
      for (const theme of ["light", "dark"])
        await t.test(`${theme}-${width}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: theme,
            serviceWorkers: "block",
            reducedMotion: "reduce",
          });
          const unexpected = [];
          const errors = [];
          let commentsFail = true;
          let releasePage;
          const fixtures = shellFixtures();
          fixtures["/api/me"] = {
            ...fixtures["/api/me"],
            role: "firm_admin",
            capabilities: ["console.portfolio.read", "work.read", "work.write"],
          };
          fixtures["/api/workspace/today"] = {
            generatedAt: "2026-09-09T08:00:00Z",
            summary: {
              total: 0,
              urgent: 0,
              dueSoon: 0,
              blocked: 0,
              completedSetupSteps: 0,
              totalSetupSteps: 3,
            },
            items: [],
            setup,
          };
          fixtures["/api/console/portfolio"] = { clients: [] };
          fixtures["/api/console/team"] = [];
          await context.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (
              url.origin === "https://fonts.googleapis.com" &&
              url.pathname === "/css2"
            )
              return route.fulfill({
                contentType: "text/css",
                body: "/* Offline fallback fonts. */",
              });
            if (url.origin !== origin || request.method() !== "GET") {
              unexpected.push(`${request.method()} ${url.href}`);
              return route.abort();
            }
            if (!url.pathname.startsWith("/api/")) return route.continue();
            if (url.pathname === "/api/work-items/page") {
              if (url.searchParams.has("cursor"))
                return new Promise((resolve) => {
                  releasePage = async () => {
                    try {
                      await route.fulfill({
                        json: {
                          items: [
                            {
                              ...item,
                              id: "second-task",
                              title: "Second task",
                            },
                          ],
                          total: 2,
                          nextCursor: null,
                        },
                      });
                    } finally {
                      resolve();
                    }
                  };
                });
              return route.fulfill({
                json: { items: [item], total: 2, nextCursor: "fixture-next" },
              });
            }
            if (url.pathname === "/api/work-items/fixture-task/comments")
              return route.fulfill({
                status: commentsFail ? 503 : 200,
                json: commentsFail
                  ? { error: "Synthetic discussion unavailable" }
                  : [],
              });
            if (Object.hasOwn(fixtures, url.pathname))
              return route.fulfill({ json: fixtures[url.pathname] });
            unexpected.push(`Unimplemented GET ${url.pathname}`);
            return route.fulfill({
              status: 501,
              json: { error: "UNIMPLEMENTED_FIXTURE" },
            });
          });
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(`${origin}/console/today`);
            await page
              .getByRole("button", {
                name: `Continue: ${nextLabel}`,
                exact: true,
              })
              .waitFor();
            await page.evaluate(
              (mode) =>
                document.documentElement.classList.toggle(
                  "dark",
                  mode === "dark",
                ),
              theme,
            );
            assert.equal(
              await page
                .locator(".mi-today__setup-list button:disabled")
                .count(),
              1,
            );
            await capture(page, `today-${theme}-${width}`, ".mi-today");
            await page.goto(`${origin}/console/work`);
            const list = page.getByRole("region", {
              name: "Work items",
              exact: true,
            });
            await list
              .getByText("Showing 1 of 2 tasks", { exact: true })
              .waitFor();
            await page.evaluate(
              (mode) =>
                document.documentElement.classList.toggle(
                  "dark",
                  mode === "dark",
                ),
              theme,
            );
            await list
              .getByRole("button", { name: /Review the client handoff/ })
              .click();
            const retry = page.getByRole("button", {
              name: "Retry discussion",
              exact: true,
            });
            await retry.waitFor();
            await capture(
              page,
              `discussion-error-${theme}-${width}`,
              ".mi-collaboration",
            );
            commentsFail = false;
            await tabTo(page, retry, 160);
            await page.keyboard.press("Enter");
            await retry.waitFor({ state: "hidden" });
            const loadMore = list.getByRole("button", {
              name: "Load more tasks",
              exact: true,
            });
            await tabTo(page, loadMore, 160);
            await page.keyboard.press("Enter");
            await list
              .getByRole("button", { name: "Loading more tasks", exact: true })
              .waitFor();
            await capture(
              page,
              `load-more-${theme}-${width}`,
              ".mi-collaboration",
            );
            assert.ok(releasePage, "Load more requested a cursor page");
            await releasePage();
            releasePage = undefined;
            await list
              .getByText("Showing 2 of 2 tasks", { exact: true })
              .waitFor();
            assert.equal(
              await list
                .getByRole("button", { name: "Load more tasks", exact: true })
                .count(),
              0,
            );
            assert.deepEqual(unexpected, []);
            assert.deepEqual(errors, []);
          } finally {
            try {
              await releasePage?.();
            } finally {
              await context.close();
            }
          }
        });
  },
);
