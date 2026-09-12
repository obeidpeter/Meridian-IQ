/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { collectAccessibilityIssues } from "../../../../../scripts/src/e2e/accessibility.mjs";

const repo = path.resolve(import.meta.dirname, "../../../../..");
const app = path.join(repo, "artifacts/sme-compliance");
const configRequire = createRequire(
  path.join(repo, "lib/web-config/package.json"),
);
const scriptsRequire = createRequire(path.join(repo, "scripts/package.json"));
const { chromium } = scriptsRequire("playwright");
const { createServer } = await import(
  pathToFileURL(configRequire.resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(configRequire.resolve("@vitejs/plugin-react")).href
);
const { default: tailwind } = await import(
  pathToFileURL(configRequire.resolve("@tailwindcss/vite")).href
);
const output = path.join(repo, "tmp/invoice-workspace-browser");

const invoice = (id = "invoice-1") => ({
  id,
  firmId: "firm",
  supplierPartyId: "supplier",
  buyerPartyId: "buyer",
  kind: "invoice",
  category: "b2b",
  relatedInvoiceId: null,
  invoiceNumber:
    id === "invoice-1" ? `INV-${"LongReference".repeat(9)}` : `INV-${id}`,
  currency: "NGN",
  fxRateToNgn: null,
  issueDate: "2026-08-01",
  dueDate: "2026-09-30",
  status: "stamped",
  subtotal: "987654321000.00",
  vatTotal: "0",
  grandTotal: "987654321000.00",
  whtCategory: null,
  notes: "Supporting invoice context. ".repeat(12),
  legalHold: false,
  retentionUntil: null,
  contentRevision: 1,
  schemaVersion: 1,
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-01T09:00:00Z",
});

async function mockRecords(page, state) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname;
    let body = [];
    if (endpoint === "/api/me")
      body = {
        userId: "user",
        firmId: "firm",
        clientPartyId: "supplier",
        role: "client_user",
        capabilities: ["invoice.read"],
        features: [],
      };
    else if (endpoint === "/api/invoices/page") {
      const start = url.searchParams.has("cursor") ? 50 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      body = {
        items: Array.from({ length: limit }, (_, i) => ({
          ...invoice(`row-${start + i}`),
          buyerLegalName: "Ada & Co",
        })),
        nextCursor: start === 0 ? "second-page" : null,
        total: 100,
      };
    } else if (/\/invoices\/[^/]+$/.test(endpoint)) {
      const record = invoice(endpoint.split("/").at(-1));
      body = {
        invoice: record,
        lines: [
          {
            id: "line",
            invoiceId: record.id,
            lineNo: 1,
            description: "UnbrokenLineDescription".repeat(15),
            quantity: "2",
            unitPrice: "493827160500.00",
            vatRate: "0",
            lineExtension: record.subtotal,
            vatAmount: "0",
          },
        ],
      };
    } else if (endpoint.includes("/parties/"))
      body = { id: "buyer", legalName: "LongCustomerName".repeat(15) };
    else if (endpoint.endsWith("/stamp"))
      body = {
        id: "stamp",
        invoiceId: "invoice-1",
        irn: "IRN-" + "reference".repeat(30),
        csid: "CSID-" + "signature".repeat(30),
        rail: "rail_primary",
        createdAt: "2026-08-03T09:00:00Z",
      };
    else if (endpoint.endsWith("/settlements") && state.failPayments)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Payment records unavailable" }),
      });
    else if (
      endpoint.endsWith("/status-light") ||
      endpoint.endsWith("/rejection-risk")
    )
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function assertContentFits(page) {
  const clipped = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "main h1, main h2, main p, main dd, main [role=tabpanel] button",
      ),
    ]
      .filter((element) => {
        if (element.closest("[hidden]")) return false;
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          (element.scrollWidth > element.clientWidth + 2 ||
            rect.left < -1 ||
            rect.right > document.documentElement.clientWidth + 1)
        );
      })
      .map(
        (element) => `${element.tagName}: ${element.textContent.slice(0, 80)}`,
      ),
  );
  assert.deepEqual(clipped, []);
  assert.equal(await page.getByRole("tabpanel").count(), 1);
  const issues = await collectAccessibilityIssues(page);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          !element.closest("[hidden]") &&
          rect.width > 1 &&
          rect.right > document.documentElement.clientWidth + 1
        );
      })
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className),
        text: element.textContent.slice(0, 50),
        right: element.getBoundingClientRect().right,
      })),
  );
  assert.deepEqual(issues, [], JSON.stringify({ issues, overflow }));
}

test(
  "invoice workspace responsive tabs, hidden errors and return context",
  { timeout: 180_000 },
  async (t) => {
    const server = await createServer({
      configFile: false,
      root: path.join(import.meta.dirname, "browser-fixture"),
      plugins: [react(), tailwind()],
      resolve: {
        alias: { "@": path.join(app, "src") },
        dedupe: ["react", "react-dom"],
      },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await server.close();
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    await mkdir(output, { recursive: true });

    for (const width of [320, 768, 1440]) {
      for (const theme of ["light", "dark"]) {
        await t.test(`${theme} at ${width}px`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const state = { failPayments: true };
          await mockRecords(page, state);
          try {
            await page.goto(`${origin}/invoices/invoice-1`);
            await page.evaluate(
              (theme) =>
                document.documentElement.classList.toggle(
                  "dark",
                  theme === "dark",
                ),
              theme,
            );
            await page.getByTestId("invoice-workspace-issues").waitFor();
            assert.match(
              await page.getByTestId("invoice-workspace-issues").textContent(),
              /Payments/,
            );
            assert.ok(
              await page
                .getByRole("tab", { name: "Payments", exact: true })
                .getAttribute("aria-describedby"),
            );
            await page.screenshot({
              path: path.join(output, `${theme}-${width}-initial.png`),
              fullPage: true,
            });
            await assertContentFits(page);
            for (const tab of [
              "Overview",
              "Documents",
              "Approvals",
              "Payments",
              "History",
            ]) {
              await page.getByRole("tab", { name: tab, exact: true }).click();
              await assertContentFits(page);
              if (tab === "Overview" && width >= 768) {
                const amount = await page
                  .getByRole("region", { name: "Invoice overview" })
                  .locator("p.tabular-nums")
                  .evaluate((element) => ({
                    height: element.getBoundingClientRect().height,
                    lineHeight: Number.parseFloat(
                      getComputedStyle(element).lineHeight,
                    ),
                  }));
                assert.ok(
                  amount.height <= amount.lineHeight + 1,
                  "A long customer name must not squeeze the invoice amount into fragments",
                );
              }
              await page.screenshot({
                path: path.join(
                  output,
                  `${theme}-${width}-${tab.toLowerCase()}.png`,
                ),
                fullPage: true,
              });
            }
            const history = page.getByRole("tab", {
              name: "History",
              exact: true,
            });
            await history.focus();
            await page.keyboard.press("Home");
            assert.equal(
              await page
                .getByRole("tab", { name: "Overview", exact: true })
                .evaluate((element) => document.activeElement === element),
              true,
            );
            await page
              .getByRole("tab", { name: "Payments", exact: true })
              .click();
            state.failPayments = false;
            await page
              .getByRole("button", { name: "Try again", exact: true })
              .click();
            await page
              .getByText("No payment events recorded for this invoice.")
              .waitFor();
            await page
              .getByTestId("invoice-workspace-issues")
              .waitFor({ state: "hidden" });
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }
    }

    await t.test(
      "list filters and scroll survive opening a second-page invoice",
      async () => {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        await mockRecords(page, { failPayments: false });
        try {
          await page.goto(
            `${origin}/invoices?q=Ada+%26+Co&filter=stamped&advanced=1&minAmount=100`,
          );
          await page.getByTestId("button-load-more").click();
          const row = page.getByRole("link", { name: /INV-row-74 / });
          await row.scrollIntoViewIfNeeded();
          const top = await page.evaluate(() => window.scrollY);
          await row.click();
          await page
            .getByRole("tab", { name: "Overview", exact: true })
            .waitFor();
          await page
            .getByRole("link", { name: "Back to vault", exact: true })
            .click();
          await page.waitForFunction(
            (top) => Math.abs(window.scrollY - top) < 3,
            top,
          );
          assert.equal(
            await page.getByLabel("Search invoices").inputValue(),
            "Ada & Co",
          );
          assert.equal(
            await page.getByLabel("Min amount (₦)").inputValue(),
            "100",
          );
          assert.equal(
            await page
              .getByTestId("filter-invoices-stamped")
              .getAttribute("aria-pressed"),
            "true",
          );
          assert.match(
            await page.getByTestId("text-showing-count").textContent(),
            /Showing 100 of 100/,
          );
        } finally {
          await page.close();
        }
      },
    );
  },
);
