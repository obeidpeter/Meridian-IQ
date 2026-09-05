/* global document, window */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { collectAccessibilityIssues } from "../../../scripts/src/e2e/accessibility.mjs";
import { startStaticServer } from "../../../scripts/src/e2e/serve.mjs";

// Reuse the repository's browser tooling without adding application dependencies.
const { chromium } = createRequire(
  new URL("../../../scripts/package.json", import.meta.url),
)("playwright");
let base = process.env.LANDING_A11Y_BASE_URL
  ? new URL(process.env.LANDING_A11Y_BASE_URL)
  : undefined;
if (base) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
}
const evidenceDir = new URL("../tmp/accessibility/", import.meta.url);
const viewports = [
  ["reflow", { width: 320, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1360, height: 900 }],
];
let browser;
let ownedServer;

before(async () => {
  await mkdir(evidenceDir, { recursive: true });
  if (!base) {
    ownedServer = await startStaticServer({ port: 0, apiPort: 1 });
    base = new URL(`http://127.0.0.1:${ownedServer.address().port}`);
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
      (existsSync("/opt/pw-browsers/chromium")
        ? "/opt/pw-browsers/chromium"
        : undefined),
  });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    if (ownedServer) {
      await new Promise((resolve, reject) => {
        ownedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

async function openPage(t, viewport, route) {
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const unexpectedRequests = [];
  const pageErrors = [];
  const state = { me: 401, readiness: 200 };
  await context.route("**/api/**", async (request) => {
    const path = new URL(request.request().url()).pathname;
    const status = path === "/api/me" ? state.me : state.readiness;
    if (
      request.request().method() !== "GET" ||
      !["/api/me", "/api/readyz"].includes(path)
    ) {
      unexpectedRequests.push(`${request.request().method()} ${path}`);
      await request.abort();
      return;
    }
    await request.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200
          ? { status: "ok" }
          : { error: "Local public-page fixture" },
      ),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(
      unexpectedRequests,
      [],
      "Only public read-only mocks are allowed",
    );
    assert.deepEqual(pageErrors, [], "No page runtime errors");
  });
  await page.goto(new URL(route, base).href);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, state };
}

async function audit(page, name, screenshot = false) {
  // Tab previews fade in; measure the settled text rather than an intermediate frame.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  let axe;
  const issues = await collectAccessibilityIssues(page, {
    reportAxe: (results) => {
      axe = results;
    },
  });
  await writeFile(
    new URL(`${name}.json`, evidenceDir),
    JSON.stringify(
      {
        verification:
          "Real local page; mocked GET /api/me and /api/readyz only",
        viewport: page.viewportSize(),
        issues,
        axe,
      },
      null,
      2,
    ),
  );
  if (screenshot) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: fileURLToPath(new URL(`${name}.png`, evidenceDir)),
      fullPage: true,
      animations: "disabled",
    });
  }
  assert.deepEqual(issues, [], `${name}: ${issues.join("; ")}`);
}

for (const [name, viewport] of viewports) {
  test(`landing landmarks, contrast and product views (${name})`, async (t) => {
    const { page, state } = await openPage(t, viewport, "/");
    await page
      .getByText("Core platform is operational", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("banner").count(), 1);
    assert.equal(await page.getByRole("contentinfo").count(), 1);
    assert.equal(
      await page.getByTestId("link-hero-contact").getAttribute("href"),
      "#request-access",
    );
    assert.equal(
      await page.getByTestId("link-hero-login").getAttribute("href"),
      "/login",
    );
    assert.match(
      await page.getByTestId("link-hero-login").textContent(),
      /Already invited\? Sign in/,
    );
    assert.equal(
      await page
        .getByRole("main")
        .getByRole("heading", { level: 1 })
        .textContent(),
      "MeridianIQ",
    );
    await audit(page, `landing-${name}`, true);

    await page.goto(new URL("/", base).href);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByRole("link", { name: "Skip to content" })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await page
        .getByRole("main")
        .evaluate((el) => el === document.activeElement),
      true,
    );

    for (const view of ["firm", "clerk", "buyer"]) {
      await page.locator(`#product-tab-${view}`).click();
      await audit(page, `landing-${view}-${name}`);
    }
    if (viewport.width < 1024) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("navigation", { name: "Mobile navigation" })
        .waitFor();
      await audit(page, `landing-menu-${name}`);
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .getByRole("button", { name: "Open navigation" })
          .evaluate((el) => el === document.activeElement),
        true,
      );
    }
    state.readiness = 503;
    await page.reload();
    await page
      .getByText("Platform availability is degraded", { exact: true })
      .waitFor();
    await audit(page, `landing-degraded-${name}`);
  });

  test(`login landmarks, contrast and outage (${name})`, async (t) => {
    const { page, state } = await openPage(t, viewport, "/login");
    await page.getByTestId("panel-sign-in").waitFor();
    assert.equal(await page.getByRole("main").count(), 1);
    assert.equal(await page.getByRole("contentinfo").count(), 1);
    if (viewport.width >= 1024) {
      assert.equal(
        await page
          .getByRole("complementary", {
            name: "One account. The right workspace.",
          })
          .count(),
        1,
      );
    } else {
      assert.equal(await page.getByRole("banner").count(), 1);
    }
    await audit(page, `login-${name}`, true);
    state.me = 503;
    await page.reload();
    await page
      .getByRole("alert")
      .filter({ hasText: "We can't reach MeridianIQ right now." })
      .waitFor();
    await audit(page, `login-outage-${name}`);
  });
}
