/* global document */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { startStaticServer } from "../../../scripts/src/e2e/serve.mjs";
import {
  collectAxeResults,
  tabTo,
} from "../../../scripts/src/e2e/accessibility.mjs";
import { shellFixtures } from "../../../scripts/src/e2e/workspace-usability-fixtures.mjs";

// The record stamp the built editors load, and the one an accepted save moves it to (R113).
const LOADED_AT = "2026-09-09T08:00:00Z";
const SAVED_AT = "2026-09-09T09:00:00Z";

const require = createRequire(
  new URL("../../../scripts/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(
  root,
  "tmp/business-details",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const partyId = "00000000-0000-4000-8000-000000000007";
const partyEndpoint = `/api/parties/${partyId}`;

test(
  "built business-details routes support keyboard, retry and scoped PATCH without overflow",
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
    for (const app of ["console", "app"]) {
      for (const width of [320, 1440]) {
        for (const theme of ["light", "dark"]) {
          await t.test(`${app} ${theme} at ${width}px`, async () => {
            const context = await browser.newContext({
              viewport: { width, height: 1000 },
              serviceWorkers: "block",
              colorScheme: theme,
              reducedMotion: "reduce",
            });
            const fixtures = shellFixtures();
            fixtures["/api/me"] = {
              ...fixtures["/api/me"],
              role: app === "console" ? "firm_staff" : "client_user",
              clientPartyId: app === "app" ? partyId : null,
              capabilities: [
                "party.read",
                "invoice.read",
                "work.read",
                ...(app === "console"
                  ? ["party.write", "console.portfolio.read"]
                  : []),
              ],
            };
            let party = {
              id: partyId,
              type: "client_business",
              legalName: "Acme Trading Limited",
              tin: "1234567890",
              tinValidated: false,
              cacNumber: "RC12345",
              street: "1 Market Road",
              city: "Lagos",
              countryCode: "NG",
              mergedIntoId: null,
              createdAt: "2026-09-09T08:00:00Z",
              updatedAt: LOADED_AT,
            };
            let rejectSave = true;
            let rejectRead = false;
            const patches = [];
            const unexpected = [];
            const pageErrors = [];
            try {
              await context.route("**/*", async (route) => {
                const request = route.request();
                const url = new URL(request.url());
                if (
                  url.origin === "https://fonts.googleapis.com" &&
                  url.pathname === "/css2"
                )
                  return route.fulfill({
                    contentType: "text/css",
                    body: "/* offline fixture */",
                  });
                if (url.origin !== origin) {
                  unexpected.push(
                    `${request.method()} ${url.origin}${url.pathname}`,
                  );
                  return route.abort();
                }
                if (!url.pathname.startsWith("/api/")) return route.continue();
                if (
                  url.pathname === partyEndpoint &&
                  request.method() === "GET"
                )
                  return route.fulfill({
                    status: rejectRead ? 404 : 200,
                    json: rejectRead
                      ? { error: "Synthetic unavailable business" }
                      : party,
                  });
                if (
                  url.pathname === partyEndpoint &&
                  request.method() === "PATCH"
                ) {
                  const patch = request.postDataJSON();
                  patches.push(patch);
                  await new Promise((resolve) => setTimeout(resolve, 100));
                  if (rejectSave)
                    return route.fulfill({
                      status: 400,
                      json: { error: "Synthetic save rejected." },
                    });
                  // R113: the built editor sends the stamp of the record it
                  // edited; the fixture refuses a stale one like the server
                  // and moves the stamp on every accepted save.
                  const { expectedUpdatedAt, ...fields } = patch;
                  if (expectedUpdatedAt !== party.updatedAt)
                    return route.fulfill({
                      status: 409,
                      json: { error: "Synthetic stale record." },
                    });
                  party = { ...party, ...fields, updatedAt: SAVED_AT };
                  return route.fulfill({ json: party });
                }
                if (
                  request.method() === "GET" &&
                  Object.hasOwn(fixtures, url.pathname)
                )
                  return route.fulfill({ json: fixtures[url.pathname] });
                unexpected.push(`${request.method()} ${url.pathname}`);
                return route.fulfill({
                  status: 501,
                  json: { error: "UNIMPLEMENTED_FIXTURE" },
                });
              });
              const page = await context.newPage();
              page.setDefaultTimeout(15_000);
              page.on("pageerror", (error) => pageErrors.push(error.message));
              const routePath =
                app === "console"
                  ? `/console/clients/${partyId}/business`
                  : "/app/business?clientPartyId=another-client";
              await page.goto(`${origin}${routePath}`);
              const form = page.getByRole("form", { name: "Business details" });
              await form.waitFor();
              await page.evaluate(
                (theme) =>
                  document.documentElement.classList.toggle(
                    "dark",
                    theme === "dark",
                  ),
                theme,
              );
              await tabTo(
                page,
                page.getByRole("textbox", { name: "Legal business name" }),
                120,
              );
              const tin = page.getByRole("textbox", {
                name: "Tax identification number (TIN)",
              });
              await tin.fill("invalid");
              await tin.press("Enter");
              assert.equal(await tin.getAttribute("aria-invalid"), "true");
              assert.equal(patches.length, 0);
              await tin.fill("1234567890");
              await page.getByRole("textbox", { name: "City" }).fill("Abuja");
              const save = page.getByRole("button", {
                name: "Save business details",
                exact: true,
              });
              await save.focus();
              await page.keyboard.press("Space");
              await page
                .getByText("Synthetic save rejected.", { exact: true })
                .waitFor();
              assert.equal(
                await page.getByRole("textbox", { name: "City" }).inputValue(),
                "Abuja",
              );
              assert.deepEqual(patches, [
                { city: "Abuja", expectedUpdatedAt: LOADED_AT },
              ]);
              assert.equal(
                await page
                  .getByText("Correct the highlighted business details.")
                  .count(),
                0,
              );
              rejectSave = false;
              await save.dblclick();
              await page
                .getByText("Business details saved.", { exact: true })
                .waitFor();
              assert.deepEqual(patches, [
                { city: "Abuja", expectedUpdatedAt: LOADED_AT },
                { city: "Abuja", expectedUpdatedAt: LOADED_AT },
              ]);
              assert.deepEqual((await collectAxeResults(page)).violations, []);
              const countryBounds = await page
                .getByRole("textbox", { name: "Country code" })
                .boundingBox();
              const saveBounds = await save.boundingBox();
              assert.ok(countryBounds && saveBounds);
              assert.ok(
                saveBounds.y >= countryBounds.y + countryBounds.height + 16,
                "Save actions must remain separated from the final input",
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
                path: path.join(output, `${app}-${theme}-${width}.png`),
                fullPage: true,
              });
              rejectRead = true;
              await page.reload();
              await page
                .getByText("Unable to load business details.", { exact: true })
                .waitFor();
              assert.equal(
                await page
                  .getByRole("form", { name: "Business details" })
                  .count(),
                0,
              );
              assert.deepEqual((await collectAxeResults(page)).violations, []);
              rejectRead = false;
              await page
                .getByRole("button", { name: "Try again", exact: true })
                .click();
              await form.waitFor();
              assert.equal(
                await page.getByRole("textbox", { name: "City" }).inputValue(),
                "Abuja",
              );
              assert.deepEqual(unexpected, []);
              assert.deepEqual(pageErrors, []);
            } finally {
              await context.close();
            }
          });
        }
      }
    }
    t.diagnostic(`Screenshots: ${output}`);
  },
);
