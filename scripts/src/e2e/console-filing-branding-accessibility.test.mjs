/* global document, window */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAccessibilityIssues } from "./accessibility.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const output = path.join(
  root,
  "scripts/test-results/console-filing-branding",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const firmId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const me = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId,
  clientPartyId: clientId,
  buyerPartyId: null,
  role: "firm_admin",
  email: "demo.admin@valo.example",
  fullName: "Demo admin",
  workspaceName: "Valo Advisory Partners",
  capabilities: ["console.portfolio.read", "filing.read", "theme.write"],
  features: [],
  consentCaptured: true,
  releaseTag: "R0",
};
const matrix = {
  period: "2026-08",
  periodLabel: "August 2026",
  dueDates: { vat: "2099-09-21", paye: "2099-09-10", wht: "2099-09-21" },
  rows: [
    {
      clientPartyId: clientId,
      clientName: "Fixture client",
      vat: "filed",
      paye: "prepared",
      wht: "upcoming",
    },
    {
      clientPartyId: "33333333-3333-4333-8333-333333333333",
      clientName: "Second fixture client",
      vat: "upcoming",
      paye: null,
      wht: null,
    },
  ],
  totals: { clients: 2, filed: 1, unfiled: 4, overdue: 0 },
};
const cases = [
  { name: "filing-desk", path: "/console/filing-desk", ready: "Filing desk" },
  {
    name: "data-room-denied",
    path: "/console/data-room",
    ready: "Not available for your account",
  },
  ...[
    { name: "desktop", mode: "Desktop" },
    { name: "mobile", mode: "Mobile" },
    { name: "white", mode: "Desktop", primary: "0 0% 100%", width: 390 },
    { name: "black", mode: "Desktop", primary: "0 0% 0%", width: 390 },
    {
      name: "gray-777",
      mode: "Desktop",
      primary: "0 0% 46.666667%",
      width: 390,
    },
    {
      name: "wrapped",
      mode: "Desktop",
      primary: "hsl(152 60% 30%)",
      width: 390,
    },
  ].map((preview) => ({
    ...preview,
    name: `whitelabel-${preview.name}`,
    path: "/console/whitelabel",
    ready: "Branding",
  })),
  ...["loading", "error", "empty"].map((state) => ({
    name: `filing-desk-${state}`,
    path: "/console/filing-desk",
    ready: "Filing desk",
    endpoint: "/api/console/filing-matrix",
    state,
    width: 390,
  })),
  ...["loading", "error", "disabled"].map((state) => ({
    name: `whitelabel-${state}`,
    path: "/console/whitelabel",
    ready: state === "loading" ? "Branding" : "White-label branding",
    endpoint: `/api/firms/${firmId}`,
    state,
    width: 390,
  })),
  ...["withheld", "loading", "error"].map((state) => ({
    name: `data-room-${state}`,
    path: "/console/data-room",
    ready: "Credit data room",
    endpoint: "/api/credit/data-room",
    bank: true,
    state,
    width: 390,
  })),
];

test(
  "console filing, branding and denied Data Room: real built pages with read-only HTTP fixtures",
  { timeout: 300_000 },
  async (t) => {
    await access(path.join(root, "artifacts/console/dist/public/index.html"));
    await mkdir(output, { recursive: true });
    const server = await startStaticServer({ port: 0, apiPort: 1 });
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const results = [];
    for (const width of [320, 390, 1360]) {
      for (const scenario of cases
        .filter((entry) => !entry.width || entry.width === width)
        .flatMap((entry) =>
          ["light", "dark"].map((theme) => ({ ...entry, theme })),
        )) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          serviceWorkers: "block",
          colorScheme: scenario.theme,
        });
        const page = await context.newPage();
        const unexpected = [];
        const offlineFonts = [];
        const requested = [];
        const errors = [];
        const pendingReplies = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (
            url.origin === "https://fonts.googleapis.com" &&
            url.pathname === "/css2"
          ) {
            offlineFonts.push(url.pathname);
            return route.fulfill({
              contentType: "text/css",
              body: "/* Offline fixture uses the app's fallback fonts. */",
            });
          }
          if (url.origin !== base) {
            unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
            return route.abort();
          }
          if (!url.pathname.startsWith("/api/")) return route.continue();
          requested.push(url.pathname);
          const fixtures = {
            "/api/me": scenario.bank
              ? {
                  ...me,
                  role: "bank_user",
                  capabilities: ["credit.data_room.read"],
                }
              : me,
            "/api/healthz": { contractVersion: "0.100.0" },
            "/api/notifications": {
              items: [],
              unreadCount: 0,
              nextCursor: null,
            },
            "/api/operations": { items: [], nextCursor: null },
            "/api/console/filing-matrix": matrix,
            "/api/credit/data-room": {
              available: false,
              metrics: null,
              privacy: { minimumCohortSize: 5 },
            },
            [`/api/firms/${firmId}`]: {
              id: firmId,
              name: me.workspaceName,
              subdomain: "meridian-advisory",
              theme: { primary: "152 60% 30%" },
            },
          };
          if (request.method() !== "GET" || !(url.pathname in fixtures)) {
            unexpected.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({
              status: 501,
              json: { error: "UNIMPLEMENTED_FIXTURE" },
            });
          }
          if (url.pathname === scenario.endpoint) {
            if (scenario.state === "loading") {
              return new Promise((resolve) =>
                pendingReplies.push(async () => {
                  await route.fulfill({ json: fixtures[url.pathname] });
                  resolve();
                }),
              );
            }
            if (["error", "disabled"].includes(scenario.state)) {
              return route.fulfill({
                status: scenario.state === "disabled" ? 404 : 503,
                json: { error: "Fixture endpoint unavailable" },
              });
            }
            if (scenario.state === "empty")
              return route.fulfill({
                json: {
                  ...matrix,
                  rows: [],
                  totals: { clients: 0, filed: 0, unfiled: 0, overdue: 0 },
                },
              });
          }
          return route.fulfill({ json: fixtures[url.pathname] });
        });
        const name = `${scenario.name}-${scenario.theme}-${width}`;
        try {
          const endpointRequest = scenario.endpoint
            ? page.waitForRequest(
                (request) =>
                  new URL(request.url()).pathname === scenario.endpoint,
              )
            : null;
          await page.goto(base + scenario.path);
          await endpointRequest;
          await page.evaluate(
            (dark) => document.documentElement.classList.toggle("dark", dark),
            scenario.theme === "dark",
          );
          await page
            .getByText(scenario.ready, { exact: true })
            .last()
            .waitFor();
          if (scenario.state === "error")
            await page.getByTestId("text-error").waitFor();
          if (scenario.state === "disabled")
            await page.getByTestId("card-feature-unavailable").waitFor();
          if (scenario.state === "withheld")
            await page
              .getByRole("heading", {
                name: "Business group hidden for privacy",
              })
              .waitFor();
          if (scenario.state === "empty")
            await page
              .getByText("Every return is prepared or filed", { exact: true })
              .waitFor();
          if (scenario.mode) {
            await page.getByTestId("input-brand-name").waitFor();
            await page
              .getByRole("button", { name: scenario.mode, exact: true })
              .click();
            if (scenario.primary)
              await page
                .getByLabel("Primary colour (HSL)")
                .fill(scenario.primary);
          }
          if (scenario.name === "filing-desk")
            await page.getByTestId(`cell-filing-vat-${clientId}`).waitFor();
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.evaluate(() => document.fonts.ready);
          let axe;
          const issues = await collectAccessibilityIssues(page, {
            reportAxe: (report) => {
              axe = report;
            },
          });
          await page.screenshot({
            path: path.join(output, `${name}.png`),
            fullPage: true,
          });
          await writeFile(
            path.join(output, `${name}.axe.json`),
            JSON.stringify(axe, null, 2),
          );
          if (scenario.name === "data-room-denied")
            assert.ok(
              !requested.some((url) => url.startsWith("/api/credit/data-room")),
              "denied page must not fetch protected financial data",
            );
          results.push({ name, issues, unexpected, errors, offlineFonts });
        } finally {
          await Promise.all(pendingReplies.map((reply) => reply()));
          await context.close();
        }
      }
    }
    await writeFile(
      path.join(output, "summary.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          fixture:
            "Real built console; all API requests mocked read-only, no database; external font CSS replaced with empty CSS to use application fallback fonts",
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Console accessibility evidence: ${output}`);
    assert.deepEqual(
      results.filter(
        (result) =>
          result.issues.length ||
          result.unexpected.length ||
          result.errors.length,
      ),
      [],
    );
  },
);
