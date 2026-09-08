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
  ["tablet", { width: 768, height: 1024 }],
  ["desktop", { width: 1440, height: 900 }],
  ["wide", { width: 1920, height: 1080 }],
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
  const state = { me: 401, readiness: 200, submit: null, events: [] };
  await context.route("**/api/**", async (request) => {
    const path = new URL(request.request().url()).pathname;
    if (
      path === "/api/public/usability-events" &&
      request.request().method() === "POST"
    ) {
      const payload = request.request().postDataJSON();
      assert.deepEqual(Object.keys(payload).sort(), ["event", "surface"]);
      state.events.push(payload);
      await request.fulfill({ status: 204 });
      return;
    }
    if (
      path === "/api/public/access-requests" &&
      state.submit &&
      request.request().method() === "POST"
    ) {
      await state.submit(request);
      return;
    }
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
      "Only explicitly mocked public requests are allowed",
    );
    assert.deepEqual(pageErrors, [], "No page runtime errors");
  });
  await page.goto(new URL(route, base).href);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.match(await page.title(), /Valo/);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /MeridianIQ|Meridian Today/,
  );
  assert.ok(
    await page.getByRole("link", { name: "Valo home", exact: true }).count(),
  );
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
          "Real local page; public API requests are intercepted locally, never sent to a live service",
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
    await page.evaluate(() =>
      window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`${name}.png`, evidenceDir)),
      fullPage: true,
      animations: "disabled",
    });
    await page.screenshot({
      path: fileURLToPath(new URL(`${name}-viewport.png`, evidenceDir)),
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
      "Invoices in order.Evidence at hand.",
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

    const exampleHeight = (await page.locator(".editorial-demo").boundingBox())
      .height;
    for (const view of ["firm", "sme"]) {
      await page.locator(`#product-tab-${view}`).click();
      assert.equal(
        (await page.locator(".editorial-demo").boundingBox()).height,
        exampleHeight,
        "Audience changes keep the example frame stable",
      );
      await audit(page, `landing-${view}-${name}`, true);
      for (const recordView of ["evidence", "history", "overview"]) {
        await page.locator(`#sample-${view}-tab-${recordView}`).click();
        assert.equal(
          (await page.locator(".editorial-demo").boundingBox()).height,
          exampleHeight,
          "Record views keep the example frame stable",
        );
        await audit(page, `landing-${view}-${recordView}-${name}`);
      }
    }
    if (viewport.width < 1024) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("navigation", { name: "Mobile navigation" })
        .waitFor();
      await audit(page, `landing-menu-${name}`, true);
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
      .filter({ hasText: "We can't reach Valo right now." })
      .waitFor();
    await audit(page, `login-outage-${name}`);
  });
}

test("editorial navigation, meaningful audience tabs, images and destinations", async (t) => {
  const { page, state } = await openPage(t, { width: 390, height: 844 }, "/");
  const tab = page.getByRole("tab", { name: "Businesses", exact: true });
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page
      .getByRole("tab", { name: "Accounting firms" })
      .getAttribute("aria-selected"),
    "true",
  );
  await page
    .getByRole("heading", { name: "Client attention", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Sign in to the console" })
      .getAttribute("href"),
    "/login?returnTo=/console/",
  );
  await page.keyboard.press("Home");
  await page.getByRole("heading", { name: "July design services" }).waitFor();
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  await page.keyboard.press("End");
  assert.equal(
    await page
      .getByRole("tab", { name: "Accounting firms" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const recordTab = page.locator("#sample-firm-tab-overview");
  await recordTab.focus();
  for (const [key, view] of [
    ["ArrowRight", "evidence"],
    ["End", "history"],
    ["ArrowRight", "overview"],
    ["ArrowLeft", "history"],
    ["Home", "overview"],
  ]) {
    await page.keyboard.press(key);
    const selected = page.locator(`#sample-firm-tab-${view}`);
    assert.equal(await selected.getAttribute("aria-selected"), "true");
    assert.equal(
      await selected.evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      await page
        .locator(`#sample-firm-panel-${view}`)
        .getAttribute("aria-hidden"),
      "false",
    );
  }
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "For accountants" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Open navigation" })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .locator("#for-accountants")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await page
      .getByRole("tab", { name: "Accounting firms" })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.ok(
    await page
      .locator(".editorial-hero-image img")
      .evaluate(
        (img) =>
          img.complete &&
          img.naturalWidth > 0 &&
          img.currentSrc.endsWith("/valo-workspace-mobile.webp"),
      ),
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Open penalty calculator" })
      .getAttribute("href"),
    "/penalty-calculator/",
  );
  const missingAnchors = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href").slice(1))
        .filter((id) => !document.getElementById(id)),
    );
  assert.deepEqual(missingAnchors, []);
  await page.getByTestId("link-hero-contact").click();
  assert.ok(
    state.events.some(
      (event) => event.event === "landing_cta" && event.surface === "landing",
    ),
  );
});

test("short portrait screens retain the product image and a hint of the next section", async (t) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 740, height: 731 },
    { width: 1000, height: 800 },
    { width: 1920, height: 800 },
  ]) {
    const { page } = await openPage(t, viewport, "/");
    const hero = await page.locator(".editorial-hero").boundingBox();
    assert.ok(
      hero.y + hero.height < viewport.height - 24,
      `${viewport.width}x${viewport.height}: the next section should start within the viewport`,
    );
    assert.ok(
      await page
        .locator(".editorial-hero-image img")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    );
    await audit(page, `landing-short-${viewport.width}`, true);
  }
});

test("enquiry preserves values on failure, prevents concurrent submits and restores focus", async (t) => {
  const { page, state } = await openPage(t, { width: 390, height: 844 }, "/");
  const form = page.getByRole("form", { name: "Request a demo" });
  const send = form.getByRole("button", {
    name: "Request a demo",
    exact: true,
  });
  assert.equal(await send.isDisabled(), true);
  await page
    .getByLabel("Your name", { exact: true })
    .fill("A very long business contact name for layout verification");
  await page
    .getByLabel("Work email", { exact: true })
    .fill("a.long.business.contact.address.for.layout.testing@example.test");
  await page
    .getByLabel("Business or firm name")
    .fill("A Company With A Long Name For Responsive Verification");
  await page.getByLabel("Valo may use these details").check();
  let submits = 0;
  state.submit = async (request) => {
    submits++;
    await request.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test relay unavailable" }),
    });
  };
  await send.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Your request was not sent." })
    .waitFor();
  assert.equal(submits, 1);
  assert.match(
    await page.getByLabel("Work email", { exact: true }).inputValue(),
    /layout.testing@example.test/,
  );
  assert.equal(
    await page
      .locator("#access-request-error")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await audit(page, "landing-enquiry-error-mobile", true);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  state.submit = async (request) => {
    submits++;
    const body = request.request().postDataJSON();
    assert.equal(body.consent, true);
    assert.equal(body.website, "");
    assert.equal(body.interest, "business");
    await gate;
    await request.fulfill({ status: 204 });
  };
  await send.click();
  await page.getByRole("button", { name: "Sending request" }).waitFor();
  assert.equal(
    await page.getByLabel("Your name", { exact: true }).isDisabled(),
    true,
  );
  await form.evaluate((el) => {
    el.requestSubmit();
    el.requestSubmit();
  });
  assert.equal(submits, 2);
  release();
  await page
    .getByRole("heading", { name: "Your request is with us." })
    .waitFor();
  assert.equal(
    await page
      .locator(".editorial-contact-result")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await audit(page, "landing-enquiry-success-mobile", true);
  await page.getByRole("button", { name: "Send another request" }).click();
  assert.equal(
    await page.getByLabel("Your name", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByLabel("Your name", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.ok(
    state.events.some((event) => event.event === "access_request_started"),
  );
});
