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
const evidence = path.join(
  root,
  "tmp/activity-accessibility",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const me = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId: "00000000-0000-4000-8000-000000000002",
  clientPartyId: null,
  buyerPartyId: null,
  role: "firm_admin",
  email: "demo.admin@meridianiq.example",
  fullName: "Demo administrator",
  capabilities: ["invoice.read", "invoice.write"],
  features: ["invoice_lifecycle"],
  consentCaptured: true,
  workspaceName: "Activity fixture firm",
  releaseTag: "R4",
};
// Distinct committed operations legitimately have the same visible title/status.
const operations = [3, 4].map((id) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  command: "invoice.create",
  idempotencyKey: `activity-fixture-${id}`,
  status: "succeeded",
  route: "/invoices",
  summary: `Invoice ACT-${id} saved.`,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));

for (const [name, viewport] of [
  ["reflow", { width: 320, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1360, height: 900 }],
]) {
  test(
    `Console activity repeated summaries: ${name}`,
    { timeout: 30_000 },
    async (t) => {
      await access(path.join(root, "artifacts/console/dist/public/index.html"));
      await mkdir(evidence, { recursive: true });
      const server = await startStaticServer({ port: 0, apiPort: 1 });
      t.after(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      );
      const origin = `http://127.0.0.1:${server.address().port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      });
      t.after(() => browser.close());
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
      });
      const unexpected = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const fixtures = {
          "/api/me": me,
          "/api/healthz": { contractVersion: "0.99.0" },
          "/api/notifications": { items: [], unreadCount: 0, nextCursor: null },
          "/api/operations": { operations, nextCursor: null },
        };
        const body = fixtures[url.pathname];
        if (!body) unexpected.push(url.pathname);
        return route.fulfill({
          status: body ? 200 : 501,
          contentType: "application/json",
          body: JSON.stringify(body ?? { error: "UNIMPLEMENTED_FIXTURE" }),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`${origin}/console/activity`);
      await page.getByText("Server history checked", { exact: true }).waitFor();
      const history = page.getByRole("region", {
        name: "Recent operations",
        exact: true,
      });
      assert.equal(await history.count(), 1);
      assert.equal(await history.getByRole("listitem").count(), 2);
      const summaries = history.getByRole("group", {
        name: "Create invoice: Completed",
        exact: true,
      });
      assert.equal(await summaries.count(), 2);
      for (const summary of await summaries.all()) {
        assert.equal(await summary.getAttribute("aria-live"), "polite");
        assert.equal(
          await summary.getByText("Create invoice", { exact: true }).count(),
          1,
        );
        assert.equal(
          await summary.getByText("Completed", { exact: true }).count(),
          1,
        );
      }
      assert.equal(await history.getByRole("region").count(), 0);
      let axe;
      const issues = await collectAccessibilityIssues(page, {
        reportAxe: (results) => {
          axe = results;
        },
      });
      await page.screenshot({
        path: path.join(evidence, `${name}.png`),
        fullPage: true,
      });
      await writeFile(
        path.join(evidence, `${name}.json`),
        JSON.stringify(
          {
            browser: browser.version(),
            viewport,
            issues,
            axe,
            unexpected,
          },
          null,
          2,
        ),
      );
      t.diagnostic(`Evidence: ${path.join(evidence, name)}`);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(issues, []);
    },
  );
}
