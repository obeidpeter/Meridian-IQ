/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAxeResults, tabTo } from "./accessibility.mjs";
import {
  journeyCustomerFailureRecovery,
  journeyKeyboardRecovery,
} from "./journeys/reliability.mjs";
import { DEMO_PASSWORD } from "./journeys/shared.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidence = path.join(
  root,
  "tmp/reliability-customer-selectors",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const me = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId: "00000000-0000-4000-8000-000000000002",
  clientPartyId: "22222222-2222-4222-8222-222222222222",
  buyerPartyId: null,
  role: "firm_staff",
  email: "demo.staff@meridianiq.example",
  fullName: "Demo staff",
  capabilities: ["invoice.read", "invoice.write", "invoice.submit"],
  features: ["invoice_lifecycle"],
  consentCaptured: true,
  workspaceName: "Adaeze Foods Ltd",
  releaseTag: "R4",
};
const buyer = {
  id: "00000000-0000-4000-8000-000000000003",
  type: "buyer",
  legalName: "Local fixture buyer",
  tin: "10000003-0001",
};

// The real journey runs unchanged. Only HTTP data is replaced: this fixture
// has no database, rail or external service, and each test owns its session.
function fixtureApi() {
  let signedIn = false;
  const drafts = new Map();
  return createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    const reply = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      if (pathname === "/api/auth/logout") {
        signedIn = false;
        return reply(204);
      }
      if (pathname === "/api/auth/login") {
        if (body?.email !== me.email || body?.password !== DEMO_PASSWORD)
          return reply(401, { error: "UNAUTHORIZED" });
        signedIn = true;
        return reply(200, me);
      }
      if (pathname === "/api/me")
        return reply(
          signedIn ? 200 : 401,
          signedIn ? me : { error: "UNAUTHORIZED" },
        );
      if (pathname === "/api/healthz")
        return reply(200, { contractVersion: "0.99.0" });
      if (pathname === "/api/notifications")
        return reply(200, { items: [], unreadCount: 0, nextCursor: null });
      if (pathname === "/api/invoice-drafts")
        return reply(200, { items: [...drafts.values()], nextOffset: null });
      if (pathname.startsWith("/api/invoice-drafts/")) {
        const id = pathname.split("/").at(-1);
        if (request.method === "PUT") {
          drafts.set(id, {
            id,
            revision: body.expectedRevision + 1,
            writeId: body.writeId,
            draft: body.draft,
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 604800000).toISOString(),
          });
        }
        return drafts.has(id)
          ? reply(200, drafts.get(id))
          : reply(404, { error: "NOT_FOUND", message: "Draft not found" });
      }
      if (pathname === "/api/parties") return reply(200, [buyer]);
      if (pathname === `/api/parties/${buyer.id}`) return reply(200, buyer);
      if (pathname === "/api/invoices/page")
        return reply(200, { items: [], total: 0, nextCursor: null });
      if (
        [
          "/api/invoices",
          "/api/error-catalogue",
          "/api/line-item-suggestions",
        ].includes(pathname)
      )
        return reply(200, []);
      return reply(501, { error: "UNIMPLEMENTED_FIXTURE", path: pathname });
    } catch (error) {
      return reply(500, { error: error.message });
    }
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

for (const journey of [
  journeyKeyboardRecovery,
  journeyCustomerFailureRecovery,
]) {
  test(
    `${journey.name}: native draft options cannot stand in for customers`,
    { timeout: 60_000 },
    async (t) => {
      for (const app of ["landing", "sme-compliance"])
        await access(
          path.join(root, `artifacts/${app}/dist/public/index.html`),
        );
      await mkdir(evidence, { recursive: true });
      const api = fixtureApi();
      let server;
      let browser;
      let context;
      let page;
      const checks = [];
      t.after(async () => {
        try {
          if (page) {
            await page.screenshot({
              path: path.join(evidence, `${journey.name}.png`),
              fullPage: true,
            });
            await writeFile(
              path.join(evidence, `${journey.name}.json`),
              JSON.stringify(
                {
                  browser: browser.version(),
                  checks,
                  axe: await collectAxeResults(page).catch((error) => ({
                    captureError: error.message,
                  })),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          try {
            await context?.tracing.stop({
              path: path.join(evidence, `${journey.name}.zip`),
            });
          } finally {
            try {
              await browser?.close();
            } finally {
              try {
                await closeServer(server);
              } finally {
                await closeServer(api);
              }
            }
          }
        }
      });
      await new Promise((resolve, reject) => {
        api.once("error", reject);
        api.listen(0, "127.0.0.1", resolve);
      });
      server = await startStaticServer({
        port: 0,
        apiPort: api.address().port,
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      });
      context = await browser.newContext({
        viewport: { width: 1360, height: 900 },
        serviceWorkers: "block",
      });
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      await journey(page, origin, (label, ok, detail) => {
        checks.push({ label, ok, detail });
        assert.ok(ok, `${label}${detail ? `: ${detail}` : ""}`);
      });
      if (journey === journeyKeyboardRecovery) {
        const importLink = page.getByRole("link", {
          name: "bulk import",
          exact: true,
        });
        assert.equal(await importLink.getAttribute("href"), "/app/import");
        for (const width of [1360, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.mouse.move(0, 0);
          assert.ok(
            await importLink.evaluate((element) =>
              getComputedStyle(element).textDecorationLine.includes(
                "underline",
              ),
            ),
            `bulk import has a non-color link affordance without hover at ${width}px`,
          );
          await tabTo(page, importLink);
          assert.ok(
            await importLink.evaluate(
              (element) =>
                element === document.activeElement &&
                element.matches(":focus-visible") &&
                getComputedStyle(element).boxShadow !== "none",
            ),
            `bulk import has a visible keyboard focus indicator at ${width}px`,
          );
          checks.push({
            label: `bulk import: persistent underline and keyboard focus at ${width}px`,
            ok: true,
          });
        }
      }
      if (journey === journeyCustomerFailureRecovery) {
        const customers = page
          .getByRole("listbox", { name: "Customers", exact: true })
          .getByRole("option");
        assert.equal(await customers.count(), 1);
        assert.match(
          await customers.first().innerText(),
          /Local fixture buyer/,
        );
        assert.equal(
          await page.locator("#invoice-draft-slot option").count(),
          1,
        );
        assert.equal(
          await page.getByRole("option").first().textContent(),
          "Untitled invoice - Amount incomplete (current)",
        );
        await customers.first().click();
        const details = page.getByLabel("Selected draft details", {
          exact: true,
        });
        await details
          .getByText("Local fixture buyer", { exact: true })
          .waitFor();
        await page.locator("#line-0-description").fill("Quarterly support");
        await page.locator("#line-0-unit-price").fill("1000");
        await page
          .getByText("Saved to your account for 7 days", { exact: true })
          .waitFor();
        assert.match(
          await page
            .locator("#invoice-draft-slot option")
            .first()
            .textContent(),
          /Quarterly support.*1,075/,
        );
        for (const label of [
          "Last account save (Lagos time)",
          "Account draft expires (Lagos time)",
        ]) {
          const value = details
            .locator("div")
            .filter({ has: page.getByText(label, { exact: true }) })
            .locator("dd");
          await page.waitForFunction(() => {
            const values = [
              ...document.querySelectorAll(
                '[aria-label="Selected draft details"] dd',
              ),
            ];
            return values.every(
              (element) => element.textContent !== "Not available",
            );
          });
          assert.notEqual(await value.textContent(), "Not available");
        }
      }
      t.diagnostic(
        `${browser.version()}; ${checks.length} journey assertions; evidence: ${evidence}`,
      );
    },
  );
}
