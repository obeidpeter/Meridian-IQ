/* global document */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues } from "./accessibility.mjs";

const evidence = new URL(
  "../../../tmp/usability-improvements/",
  import.meta.url,
);
let server;
let browser;
let origin;

before(async () => {
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
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }
});

async function open(t, width, workspace) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const errors = [];
  const writes = [];
  const state = { confirmation: "requested" };
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() !== "GET") {
      writes.push({ path, body: request.postDataJSON() });
      if (path === "/api/invoices/fixture-invoice/confirmations") {
        state.confirmation = request.postDataJSON().state;
        return reply({ id: "fixture-response", state: state.confirmation });
      }
      return reply({ error: "Unexpected fixture write" }, 500);
    }
    if (path === "/api/me")
      return reply({
        userId: "fixture-user",
        firmId: "fixture-firm",
        clientPartyId: workspace === "app" ? "fixture-business" : null,
        buyerPartyId: workspace === "buyer" ? "fixture-buyer" : null,
        role:
          workspace === "buyer"
            ? "buyer_user"
            : workspace === "console"
              ? "firm_admin"
              : "client_user",
        email: "usability@meridianiq.example",
        fullName: "Local usability fixture",
        workspaceName: "Example Business",
        capabilities: [
          "invoice.read",
          "invoice.write",
          "invoice.submit",
          "work.read",
          "party.read",
          "console.portfolio.read",
        ],
        features: ["invoice_lifecycle", "buyer_rails"],
        consentCaptured: true,
        releaseTag: "R4",
      });
    if (path === "/api/healthz") return reply({ contractVersion: "0.99.0" });
    if (path === "/api/notifications")
      return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path === "/api/workspace/today")
      return reply({
        generatedAt: "2026-09-05T12:00:00Z",
        summary: {
          total: 0,
          urgent: 0,
          dueSoon: 0,
          blocked: 0,
          completedSetupSteps: 1,
          totalSetupSteps: 2,
        },
        items: [],
        setup: [
          {
            id: "invoice",
            label: "Create invoice",
            description: "First invoice",
            complete: true,
            href: "/invoices",
          },
          {
            id: "consent",
            label: "Review consent",
            description: "Sharing choices",
            complete: false,
            href: "/consent",
          },
        ],
      });
    if (path === "/api/buyer/invoices/fixture-invoice")
      return reply({
        id: "fixture-invoice",
        invoiceNumber: "INV-FIXTURE-001",
        supplierPartyId: "fixture-supplier",
        supplierName: "Example Supplier",
        status: "stamped",
        grandTotal: "1075.00",
        vatTotal: "75.00",
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
        confirmationState: state.confirmation,
        stampValid: true,
        eligible: true,
      });
    return reply([]);
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "No page runtime errors");
  });
  return { page, state, writes };
}

async function audit(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const issues = await collectAccessibilityIssues(page);
  await page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, evidence)),
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(
    new URL(`${name}.json`, evidence),
    JSON.stringify(
      {
        scope:
          "Compiled local pages with synthetic API fixtures, not participant testing",
        viewport: page.viewportSize(),
        issues,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(issues, [], `${name}: accessibility and reflow`);
}

for (const width of [320, 768, 1024, 1440]) {
  for (const workspace of ["app", "console"]) {
    test(`${workspace} daily navigation and setup status at ${width}px`, async (t) => {
      const { page, writes } = await open(t, width, workspace);
      await page.goto(
        `${origin}/${workspace}/${workspace === "console" ? "today" : ""}`,
      );
      await page
        .getByRole("button", {
          name: "Create invoice Completed First invoice",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Review consent Not completed Sharing choices",
            exact: true,
          })
          .count(),
        1,
      );
      await audit(page, `${workspace}-today-${width}`);
      if (width < 1024) await page.getByTestId("button-menu").click();
      const nav = page.getByRole("navigation", {
        name: workspace === "app" ? "Workspace" : "Console",
        exact: true,
      });
      const daily = nav.getByRole("button", {
        name: "Daily work",
        exact: true,
      });
      assert.equal(await daily.getAttribute("aria-expanded"), "true");
      const secondary = nav.getByRole("button", {
        name:
          workspace === "app"
            ? "Invoices and money"
            : "Client services and setup",
        exact: true,
      });
      assert.equal(await secondary.getAttribute("aria-expanded"), "false");
      await secondary.focus();
      await page.keyboard.press("Enter");
      assert.equal(await secondary.getAttribute("aria-expanded"), "true");
      await audit(page, `${workspace}-navigation-${width}`);
      await secondary.focus();
      await page.keyboard.press("Enter");
      assert.equal(await secondary.getAttribute("aria-expanded"), "false");
      assert.deepEqual(writes, [], "Navigation does not change data");
    });
  }
  test(`buyer query and fresh-request recovery at ${width}px`, async (t) => {
    const { page, state, writes } = await open(t, width, "buyer");
    await page.goto(`${origin}/buyer/invoices/fixture-invoice`);
    await page.getByTestId("button-response-queried").click();
    await page
      .getByLabel("Note (required)")
      .fill("Please explain the delivery charge.");
    await page.getByTestId("button-submit-response").click();
    await page.getByTestId("card-response-recorded").waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.state, "queried");
    await page
      .getByRole("button", { name: "Check for a new request", exact: true })
      .click();
    await page.getByText("No new request yet", { exact: true }).waitFor();
    assert.equal(
      await page.getByTestId("card-response-recorded").isVisible(),
      true,
    );
    await audit(page, `buyer-query-${width}`);
    state.confirmation = "requested";
    await page
      .getByRole("button", { name: "Check for a new request", exact: true })
      .click();
    await page.getByTestId("card-respond").waitFor();
    assert.equal(await page.locator("#note").inputValue(), "");
    assert.equal(
      await page.getByTestId("button-submit-response").isDisabled(),
      true,
    );
    assert.equal(
      writes.length,
      1,
      "Checking for a new request never records another response",
    );
    await audit(page, `buyer-new-request-${width}`);
  });
}
