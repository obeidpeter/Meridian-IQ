/* global document */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { startStaticServer } from "./serve.mjs";
import { collectAxeResults, tabTo } from "./accessibility.mjs";
import {
  applications,
  createTeamFixture,
} from "./workspace-team-work-fixtures.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright");
const output = path.resolve(
  "tmp/workspace-created-task",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

test(
  "a task created below the loaded page retains its own discussion",
  { timeout: 180_000 },
  async (t) => {
    await mkdir(output, { recursive: true });
    const server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    for (const app of applications.filter((item) => item.prefix !== "buyer")) {
      for (const width of [320, 1440]) {
        for (const failedRefresh of [false, true]) {
          await t.test(
            `${app.prefix} ${width}px from ${failedRefresh ? "Completed with failed refresh" : "Active"}`,
            async () => {
              const context = await browser.newContext({
                viewport: { width, height: 1000 },
                serviceWorkers: "block",
                colorScheme: "light",
                reducedMotion: "reduce",
              });
              const fixture = createTeamFixture(app);
              fixture.state.discussionError = false;
              fixture.state.dropNextCommentResponse = false;
              const createRequests = [];
              const errors = [];
              const created = {
                ...fixture.state.active[1],
                id: "active-126",
                title: "New low-priority follow-up",
                firmId: fixture.state.me.firmId,
                clientPartyId:
                  app.prefix === "app" ? fixture.state.me.clientPartyId : null,
                clientName: app.prefix === "app" ? "Fixture client" : null,
                priority: "low",
                assignedTo: null,
                assignedToName: null,
              };
              try {
                await fixture.install(context, origin);
                await context.route("**/api/work-items", async (route) => {
                  if (route.request().method() !== "POST")
                    return route.fallback();
                  const body = route.request().postDataJSON();
                  try {
                    assert.deepEqual(Object.keys(body).sort(), [
                      "clientRequestId",
                      "priority",
                      "title",
                    ]);
                    assert.equal(body.title, created.title);
                    assert.equal(body.priority, "low");
                    assert.match(
                      body.clientRequestId,
                      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
                    );
                    createRequests.push(body);
                    assert.equal(
                      createRequests.length,
                      1,
                      "Only one task is created",
                    );
                    fixture.state.active.push(created);
                    return route.fulfill({ status: 201, json: created });
                  } catch (error) {
                    fixture.state.unexpected.push(String(error));
                    return route.fulfill({
                      status: 501,
                      json: { error: "INVALID_CREATE_FIXTURE" },
                    });
                  }
                });
                await context.route(
                  "**/api/public/usability-events",
                  async (route) => {
                    const body = route.request().postDataJSON();
                    if (body.event !== "work_item_created")
                      return route.fallback();
                    assert.deepEqual(body, {
                      event: "work_item_created",
                      surface: "collaboration",
                    });
                    return route.fulfill({ status: 202, json: { ok: true } });
                  },
                );
                const page = await context.newPage();
                page.setDefaultTimeout(20_000);
                page.on("pageerror", (error) => errors.push(error.message));
                await page.goto(`${origin}/${app.prefix}/work`);
                await page
                  .getByText("Showing 50 of 125 tasks", { exact: true })
                  .waitFor();
                if (failedRefresh) {
                  await page
                    .getByRole("button", { name: "Completed", exact: true })
                    .click();
                  await page
                    .getByText("Showing 3 of 3 tasks", { exact: true })
                    .waitFor();
                }
                fixture.state.listError = failedRefresh;
                await page
                  .getByRole("button", { name: "New task", exact: true })
                  .click();
                const dialog = page.getByRole("dialog");
                await dialog.getByLabel("Task title").fill(created.title);
                await dialog
                  .getByRole("combobox", { name: /^Priority\b/ })
                  .selectOption("low");
                await dialog
                  .getByRole("button", { name: "Create task", exact: true })
                  .press("Enter");
                await dialog.waitFor({ state: "hidden" });
                const detail = page.getByRole("region", {
                  name: "Selected work item",
                });
                await detail
                  .getByRole("heading", { name: created.title, exact: true })
                  .waitFor();
                assert.equal(
                  await page
                    .getByRole("button", { name: "Active", exact: true })
                    .getAttribute("aria-pressed"),
                  "true",
                );
                assert.equal(
                  await page
                    .getByRole("region", { name: "Work items" })
                    .getByRole("button", { name: new RegExp(created.title) })
                    .count(),
                  0,
                );
                assert.equal(
                  await page
                    .locator(".mi-collaboration__list > ol > li")
                    .count(),
                  50,
                );
                assert.equal(createRequests.length, 1);
                if (failedRefresh)
                  await page.getByRole("alert").first().waitFor();
                const comment = detail.getByLabel("Add a comment");
                await tabTo(page, comment, 160);
                await page.keyboard.type(
                  "Decision attached to the newly created task",
                );
                const send = detail.getByRole("button", {
                  name: "Comment",
                  exact: true,
                });
                await page.keyboard.press("Tab");
                assert.equal(
                  await send.evaluate(
                    (element) => element === document.activeElement,
                  ),
                  true,
                );
                await page.keyboard.press("Enter");
                await detail
                  .getByText("Decision attached to the newly created task", {
                    exact: true,
                  })
                  .waitFor();
                assert.equal(fixture.state.commentAttempts.length, 1);
                assert.equal(
                  fixture.state.commentAttempts[0].workItemId,
                  created.id,
                );
                assert.deepEqual(
                  (await collectAxeResults(page)).violations,
                  [],
                );
                assert.equal(
                  await page.evaluate(
                    () =>
                      document.documentElement.scrollWidth <=
                      document.documentElement.clientWidth,
                  ),
                  true,
                );
                await page.screenshot({
                  path: path.join(
                    output,
                    `${app.prefix}-${width}-${failedRefresh ? "failed-refresh" : "active"}.png`,
                  ),
                  fullPage: true,
                });

                fixture.state.listError = false;
                await page
                  .getByRole("button", { name: "Refresh", exact: true })
                  .click();
                await page
                  .getByText("Showing 50 of 126 tasks", { exact: true })
                  .waitFor();
                await detail
                  .getByRole("heading", { name: created.title, exact: true })
                  .waitFor();
                await page
                  .getByRole("button", { name: "Load more tasks", exact: true })
                  .click();
                await page
                  .getByText("Showing 100 of 126 tasks", { exact: true })
                  .waitFor();
                await page
                  .getByRole("button", { name: "Load more tasks", exact: true })
                  .click();
                await page
                  .getByText("Showing 126 of 126 tasks", { exact: true })
                  .waitFor();
                const row = page
                  .getByRole("region", { name: "Work items" })
                  .getByRole("button", { name: new RegExp(created.title) });
                assert.equal(await row.getAttribute("aria-pressed"), "true");
                fixture.state.active.splice(
                  fixture.state.active.findIndex(
                    (item) => item.id === created.id,
                  ),
                  1,
                );
                await page
                  .getByRole("button", { name: "Refresh", exact: true })
                  .click();
                await page
                  .getByText("Showing 125 of 125 tasks", { exact: true })
                  .waitFor();
                await detail
                  .getByRole("heading", { name: created.title, exact: true })
                  .waitFor({ state: "hidden" });
                assert.equal(
                  await detail
                    .getByText("Decision attached to the newly created task", {
                      exact: true,
                    })
                    .count(),
                  0,
                );
                assert.deepEqual(fixture.state.unexpected, []);
                assert.deepEqual(errors, []);
              } finally {
                await fixture.releasePages();
                await context.close();
              }
            },
          );
        }
      }
    }
    t.diagnostic(`Screenshots: ${output}`);
  },
);
