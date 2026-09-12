/* global document, window */
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

async function sidebarHelp(page, width) {
  if (width < 1024) await page.getByTestId("button-menu").click();
  await page.locator('[data-testid="nav-help"]:visible').click();
}

async function searchNavigate(page, app, width, destination) {
  if (width < 1024) {
    await page
      .getByRole("button", {
        name: app === "console" ? "Search workspaces" : "Search workspace",
        exact: true,
      })
      .click();
  } else {
    await page.getByTestId("button-command-menu").click();
  }
  await page
    .getByRole("dialog")
    .getByRole("searchbox")
    .fill(`Unsaved regression ${destination}`);
  await page
    .getByRole("option", {
      name: new RegExp(`Unsaved regression ${destination}`),
    })
    .click();
}

async function exerciseNavigation({ page, app, width, patches, failSave }) {
  const form = page.getByRole("form", { name: "Business details" });
  const city = page.getByRole("textbox", { name: "City" });
  const modal = page.getByRole("alertdialog");
  const helpPath = `/${app}/help`;
  const businessPath =
    app === "console"
      ? `/console/clients/${partyId}/business`
      : "/app/business";

  // Build genuine in-app history using the sidebar and the command menu's
  // useLocation navigate(), not synthetic popstate events or raw pushState.
  await sidebarHelp(page, width);
  await page.waitForURL((url) => url.pathname === helpPath);
  await searchNavigate(page, app, width, "business");
  await form.waitFor();
  const businessUrl = page.url();
  assert.equal(new URL(businessUrl).search, "?regression=history");
  await city.fill("Kano");
  await page.evaluate(() => window.history.back());
  await modal.waitFor();
  await page.waitForURL(businessUrl);
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Stay",
  );
  assert.deepEqual((await collectAxeResults(page)).violations, []);
  await page.screenshot({
    path: path.join(output, `${app}-unsaved-${width}.png`),
    fullPage: true,
  });
  await modal.getByRole("button", { name: "Stay", exact: true }).click();
  assert.equal(await city.inputValue(), "Kano");

  // Validation failure cannot count as a saved form or release Back.
  const legalName = page.getByRole("textbox", { name: "Legal business name" });
  const originalName = await legalName.inputValue();
  await legalName.fill("");
  const beforeInvalid = patches.length;
  await page.evaluate(() => window.history.back());
  await modal.waitFor();
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await modal.getByRole("alert").waitFor();
  assert.equal(patches.length, beforeInvalid);
  await modal.getByRole("button", { name: "Stay", exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("name") === "legalName",
  );
  assert.equal(await legalName.inputValue(), "");
  await legalName.fill(originalName);

  // Actual failed fetch and HTTP 409 preserve all input and the pending route.
  for (const failure of ["network", "conflict"]) {
    failSave(failure);
    await page.evaluate(() => window.history.back());
    await modal.waitFor();
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await modal.getByRole("alert").waitFor();
    assert.equal(page.url(), businessUrl);
    await modal.getByRole("button", { name: "Stay", exact: true }).click();
    assert.equal(await city.inputValue(), "Kano");
    assert.equal(await legalName.inputValue(), originalName);
  }
  failSave(null);
  const beforeSave = patches.length;
  await page.evaluate(() => window.history.back());
  await modal.waitFor();
  await modal.getByRole("button", { name: "Save", exact: true }).dblclick();
  await page.waitForURL((url) => url.pathname === helpPath);
  assert.equal(patches.length, beforeSave + 1);
  await page.evaluate(() => window.history.forward());
  await form.waitFor();
  assert.equal(await city.inputValue(), "Kano");
  assert.equal(page.url(), businessUrl);

  // A second later entry makes Forward from a dirty business page testable.
  await sidebarHelp(page, width);
  await page.waitForURL((url) => url.pathname === helpPath);
  await page.evaluate(() => window.history.back());
  await form.waitFor();
  await city.fill("Ilorin");
  await page.evaluate(() => window.history.forward());
  await modal.waitFor();
  await page.waitForURL(businessUrl);
  await modal.getByRole("button", { name: "Stay", exact: true }).click();
  assert.equal(await city.inputValue(), "Ilorin");
  const beforeDiscard = patches.length;
  await page.evaluate(() => window.history.forward());
  await modal.waitFor();
  await modal.getByRole("button", { name: "Discard", exact: true }).click();
  await page.waitForURL((url) => url.pathname === helpPath);
  assert.equal(patches.length, beforeDiscard);
  await page.evaluate(() => window.history.back());
  await form.waitFor();
  assert.equal(await city.inputValue(), "Kano");

  await city.fill("Ibadan");
  await sidebarHelp(page, width);
  await modal.waitFor();
  await modal.getByRole("button", { name: "Stay", exact: true }).click();
  assert.equal(await city.inputValue(), "Ibadan");
  // The command menu is a programmatic route attempt, not a Link.
  await searchNavigate(page, app, width, "help");
  await modal.waitFor();
  await modal.getByRole("button", { name: "Discard", exact: true }).click();
  await page.waitForURL((url) => url.pathname === helpPath);
  await page.evaluate(() => window.history.back());
  await form.waitFor();
  assert.equal(new URL(page.url()).pathname, businessPath);
  assert.equal(await city.inputValue(), "Kano");
  assert.equal(patches.length, beforeDiscard);

  // A real document reload must use the native fallback, never silently drop
  // a dirty draft. Dismissing it retains both the input and mounted editor.
  await city.fill("Benin City");
  const nativeDialog = page.waitForEvent("dialog");
  const reload = page.reload({ timeout: 5000 }).catch(() => null);
  const warning = await nativeDialog;
  assert.equal(warning.type(), "beforeunload");
  await warning.dismiss();
  await reload;
  assert.equal(await city.inputValue(), "Benin City");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
}

test(
  "built business-details routes protect navigation and support keyboard, retry and scoped PATCH without overflow",
  { timeout: 300_000 },
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
            // Simulate an entry created before this router took ownership.
            // Its traversal distance is unknown to the adapter by design.
            await context.addInitScript(() => {
              if (
                window.location.pathname.includes("business") &&
                window.history.state === null
              ) {
                const original = window.location.href;
                window.history.replaceState(
                  { fixture: "pre-router-entry" },
                  "",
                  "/legacy-before-router",
                );
                window.history.pushState(null, "", original);
              }
            });
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
            let forcedSaveFailure = null;
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
                  url.pathname === "/api/public/usability-events" &&
                  request.method() === "POST"
                ) {
                  return route.fulfill({
                    status: 202,
                    json: { accepted: true },
                  });
                }
                if (url.pathname === "/api/workspace/search") {
                  const business = url.searchParams
                    .get("q")
                    ?.includes("business");
                  return route.fulfill({
                    json: [
                      {
                        id: business ? "unsaved-business" : "unsaved-help",
                        label: `Unsaved regression ${business ? "business" : "help"}`,
                        description: "Synthetic route regression result",
                        group: "Pages",
                        href: business
                          ? `${app === "console" ? `/clients/${partyId}/business` : "/business"}?regression=history`
                          : "/help",
                      },
                    ],
                  });
                }
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
                  if (forcedSaveFailure === "network")
                    return route.abort("failed");
                  if (forcedSaveFailure === "conflict")
                    return route.fulfill({
                      status: 409,
                      json: { error: "Synthetic concurrent business edit." },
                    });
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
              await page
                .getByRole("textbox", { name: "City" })
                .fill("Untracked history draft");
              const unknownWarning = page.waitForEvent("dialog");
              await page.evaluate(() => window.history.back());
              const unknownDialog = await unknownWarning;
              assert.equal(unknownDialog.type(), "beforeunload");
              await unknownDialog.dismiss();
              assert.equal(
                await page.getByRole("textbox", { name: "City" }).inputValue(),
                "Untracked history draft",
              );
              // Native Back already moved the address before reload was refused.
              // Forward restores the owned entry without losing the editor.
              await page.evaluate(() => window.history.forward());
              await page.waitForURL(`${origin}${routePath}`);
              await page
                .getByRole("button", { name: "Discard changes", exact: true })
                .click();
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
              await exerciseNavigation({
                page,
                app,
                width,
                patches,
                failSave: (failure) => {
                  forcedSaveFailure = failure;
                },
              });
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
