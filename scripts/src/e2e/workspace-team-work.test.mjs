/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues, tabTo } from "./accessibility.mjs";
import {
  applications,
  createTeamFixture,
  longTitle,
} from "./workspace-team-work-fixtures.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(
  root,
  "tmp/workspace-team-work",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const report = {
  generatedAt: new Date().toISOString(),
  humanValidation: "Not conducted",
  browser: null,
  expectedCases: 13,
  cases: [],
};
let server;
let browser;
let origin;

before(async () => {
  await mkdir(output, { recursive: true });
  server = await startStaticServer({ port: 0, apiPort: 1 });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  report.browser = browser.version();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    if (server)
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    report.executedCases = report.cases.length;
    report.completeMatrix = report.cases.length === report.expectedCases;
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`Synthetic Team work evidence: ${output}`);
  }
});

async function openCase(t, app, width, theme) {
  const result = {
    id: t.name,
    app: app.prefix,
    width,
    theme,
    status: "running",
    captures: [],
  };
  report.cases.push(result);
  // Missing builds fail explicitly; never silently count an unbuilt app as covered.
  try {
    await access(
      path.join(root, `artifacts/${app.artifact}/dist/public/index.html`),
    );
  } catch {
    result.status = "failed";
    result.error = `Build artifacts/${app.artifact} before running this case`;
    throw new Error(result.error);
  }
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const fixture = createTeamFixture(app);
  await fixture.install(context, origin);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    try {
      await fixture.releasePages();
      result.requests = fixture.state.listRequests;
      result.commentAttempts = fixture.state.commentAttempts;
      result.unexpected = fixture.state.unexpected;
      result.pageErrors = errors;
      if (fixture.state.unexpected.length || errors.length) {
        result.status = "failed";
        result.error = "Unexpected fixture requests or page runtime errors";
      }
      if (result.status !== "passed") {
        result.status = "failed";
        await page
          .screenshot({
            path: path.join(output, `${t.name}-failure.png`),
            animations: "disabled",
          })
          .catch(() => {});
      }
      assert.deepEqual(
        fixture.state.unexpected,
        [],
        "Only planned synthetic API requests occurred",
      );
      assert.deepEqual(errors, [], "No page runtime errors");
    } finally {
      await context.close();
    }
  });
  return { ...fixture, context, page, result };
}

async function display(page, theme) {
  await page.evaluate(
    (mode) =>
      document.documentElement.classList.toggle("dark", mode === "dark"),
    theme,
  );
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
}

async function audit(page, result, phase) {
  const id = `${result.id}-${phase}`;
  const layout = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      ".mi-collaboration__detail > header h2, .mi-collaboration__detail > header span, .mi-collaboration__detail > header p, .mi-collaboration__list button > small, .mi-collaboration__item-meta span, .mi-collaboration__discussion li p, .mi-collaboration__error span, .mi-collaboration__error button, .mi-collaboration__list > p, .mi-collaboration__list > button",
    );
    const clipped = [];
    for (const element of nodes) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        rect.left < -1 ||
        rect.right > document.documentElement.clientWidth + 1
      )
        clipped.push({
          className: element.className,
          text: element.textContent.slice(0, 80),
        });
    }
    return {
      clipped,
      pageOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    };
  });
  let axe;
  const issues = await collectAccessibilityIssues(page, {
    reportAxe: (value) => {
      axe = value;
    },
  });
  // The 125-row list is deliberately not emitted as a multi-megapixel full-page image.
  await page.screenshot({
    path: path.join(output, `${id}.png`),
    animations: "disabled",
  });
  for (const [part, selector] of [
    ["selected-task", ".mi-collaboration__detail > header"],
    ["discussion", ".mi-collaboration__discussion"],
  ]) {
    const region = page.locator(selector);
    if (await region.count()) {
      await region.screenshot({
        path: path.join(output, `${id}-${part}.png`),
        animations: "disabled",
      });
    }
  }
  await writeFile(
    path.join(output, `${id}.json`),
    JSON.stringify(
      {
        scope: "Compiled local app with synthetic API, not human validation",
        layout,
        issues,
        axe,
      },
      null,
      2,
    ),
  );
  result.captures.push({ id, layout, issues });
  assert.deepEqual(
    layout.clipped,
    [],
    `${id}: long text remains inside its layout`,
  );
  assert.equal(layout.pageOverflow, false, `${id}: page reflow`);
  assert.deepEqual(issues, [], `${id}: whole-page accessibility`);
}

async function activate(page, target) {
  await tabTo(page, target, 240);
  assert.equal(
    await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.matches(":focus-visible") &&
        ((style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) >= 2) ||
          style.boxShadow !== "none")
      );
    }),
    true,
    "Keyboard action has visible focus",
  );
  await page.keyboard.press("Enter");
}

const workList = (page) =>
  page.getByRole("region", { name: "Work items", exact: true });
const taskButton = (page, title) =>
  workList(page)
    .locator("li > button")
    .filter({ has: page.getByText(title, { exact: true }) });
const draftKey = (me, task) =>
  `meridianiq:work-comment:${me.userId}:${me.firmId}:${me.clientPartyId ?? "firm"}:${task}`;

async function listBounds(page) {
  return workList(page).evaluate((element) => ({
    height: element.clientHeight,
    contentHeight: element.scrollHeight,
    pageHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    overflow: getComputedStyle(element).overflowY,
  }));
}

async function checkDesktopList(page, result, hundredRows) {
  const loaded = await listBounds(page);
  assert.ok(
    loaded.contentHeight > loaded.height,
    "Long task list scrolls internally",
  );
  assert.equal(loaded.overflow, "auto");
  assert.ok(
    loaded.height >= 24 * loaded.rem,
    "List retains a useful minimum height",
  );
  assert.ok(
    loaded.height < loaded.viewportHeight,
    "List is bounded by the viewport",
  );
  assert.equal(
    loaded.height,
    hundredRows.height,
    "Loading more tasks does not grow the list frame",
  );
  assert.equal(
    loaded.pageHeight,
    hundredRows.pageHeight,
    "Loading more tasks does not grow the page",
  );

  await page.setViewportSize({ width: 1440, height: 640 });
  const shortViewport = await listBounds(page);
  assert.ok(
    shortViewport.height < loaded.height,
    "List adapts to a shorter desktop viewport",
  );
  assert.ok(shortViewport.height >= 24 * shortViewport.rem);
  assert.ok(shortViewport.contentHeight > shortViewport.height);
  await page.setViewportSize({ width: 1440, height: 900 });

  const first = taskButton(page, longTitle);
  const last = taskButton(page, "Task 125");
  await tabTo(page, first, 240);
  const startScroll = await workList(page).evaluate(
    (element) => element.scrollTop,
  );
  await activate(page, last);
  await page.getByRole("heading", { name: "Task 125", exact: true }).waitFor();
  const focused = await last.evaluate((element) => {
    const list = element.closest(".mi-collaboration__list");
    const bounds = list.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      scrollTop: list.scrollTop,
      fullyVisible:
        rect.top >= Math.max(0, bounds.top) - 1 &&
        rect.bottom <= Math.min(window.innerHeight, bounds.bottom) + 1,
    };
  });
  assert.ok(
    focused.scrollTop > startScroll,
    "Tab traversal scrolls to the final loaded task",
  );
  assert.equal(
    focused.fullyVisible,
    true,
    "Final task and its focus outline are not clipped",
  );
  await page.screenshot({
    path: path.join(output, `${result.id}-last-task-keyboard.png`),
    animations: "disabled",
  });

  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("combobox", { name: "Status", exact: true })
      .evaluate(
        (element) =>
          element === document.activeElement &&
          element.matches(":focus-visible"),
      ),
    true,
    "Tab leaves the list for the selected task's status control",
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await last.evaluate((element) => element === document.activeElement),
    true,
  );
  await tabTo(page, first, 240);
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await workList(page).evaluate((element) =>
      element.contains(document.activeElement),
    ),
    false,
    "Shift+Tab also leaves the list from its first task",
  );
  result.desktopList = { hundredRows, loaded, shortViewport, focused };
}

for (const app of applications.slice(0, 2)) {
  for (const width of [320, 1440])
    for (const theme of ["light", "dark"]) {
      test(
        `${app.prefix}-${theme}-${width}-team-recovery`,
        { timeout: 100_000 },
        async (t) => {
          const { page, state, result, releasePages } = await openCase(
            t,
            app,
            width,
            theme,
          );
          await page.goto(`${origin}/${app.prefix}/work`);
          await workList(page)
            .getByText("Showing 50 of 125 tasks", { exact: true })
            .waitFor();
          await display(page, theme);
          assert.deepEqual(state.listRequests[0], {
            view: "active",
            limit: "50",
          });
          const retry = page.getByRole("button", {
            name: "Retry discussion",
            exact: true,
          });
          await retry.waitFor();
          assert.equal(
            await page
              .getByText(
                "No comments yet. Add a question, decision or update for your team.",
                { exact: true },
              )
              .count(),
            0,
          );
          await audit(page, result, "discussion-error-long-values");
          state.discussionError = false;
          await activate(page, retry);
          await retry.waitFor({ state: "hidden" });
          await page
            .getByText(
              "No comments yet. Add a question, decision or update for your team.",
              { exact: true },
            )
            .waitFor();

          const firstDraft = `First task draft ${"EvidenceReference".repeat(8)}`;
          const secondDraft = "Second task draft must remain separate";
          const comment = page.getByRole("textbox", {
            name: "Add a comment",
            exact: true,
          });
          await comment.fill(firstDraft);
          await taskButton(page, "Task 002").click();
          assert.equal(await comment.inputValue(), "");
          await comment.fill(secondDraft);
          await taskButton(page, longTitle).click();
          assert.equal(await comment.inputValue(), firstDraft);
          const stored = await page.evaluate(
            (keys) =>
              keys.map((key) => JSON.parse(window.sessionStorage.getItem(key))),
            [
              draftKey(state.me, "active-001"),
              draftKey(state.me, "active-002"),
            ],
          );
          assert.deepEqual(
            stored.map((draft) => draft.body),
            [firstDraft, secondDraft],
          );
          await page.reload();
          await comment.waitFor();
          assert.equal(
            await comment.inputValue(),
            firstDraft,
            "Draft survives reload in its user/firm/client/task session key",
          );
          await display(page, theme);

          await activate(
            page,
            page.getByRole("button", { name: "Comment", exact: true }),
          );
          await page
            .locator('.mi-collaboration__discussion > p[role="alert"]')
            .waitFor();
          assert.equal(
            await comment.inputValue(),
            firstDraft,
            "Lost response keeps the draft",
          );
          assert.equal(state.commentAttempts.length, 1);
          assert.equal(
            state.savedComments.size,
            1,
            "Fixture committed once before dropping the response",
          );
          await page.reload();
          await comment.waitFor();
          assert.equal(await comment.inputValue(), firstDraft);
          await display(page, theme);
          await activate(
            page,
            page.getByRole("button", { name: "Comment", exact: true }),
          );
          await page.waitForFunction(
            () => document.querySelector("#work-comment")?.value === "",
          );
          assert.equal(state.commentAttempts.length, 2);
          assert.deepEqual(
            state.commentAttempts[1],
            state.commentAttempts[0],
            "Lost-response retry reuses the original idempotency key and body",
          );
          assert.equal(
            state.savedComments.size,
            1,
            "Retry must not create a second comment",
          );
          assert.equal(
            await page
              .locator(".mi-collaboration__discussion li p")
              .getByText(firstDraft, { exact: true })
              .count(),
            1,
          );
          await taskButton(page, "Task 002").click();
          assert.equal(
            await comment.inputValue(),
            secondDraft,
            "Posting task one does not erase task two's draft",
          );

          const loadMore = workList(page).getByRole("button", {
            name: "Load more tasks",
            exact: true,
          });
          state.holdNextPage = true;
          await activate(page, loadMore);
          const loading = workList(page).getByRole("button", {
            name: "Loading more tasks",
            exact: true,
          });
          await loading.waitFor();
          assert.equal(await loading.isDisabled(), true);
          assert.equal(state.listRequests.at(-1).cursor, "fixture-active-50");
          await releasePages();
          await workList(page)
            .getByText("Showing 100 of 125 tasks", { exact: true })
            .waitFor();
          const hundredRows = width === 1440 ? await listBounds(page) : null;
          await activate(page, loadMore);
          await workList(page)
            .getByText("Showing 125 of 125 tasks", { exact: true })
            .waitFor();
          assert.equal(state.listRequests.at(-1).cursor, "fixture-active-100");
          assert.equal(await loadMore.count(), 0);
          assert.equal(
            await workList(page).locator("li > button").count(),
            125,
          );
          if (width === 1440) {
            await checkDesktopList(page, result, hundredRows);
          } else {
            await taskButton(page, "Task 125").click();
          }
          await page
            .getByRole("heading", { name: "Task 125", exact: true })
            .waitFor();

          const filters = page.getByRole("group", {
            name: "Filter team work",
            exact: true,
          });
          const beforeDone = state.listRequests.length;
          await activate(
            page,
            filters.getByRole("button", { name: "Completed", exact: true }),
          );
          await workList(page)
            .getByText("Showing 3 of 3 tasks", { exact: true })
            .waitFor();
          assert.deepEqual(state.listRequests[beforeDone], {
            view: "done",
            limit: "50",
          });
          assert.equal(await workList(page).locator("li > button").count(), 3);
          assert.equal(
            await page
              .getByRole("heading", { name: "Task 125", exact: true })
              .count(),
            0,
          );
          const beforeAll = state.listRequests.length;
          await activate(
            page,
            filters.getByRole("button", { name: "All", exact: true }),
          );
          await workList(page)
            .getByText("Showing 50 of 128 tasks", { exact: true })
            .waitFor();
          assert.deepEqual(state.listRequests[beforeAll], {
            view: "all",
            limit: "50",
          });
          assert.equal(
            await filters
              .getByRole("button", { name: "All", exact: true })
              .getAttribute("aria-pressed"),
            "true",
          );
          await display(page, theme);
          await audit(page, result, "filter-reset-and-recovered-discussion");
          result.status = "passed";
        },
      );
    }

  test(
    `${app.prefix}-list-failure-not-empty`,
    { timeout: 45_000 },
    async (t) => {
      const { page, state, result } = await openCase(t, app, 320, "light");
      state.listError = true;
      await page.goto(`${origin}/${app.prefix}/work`);
      await page
        .getByText("Team work could not be loaded", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByText(/^(No active tasks|No tasks yet|Nothing completed yet)$/)
          .count(),
        0,
      );
      await audit(page, result, "list-error");
      state.listError = false;
      state.discussionError = false;
      await activate(
        page,
        workList(page).getByRole("button", { name: "Try again", exact: true }),
      );
      await workList(page)
        .getByText("Showing 50 of 125 tasks", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByText("Team work could not be loaded", { exact: true })
          .count(),
        0,
      );
      result.status = "passed";
    },
  );
}

for (const app of applications) {
  test(
    `${app.prefix}-today-stale-error-retains-priorities`,
    { timeout: 45_000 },
    async (t) => {
      const { page, state, result } = await openCase(t, app, 320, "dark");
      await page.clock.install({ time: new Date("2026-09-09T08:00:00Z") });
      await page.goto(`${origin}/${app.prefix}${app.todayPath}`);
      await page
        .getByRole("heading", { name: app.title, exact: true })
        .waitFor();
      await page
        .getByText("Retained priority evidence", { exact: true })
        .waitFor();
      await display(page, "dark");
      state.todayError = true;
      await page.clock.fastForward(31_000);
      // A real visibility notification triggers React Query's stale-on-focus refetch.
      await page.evaluate(() =>
        window.dispatchEvent(new Event("visibilitychange")),
      );
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Today's workspace could not be refreshed." });
      await alert.waitFor();
      assert.ok(
        state.todayRequests > 1,
        "The failure followed a successful initial fetch",
      );
      assert.equal(
        await page
          .getByText("Retained priority evidence", { exact: true })
          .isVisible(),
        true,
      );
      assert.equal(
        await page
          .getByText("Your priority queue is clear", { exact: true })
          .count(),
        0,
      );
      await audit(page, result, "stale-error");
      state.todayError = false;
      await activate(
        page,
        alert.getByRole("button", { name: "Try again", exact: true }),
      );
      await alert.waitFor({ state: "hidden" });
      assert.equal(
        await page
          .getByText("Retained priority evidence", { exact: true })
          .isVisible(),
        true,
      );
      result.status = "passed";
    },
  );
}
