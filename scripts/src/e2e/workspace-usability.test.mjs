/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues, tabTo } from "./accessibility.mjs";
import {
  reliabilityEndpoint,
  reliabilityFixture,
  shellFixtures,
} from "./workspace-usability-fixtures.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(
  root,
  "tmp/workspace-usability",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const routePath = "/console/control-centre/reliability";
const cases = [
  ...[320, 390, 768, 1024, 1440].map((width) => ({
    state: "populated",
    width,
  })),
  ...["partial", "empty", "loading", "error"].flatMap((state) =>
    [320, 1440].map((width) => ({ state, width })),
  ),
  // Root-text enlargement tests rem-based text/reflow, not native browser zoom.
  { state: "populated", width: 768, textScale: 2 },
].flatMap((scenario) =>
  ["light", "dark"].map((theme) => ({ ...scenario, theme })),
);

async function openFixture(browser, origin, scenario) {
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: 900 },
    serviceWorkers: "block",
    colorScheme: scenario.theme,
    reducedMotion: "reduce",
  });
  const state = {
    mode: scenario.state,
    requests: [],
    unexpected: [],
    pageErrors: [],
    offlineFonts: [],
  };
  const data = reliabilityFixture(scenario.state);
  const fixtures = shellFixtures();
  const pending = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === "https://fonts.googleapis.com" &&
      url.pathname === "/css2"
    ) {
      state.offlineFonts.push(url.href);
      return route.fulfill({
        contentType: "text/css",
        body: "/* Offline fixture: system fallback fonts. */",
      });
    }
    if (url.origin !== origin || request.method() !== "GET") {
      state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    state.requests.push(url.pathname);
    if (url.pathname === reliabilityEndpoint) {
      if (state.mode === "loading") {
        return new Promise((resolve) =>
          pending.push(async () => {
            try {
              await route.fulfill({ json: data });
            } finally {
              resolve();
            }
          }),
        );
      }
      if (state.mode === "error")
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic reliability service unavailable" },
        });
      return route.fulfill({ json: data });
    }
    if (Object.hasOwn(fixtures, url.pathname))
      return route.fulfill({ json: fixtures[url.pathname] });
    state.unexpected.push(`Unimplemented GET ${url.pathname}`);
    return route.fulfill({
      status: 501,
      json: { error: "UNIMPLEMENTED_FIXTURE" },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  const release = async () => {
    state.mode = "populated";
    for (const reply of pending.splice(0)) await reply();
  };
  return { context, page, state, data, release };
}

async function applyDisplay(page, scenario) {
  await page.evaluate(({ theme, textScale = 1 }) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.fontSize = `${16 * textScale}px`;
  }, scenario);
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

async function measureWorkspace(page) {
  return page.locator(".mi-reliability").evaluate((workspace) => {
    const bounds = workspace.getBoundingClientRect();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const describe = (element) =>
      `${element.tagName}.${element.className}: ${element.textContent.trim().slice(0, 100)}`;
    const clipped = [];
    for (const element of workspace.querySelectorAll(
      "section, p, h2, dl, dt, dd, button, a, .mi-reliability__status, .mi-segmented, .mi-work-item",
    )) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1 ||
        rect.right > document.documentElement.clientWidth + 1 ||
        element.scrollWidth > element.clientWidth + 1 ||
        (["hidden", "clip"].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1)
      )
        clipped.push(describe(element));
    }
    const controls = [...workspace.querySelectorAll("button, a")].filter(
      visible,
    );
    const smallControls = controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      })
      .map(describe);
    const overlaps = [];
    const checkPairs = (elements) => {
      for (let i = 0; i < elements.length; i++)
        for (let j = i + 1; j < elements.length; j++) {
          const a = elements[i].getBoundingClientRect();
          const b = elements[j].getBoundingClientRect();
          if (
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          )
            overlaps.push([describe(elements[i]), describe(elements[j])]);
        }
    };
    checkPairs([...workspace.querySelectorAll(".mi-segmented__item")]);
    for (const row of workspace.querySelectorAll(
      ".mi-reliability__connection",
    )) {
      checkPairs([...row.children]);
      checkPairs([...row.querySelectorAll("dt, dd")]);
      checkPairs([
        ...row.querySelectorAll(
          ".mi-reliability__name, .mi-reliability__status",
        ),
      ]);
    }
    const tokens = getComputedStyle(workspace);
    const probe = document.createElement("span");
    probe.style.transition = "none";
    workspace.append(probe);
    const tokenColor = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = [];
    const checkColor = (selector, property, token) => {
      for (const element of workspace.querySelectorAll(selector))
        colors.push({
          selector,
          property,
          expected: tokenColor(token),
          actual: getComputedStyle(element)[property],
        });
    };
    checkColor("#connections", "backgroundColor", "--mi-paper");
    checkColor("#connections h2, .mi-reliability__name", "color", "--mi-ink");
    checkColor("dt", "color", "--mi-muted");
    checkColor(".mi-reliability__issue", "color", "--mi-warning");
    for (const tone of ["positive", "warning", "critical"]) {
      checkColor(
        `.mi-reliability__status[data-tone="${tone}"]`,
        "color",
        `--mi-${tone}`,
      );
      checkColor(
        `.mi-reliability__status[data-tone="${tone}"]`,
        "backgroundColor",
        `--mi-${tone}-soft`,
      );
    }
    probe.remove();
    return {
      clipped,
      smallControls,
      overlaps,
      colors,
      paperToken: tokens.getPropertyValue("--mi-paper").trim(),
      pageOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      workspaceOverflow: workspace.scrollWidth > workspace.clientWidth + 1,
    };
  });
}

async function audit(page, id, state, report) {
  const measured = await measureWorkspace(page);
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
  const evidence = {
    id,
    scope:
      "Synthetic local compiled UI; no participant sessions; not native browser zoom",
    viewport: page.viewportSize(),
    measured,
    issues,
    requests: [...state.requests],
    unexpected: [...state.unexpected],
    pageErrors: [...state.pageErrors],
    offlineFonts: [...state.offlineFonts],
  };
  report.checks.push(evidence);
  await writeFile(
    path.join(output, `${id}.json`),
    JSON.stringify(evidence, null, 2),
  );
  await writeFile(
    path.join(output, `${id}.axe.json`),
    JSON.stringify(axe, null, 2),
  );
  assert.deepEqual(
    state.unexpected,
    [],
    `${id}: fixture requests must be read-only and allowlisted`,
  );
  assert.deepEqual(state.pageErrors, [], `${id}: page runtime errors`);
  assert.deepEqual(
    issues,
    [],
    `${id}: accessibility (including surrounding page)`,
  );
  assert.equal(measured.pageOverflow, false, `${id}: page overflow`);
  assert.equal(measured.workspaceOverflow, false, `${id}: workspace overflow`);
  assert.deepEqual(measured.clipped, [], `${id}: clipped or overflowing text`);
  assert.deepEqual(measured.overlaps, [], `${id}: overlapping content`);
  assert.deepEqual(measured.smallControls, [], `${id}: controls below 44px`);
  for (const color of measured.colors)
    assert.equal(
      color.actual,
      color.expected,
      `${id}: ${color.selector} ${color.property}`,
    );
}

async function keyboardActivate(page, target) {
  await tabTo(page, target, 160);
  const focus = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.matches(":focus-visible") &&
      ((style.outlineStyle !== "none" &&
        Number.parseFloat(style.outlineWidth) >= 2) ||
        style.boxShadow !== "none")
    );
  });
  assert.equal(focus, true, "Keyboard target has a visible focus indicator");
  await page.keyboard.press("Enter");
}

async function checkFilters(page, data) {
  const group = page.getByRole("group", { name: "Filter connections" });
  for (const [label, expected] of [
    ["Attention", 2],
    ["ERP", 1],
    ["Bank feed", 2],
    ["All", 3],
  ]) {
    const count = label === "All" ? 3 : expected;
    const button = group.getByRole("button", {
      name: `${label} ${count}`,
      exact: true,
    });
    await keyboardActivate(page, button);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
    assert.equal(
      await page.locator(".mi-reliability__connection").count(),
      expected,
    );
    const expectedNames = data.connections
      .filter(
        (connection) =>
          label === "All" ||
          (label === "Attention"
            ? connection.operationalState !== "healthy"
            : connection.type === (label === "ERP" ? "erp" : "bank_feed")),
      )
      .map((connection) => connection.clientName);
    assert.deepEqual(
      await page.locator(".mi-reliability__name").allTextContents(),
      expectedNames,
    );
    assert.equal(
      await page
        .getByText(`${data.healthyConnections}/${data.totalConnections}`, {
          exact: true,
        })
        .count(),
      1,
    );
  }
  const links = page
    .locator(".mi-reliability")
    .getByRole("link", { name: "Investigate", exact: true });
  assert.equal(await links.count(), 3, "Zero-count signal excluded");
  for (const [index, signal] of data.qualitySignals
    .filter((signal) => signal.count > 0)
    .entries())
    assert.equal(
      await links.nth(index).getAttribute("href"),
      `/console${signal.actionHref}`,
    );
}

test(
  "reliability workspace usability: local fixtures, long values, themes, reflow and recovery",
  { timeout: 360_000 },
  async (t) => {
    await access(path.join(root, "artifacts/console/dist/public/index.html"));
    await mkdir(output, { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      humanValidation: "Not conducted",
      expectedCases: cases.length,
      cases: [],
      checks: [],
      browser: null,
    };
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
        await writeFile(
          path.join(output, "report.json"),
          JSON.stringify(report, null, 2),
        );
        t.diagnostic(`Synthetic evidence: ${output}`);
      }
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    report.browser = browser.version();
    for (const scenario of cases) {
      const id = `${scenario.state}-${scenario.theme}-${scenario.width}${scenario.textScale ? "-text-200" : ""}`;
      await t.test(id, { timeout: 45_000 }, async () => {
        const fixture = await openFixture(browser, origin, scenario);
        const { page, state, data } = fixture;
        const result = { id, scenario, status: "running" };
        report.cases.push(result);
        try {
          await page.goto(origin + routePath);
          await page
            .getByRole("heading", {
              name: "Integration reliability",
              exact: true,
              level: 1,
            })
            .waitFor();
          if (scenario.state === "loading")
            await page.getByLabel("Loading workspace").waitFor();
          else if (scenario.state === "error")
            await page
              .getByRole("alert")
              .filter({ hasText: "Unable to load integration reliability." })
              .waitFor();
          else
            await page
              .getByRole("region", { name: "Connection estate" })
              .waitFor();
          await applyDisplay(page, scenario);
          assert.equal(
            await page
              .locator("html")
              .evaluate((element) => element.classList.contains("dark")),
            scenario.theme === "dark",
          );
          if (["loading", "error"].includes(scenario.state)) {
            assert.equal(
              await page
                .getByRole("region", {
                  name: "Integration reliability summary",
                })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByText("Reliability signals are clear", { exact: true })
                .count(),
              0,
            );
          }
          if (scenario.state === "partial") {
            assert.match(
              await page.getByRole("note").innerText(),
              /3 most affected of 1000003 connections/,
            );
            assert.equal(
              await page.getByText("No run", { exact: true }).count(),
              1,
            );
          }
          if (scenario.state === "empty") {
            await page
              .getByText("Reliability signals are clear", { exact: true })
              .waitFor();
            assert.equal(
              await page
                .locator(".mi-reliability")
                .getByRole("status")
                .innerText(),
              "No connections in this view.",
            );
            await keyboardActivate(
              page,
              page.getByRole("button", { name: "ERP 0", exact: true }),
            );
            assert.equal(
              await page
                .getByRole("button", { name: "ERP 0", exact: true })
                .getAttribute("aria-pressed"),
              "true",
            );
          }
          await audit(page, id, state, report);
          if (scenario.state === "loading") {
            await fixture.release();
            await page
              .getByRole("region", { name: "Connection estate" })
              .waitFor();
            assert.equal(await page.getByLabel("Loading workspace").count(), 0);
            await audit(page, `${id}-recovered`, state, report);
          } else if (scenario.state === "error") {
            const before = state.requests.filter(
              (endpoint) => endpoint === reliabilityEndpoint,
            ).length;
            state.mode = "populated";
            await keyboardActivate(
              page,
              page.getByRole("button", { name: "Try again", exact: true }),
            );
            await page
              .getByRole("region", { name: "Connection estate" })
              .waitFor();
            assert.ok(
              state.requests.filter(
                (endpoint) => endpoint === reliabilityEndpoint,
              ).length > before,
            );
            assert.equal(
              await page
                .getByText("Unable to load integration reliability.", {
                  exact: true,
                })
                .count(),
              0,
            );
            await audit(page, `${id}-recovered`, state, report);
          }
          if (scenario.state !== "empty") await checkFilters(page, data);
          assert.deepEqual(state.unexpected, []);
          assert.deepEqual(state.pageErrors, []);
          result.status = "passed";
        } catch (error) {
          result.status = "failed";
          result.error = String(error);
          result.unexpected = state.unexpected;
          result.pageErrors = state.pageErrors;
          await page
            .screenshot({
              path: path.join(output, `${id}-failure.png`),
              fullPage: true,
              animations: "disabled",
            })
            .catch(() => {});
          throw error;
        } finally {
          try {
            await fixture.release();
          } finally {
            await fixture.context.close();
          }
        }
      });
    }
    assert.equal(
      report.cases.length,
      cases.length,
      "Every planned scenario ran",
    );
  },
);
