/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { tabTo } from "./accessibility.mjs";
import { assertDialogClosedAndFocusRestored } from "./state-catalogue/dialog-focus.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidence = path.join(
  root,
  "tmp/notification-trigger-contrast",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const apps = [
  { name: "sme-compliance", prefix: "/app", role: "firm_staff" },
  { name: "console", prefix: "/console", role: "firm_staff" },
  { name: "buyer-portal", prefix: "/buyer", role: "buyer_user" },
];

// Resolve actual browser CSS colors, including color(srgb ...) and translucent
// hover fills, before applying the WCAG relative-luminance contrast formula.
async function measureContrast(locator, property) {
  return locator.evaluate((element, property) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const over = (front, back) =>
      front
        .slice(0, 3)
        .map(
          (channel, i) =>
            (channel * front[3]) / 255 + back[i] * (1 - front[3] / 255),
        );
    const luminance = (rgb) =>
      rgb
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
          0,
        );
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.backgroundImage !== "none" ||
        Number(style.opacity) !== 1 ||
        style.filter !== "none"
      )
        throw new Error(
          "Contrast fixture needs explicit handling for images, opacity or filters",
        );
      layers.unshift(style.backgroundColor);
    }
    const background = layers.reduce(
      (back, color) => over(rgba(color), back),
      [255, 255, 255],
    );
    const style = getComputedStyle(element);
    if (property === "stroke" && Number(style.strokeOpacity) !== 1)
      throw new Error(
        "Contrast fixture needs explicit handling for stroke opacity",
      );
    const color = style[property];
    const foreground = over(rgba(color), background);
    const light = luminance(foreground);
    const dark = luminance(background);
    return {
      color,
      foreground,
      background,
      ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
    };
  }, property);
}

async function settleStyles(locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

test(
  "notification SVG stroke contrast and popup isolation in all three shells",
  { timeout: 180_000 },
  async (t) => {
    for (const app of apps)
      await access(
        path.join(root, `artifacts/${app.name}/dist/public/index.html`),
      );
    await mkdir(evidence, { recursive: true });
    let browser;
    let server;
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
    server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    for (const app of apps) {
      for (const theme of ["light", "dark"]) {
        let desktopPopup;
        for (const width of [1360, 320, 390]) {
          await t.test(
            `${app.name} ${theme} ${width}px`,
            { timeout: 20_000 },
            async () => {
              const name = `${app.name}-${theme}-${width}`;
              const measurements = [];
              const errors = [];
              const context = await browser.newContext({
                viewport: { width, height: 900 },
                colorScheme: theme,
                serviceWorkers: "block",
              });
              let page;
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
                  if (!url.pathname.startsWith("/api/"))
                    return route.continue();
                  const fixtures = {
                    "/api/me": {
                      userId: "00000000-0000-4000-8000-000000000001",
                      firmId: "00000000-0000-4000-8000-000000000002",
                      clientPartyId: "00000000-0000-4000-8000-000000000003",
                      buyerPartyId: "00000000-0000-4000-8000-000000000004",
                      role: app.role,
                      email: "fixture@valo.example",
                      fullName: "Local fixture",
                      capabilities: ["invoice.read", "invoice.respond"],
                      features: ["invoice_lifecycle"],
                      consentCaptured: true,
                      workspaceName: "Local fixture",
                      releaseTag: "R4",
                    },
                    "/api/notifications": { items: [], unreadCount: 0 },
                    "/api/healthz": { contractVersion: "0.100.0" },
                  };
                  const known =
                    request.method() === "GET" &&
                    Object.hasOwn(fixtures, url.pathname);
                  if (!known)
                    errors.push(
                      `Unexpected API: ${request.method()} ${url.pathname}`,
                    );
                  return route.fulfill({
                    status: known ? 200 : 501,
                    contentType: "application/json",
                    body: JSON.stringify(
                      known
                        ? fixtures[url.pathname]
                        : { error: "UNIMPLEMENTED_FIXTURE" },
                    ),
                  });
                });
                page = await context.newPage();
                page.setDefaultTimeout(8_000);
                page.on("pageerror", (error) => errors.push(error.message));
                await page.goto(`${origin}${app.prefix}/notifications`);
                await page
                  .getByRole("heading", {
                    name: "Notifications",
                    exact: true,
                    level: 1,
                  })
                  .waitFor({ state: "visible" });
                await page.evaluate(
                  (dark) =>
                    document.documentElement.classList.toggle("dark", dark),
                  theme === "dark",
                );
                const trigger = page.locator(
                  '[data-testid="button-notifications"]:visible',
                );
                assert.equal(await trigger.count(), 1);
                const bounds = await trigger.boundingBox();
                assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
                const icon = trigger.locator("svg");
                const header = trigger.locator("xpath=ancestor::header");
                for (const state of ["default", "hover", "focus"]) {
                  if (state === "hover") await trigger.hover();
                  else {
                    await page.mouse.move(0, 899);
                    if (state === "focus") {
                      await tabTo(page, trigger);
                      assert.ok(
                        await trigger.evaluate((element) => {
                          const style = getComputedStyle(element);
                          const indicator =
                            style.boxShadow !== "none" ||
                            (style.outlineStyle !== "none" &&
                              Number.parseFloat(style.outlineWidth) >= 2);
                          return (
                            element === document.activeElement &&
                            element.matches(":focus-visible") &&
                            indicator
                          );
                        }),
                      );
                    }
                  }
                  await settleStyles(trigger);
                  const measured = await measureContrast(icon, "stroke");
                  measurements.push({
                    state,
                    ...measured,
                    headerBackground: await header.evaluate(
                      (element) => getComputedStyle(element).backgroundColor,
                    ),
                  });
                  await page.screenshot({
                    path: path.join(evidence, `${name}-${state}.png`),
                  });
                }
                await page.keyboard.press("Enter");
                const popup = page.getByRole("dialog");
                await popup.waitFor({ state: "visible" });
                const popupText = popup.getByTestId("text-notifications-empty");
                await settleStyles(popup);
                const popupContrast = await measureContrast(popupText, "color");
                measurements.push({ state: "popup", ...popupContrast });
                if (width === 1360) desktopPopup = popupContrast;
                else
                  assert.deepEqual(
                    popupContrast,
                    desktopPopup,
                    "mobile trigger treatment must not change popup colors",
                  );
                assert.ok(
                  popupContrast.ratio >= 4.5,
                  `popup text: ${popupContrast.ratio.toFixed(2)}:1`,
                );
                await page.keyboard.press("Escape");
                await assertDialogClosedAndFocusRestored(page, trigger);
                assert.deepEqual(errors, []);
                assert.deepEqual(
                  measurements.filter(
                    ({ state, ratio }) => state !== "popup" && ratio < 3,
                  ),
                  [],
                  "every icon state requires at least 3:1 against its composited surface",
                );
              } finally {
                try {
                  await writeFile(
                    path.join(evidence, `${name}.json`),
                    JSON.stringify(
                      { browser: browser.version(), measurements, errors },
                      null,
                      2,
                    ),
                  );
                  await context.tracing.stop({
                    path: path.join(evidence, `${name}.zip`),
                  });
                } finally {
                  await context.close();
                }
              }
            },
          );
        }
      }
    }
    t.diagnostic(`${browser.version()}; evidence: ${evidence}`);
  },
);
