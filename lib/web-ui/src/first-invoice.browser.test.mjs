/* global document */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import {
  collectAccessibilityIssues,
  tabTo,
} from "../../../scripts/src/e2e/accessibility.mjs";

const scriptsRequire = createRequire(
  new URL("../../../scripts/package.json", import.meta.url),
);
const appRequire = createRequire(
  new URL("../../../artifacts/console/package.json", import.meta.url),
);
const { chromium } = scriptsRequire("playwright");
const { build } = createRequire(appRequire.resolve("vite"))("esbuild");
const packageRoot = path.resolve(import.meta.dirname, "..");
const output = path.resolve(
  packageRoot,
  "../../tmp/first-invoice",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

// Render the actual shared component and stylesheet without app builds, an API,
// credentials or a database. The existing Vite toolchain supplies the bundler.
const fixture = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TodayWorkspace } from "./src/today";
const state = new URLSearchParams(location.search).get("state");
const setup = [
  { id: "two_factor", label: "Protect the account with two-factor authentication", complete: true },
  { id: "business_identity", label: "Confirm the business details", complete: true },
  { id: "first_customer", label: "Add the first customer", complete: false },
  { id: "first_invoice", label: "Save the first invoice", complete: false },
  { id: "invoice_validation", label: "Validate the invoice", complete: false },
  { id: "invoice_evidence", label: "Open the recorded invoice history", complete: false },
].map(step => ({ ...step, complete: state === "complete" || step.complete,
  href: "/" + step.id, description: "Review the saved business record and the details required for this invoice." }));
function Fixture() {
  const [opened, setOpened] = useState("");
  return <main tabIndex={-1}><TodayWorkspace eyebrow="Valo Today" title="Your business today"
    description="Invoices and shared work from live records."
    generatedAt="2026-09-09T08:00:00Z"
    summary={{ total: 125, urgent: 0, dueSoon: 0, blocked: 0, completedSetupSteps: 2, totalSetupSteps: 6 }}
    items={[{id: "one", title: "Review invoice INV-001", description: "Business details need attention.",
      priority: "normal", status: "draft", href: "/invoices/one", dueAt: null, clientName: null, source: "invoice"}]}
    setup={state === "empty" ? [] : setup} setupError={state === "error" ? "Records could not be loaded." : null}
    onRetrySetup={() => setOpened("retry")} onOpen={setOpened} />
    <output data-testid="opened" aria-label="Opened destination">{opened}</output>
  </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

test(
  "first-invoice journey keyboard, accessibility and responsive states",
  { timeout: 120_000 },
  async (t) => {
    const result = await build({
      absWorkingDir: packageRoot,
      stdin: { contents: fixture, resolveDir: packageRoot, loader: "tsx" },
      bundle: true,
      write: false,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    const css = await readFile(
      path.join(packageRoot, "src/styles.css"),
      "utf8",
    );
    const html = `<!doctype html><html lang="en"><head><title>First-invoice journey verification</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
    <style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:var(--mi-canvas);color:var(--mi-ink)}
    main{padding:16px;max-width:1440px;margin:auto}button{font:inherit}output{display:block;margin-top:16px}</style>
    </head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
    const server = createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/fixture.js"
          ? "text/javascript"
          : req.url === "/styles.css"
            ? "text/css"
            : "text/html",
      );
      res.end(
        req.url === "/fixture.js"
          ? result.outputFiles[0].text
          : req.url === "/styles.css"
            ? css
            : html,
      );
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await mkdir(output, { recursive: true });
    for (const width of [320, 768, 1360]) {
      for (const theme of ["light", "dark"]) {
        await t.test(`${theme} at ${width}px`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: 1000 },
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.route("**/*", (route) =>
              new URL(route.request().url()).origin === origin
                ? route.continue()
                : route.abort(),
            );
            await page.goto(origin);
            await page.evaluate(
              (theme) =>
                document.documentElement.classList.toggle(
                  "dark",
                  theme === "dark",
                ),
              theme,
            );
            const next = page.getByRole("button", {
              name: "Continue: Add the first customer",
            });
            await tabTo(page, next);
            await page.keyboard.press("Enter");
            assert.equal(
              await page.getByTestId("opened").textContent(),
              "/first_customer",
            );
            assert.equal(
              await page.getByRole("progressbar").getAttribute("aria-valuenow"),
              "33",
            );
            await page.keyboard.press("Tab");
            assert.match(
              await page.evaluate(() => document.activeElement.textContent),
              /Protect the account/,
            );
            await page.keyboard.press("Shift+Tab");
            assert.equal(
              await next.evaluate(
                (element) => element === document.activeElement,
              ),
              true,
            );
            await page.keyboard.press("Space");
            assert.equal(
              await page.getByTestId("opened").textContent(),
              "/first_customer",
            );
            await page.locator("main").focus();
            assert.deepEqual(await collectAccessibilityIssues(page), []);
            assert.equal(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth <=
                  document.documentElement.clientWidth,
              ),
              true,
            );
            await page.screenshot({
              path: path.join(output, `${theme}-${width}.png`),
              fullPage: true,
            });
            for (const state of ["complete", "empty", "error"]) {
              await page.goto(`${origin}/?state=${state}`);
              await page
                .getByRole("heading", { name: "Your business today" })
                .waitFor();
              await page.evaluate(
                (theme) =>
                  document.documentElement.classList.toggle(
                    "dark",
                    theme === "dark",
                  ),
                theme,
              );
              assert.equal(
                await page.getByRole("button", { name: /^Continue:/ }).count(),
                0,
              );
              if (state === "complete") {
                assert.equal(
                  await page
                    .getByRole("progressbar")
                    .getAttribute("aria-valuenow"),
                  "100",
                );
              } else {
                assert.equal(await page.getByRole("progressbar").count(), 0);
              }
              if (state === "error") {
                await page.getByRole("button", { name: "Retry setup" }).focus();
                await page.keyboard.press("Enter");
                assert.equal(
                  await page.getByTestId("opened").textContent(),
                  "retry",
                );
              }
              await page.locator("main").focus();
              assert.deepEqual(await collectAccessibilityIssues(page), []);
            }
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }
    }
    t.diagnostic(`Screenshots: ${output}`);
  },
);
