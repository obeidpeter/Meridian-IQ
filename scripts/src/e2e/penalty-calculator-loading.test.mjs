/* global document */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { collectAccessibilityIssues, tabTo } from "./accessibility.mjs";
import { startStaticServer } from "./serve.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const built = path.join(root, "artifacts/penalty-calculator/dist/public");
const evidence = path.join(root, "tmp/penalty-calculator-loading");

describe(
  "calculator startup and lazy loading remain accessible",
  { timeout: 60_000 },
  () => {
    let browser;
    let server;
    let origin;
    let entry;
    let app;
    before(async () => {
      const html = await readFile(path.join(built, "index.html"), "utf8");
      entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
      assert.ok(entry, "build the calculator before this browser regression");
      const chunks = (await readdir(path.join(built, "assets"))).filter(
        (name) => /^App-.*\.js$/.test(name),
      );
      assert.equal(
        chunks.length,
        1,
        "the calculator must retain its lazy application chunk",
      );
      app = `/penalty-calculator/assets/${chunks[0]}`;
      await mkdir(evidence, { recursive: true });
      server = await startStaticServer({ port: 0, apiPort: 1 });
      origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      });
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
      }
    });

    for (const width of [1280, 320]) {
      for (const phase of ["startup", "loading", "failure", "ready"]) {
        test(`${phase} at ${width}px`, async (t) => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
          });
          let page;
          let unblock;
          const blocked = new Promise((resolve) => {
            unblock = resolve;
          });
          let signalBlockedRequest;
          const blockedRequest = new Promise((resolve) => {
            signalBlockedRequest = resolve;
          });
          t.after(async () => {
            unblock();
            try {
              await page?.unrouteAll({ behavior: "wait" });
            } finally {
              await context.close();
            }
          });
          page = await context.newPage();
          const errors = [];
          let failedChunk = false;
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname.startsWith("/api/"))
              return route.fulfill({ status: 204 });
            if (
              (phase === "startup" && url.pathname === entry) ||
              (phase === "loading" && url.pathname === app)
            ) {
              signalBlockedRequest();
              await blocked;
            }
            if (phase === "failure" && url.pathname === app && !failedChunk) {
              failedChunk = true;
              return route.abort("failed");
            }
            return route.continue();
          });
          await page.goto(`${origin}/penalty-calculator/`, {
            waitUntil: "commit",
          });
          await page.locator("#root").waitFor({ state: "attached" });
          if (phase === "startup" || phase === "loading") await blockedRequest;
          if (phase === "loading") await page.getByRole("status").waitFor();
          if (phase === "failure") await page.getByRole("alert").waitFor();
          if (phase === "ready")
            await page.getByLabel("Annual turnover").waitFor();
          const landmarks = await page.evaluate(() => ({
            main: document.querySelectorAll("main").length,
            h1: document.querySelectorAll("h1").length,
          }));
          t.diagnostic(
            JSON.stringify({
              browser: browser.version(),
              phase,
              width,
              ...landmarks,
            }),
          );
          // The entry script is deliberately held, so document.fonts.ready may
          // remain pending. Capture the actual frame without waiting for load.
          const capture = await context.newCDPSession(page);
          const { data } = await capture.send("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            path.join(evidence, `${phase}-${width}.png`),
            Buffer.from(data, "base64"),
          );
          await capture.detach();
          assert.deepEqual(landmarks, { main: 1, h1: 1 });
          assert.equal(await page.getByRole("banner").count(), 1);
          assert.equal(await page.getByRole("contentinfo").count(), 1);
          assert.equal(
            await page
              .getByRole("link", { name: "Open all apps", exact: true })
              .getAttribute("href"),
            "/login",
          );
          assert.deepEqual(await collectAccessibilityIssues(page), []);
          if (phase === "startup" || phase === "loading") {
            assert.match(
              await page.getByRole("status").textContent(),
              /Loading calculator/,
            );
            assert.equal(await page.getByLabel("Annual turnover").count(), 0);
            // Navigation remains mounted and focused when the calculator chunk arrives.
            const home = page.getByRole("link", {
              name: "Back to website",
              exact: true,
            });
            await home.focus();
            unblock();
            await page.getByLabel("Annual turnover").waitFor();
            assert.equal(
              await home.evaluate((node) => node === document.activeElement),
              true,
            );
            assert.equal(await page.getByRole("main").count(), 1);
            assert.equal(
              await page.getByRole("heading", { level: 1 }).count(),
              1,
            );
          }
          if (phase === "failure") {
            assert.ok(
              await page
                .getByRole("button", { name: "Try again", exact: true })
                .isVisible(),
            );
            assert.equal(
              await page
                .getByRole("link", { name: "Back to website", exact: true })
                .getAttribute("href"),
              "/",
            );
            await tabTo(
              page,
              page.getByRole("button", { name: "Try again", exact: true }),
            );
            await page.keyboard.press("Enter");
            await page.getByLabel("Annual turnover", { exact: true }).waitFor();
            assert.equal(await page.getByRole("alert").count(), 0);
            assert.equal(
              await page.getByRole("heading", { level: 1 }).count(),
              1,
            );
          } else {
            await page.getByLabel("Annual turnover").fill("1000000");
            await page
              .getByLabel(
                "Invoices issued without a valid e-invoice stamp (s.104)",
                { exact: true },
              )
              .fill("2");
            assert.match(
              await page.getByTestId("text-total").textContent(),
              /[1-9]/,
            );
            assert.deepEqual(errors, []);
          }
          const advisoryForm = page.locator("form").filter({
            has: page.getByRole("heading", {
              name: "Talk to an advisor (optional)",
              exact: true,
            }),
          });
          assert.match(
            await advisoryForm.innerText(),
            /That sends your email, optional business name, and the estimate summary to the Valo advisory team/,
          );
          assert.equal(
            await page.locator("#copyright-year").textContent(),
            String(new Date().getFullYear()),
          );
        });
      }
    }
  },
);
