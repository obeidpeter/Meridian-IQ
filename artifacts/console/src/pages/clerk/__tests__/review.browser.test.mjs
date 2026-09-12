/* global document, window */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const require = createRequire(path.join(root, "scripts/package.json"));
const { chromium } = require("playwright");
const axe = require("axe-core");
const appRoot = path.join(root, "artifacts/console");
const appRequire = createRequire(path.join(appRoot, "package.json"));
const { build } = createRequire(appRequire.resolve("vite"))("esbuild");
const tailwindRequire = createRequire(appRequire.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const evidence = path.join(root, "tmp/clerk-review");
const extractionField = (field, value, flagged = false) => ({
  field,
  value,
  flagged,
  critical: true,
  confidence: flagged ? 0.72 : 0.99,
  sourceSnippet: `${field}: ${value}`,
});

const fixture = `
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { ClerkShell } from "./src/components/clerk-shell";
import { Toaster } from "./src/components/ui/toaster";
import { ClerkWorkspace } from "./src/pages/clerk/index";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}>
    <Router base="/console"><ClerkShell><ClerkWorkspace /></ClerkShell></Router>
    <Toaster />
  </QueryClientProvider>
);
`;

test(
  "Clerk desktop/mobile review, real image controls, keyboard focus and guarded decisions",
  { timeout: 120_000 },
  async () => {
    await mkdir(evidence, { recursive: true });
    const result = await build({
      absWorkingDir: appRoot,
      stdin: { contents: fixture, resolveDir: appRoot, loader: "tsx" },
      bundle: true,
      write: false,
      jsx: "automatic",
      alias: { "@": path.join(appRoot, "src") },
      loader: { ".css": "empty" },
      define: {
        "process.env.NODE_ENV": '"development"',
        "import.meta.env": JSON.stringify({
          BASE_URL: "/console/",
          MODE: "test",
          DEV: false,
          PROD: false,
        }),
      },
    });
    const cssRoot = path.join(appRoot, "src");
    const compiler = await compile(
      await readFile(path.join(cssRoot, "index.css"), "utf8"),
      { base: cssRoot, onDependency() {} },
    );
    const sources =
      compiler.root === "none"
        ? []
        : compiler.root === null
          ? [{ base: cssRoot, pattern: "**/*", negated: false }]
          : [{ ...compiler.root, negated: false }];
    const css =
      compiler.build(
        new Scanner({ sources: [...sources, ...compiler.sources] }).scan(),
      ) +
      (await readFile(path.join(cssRoot, "pages/clerk/review.css"), "utf8"));
    const html =
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clerk review verification</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api/")) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unmocked fixture request" }));
        return;
      }
      response.setHeader(
        "Content-Type",
        request.url === "/fixture.js"
          ? "text/javascript"
          : request.url === "/styles.css"
            ? "text/css"
            : "text/html",
      );
      response.end(
        request.url === "/fixture.js"
          ? result.outputFiles[0].text
          : request.url === "/styles.css"
            ? css
            : html,
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      const errors = [];
      const mutations = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const pages = await page.evaluate(() =>
        [1, 2].map((number) => {
          const canvas = document.createElement("canvas");
          canvas.width = 800;
          canvas.height = 1100;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, 800, 1100);
          ctx.fillStyle = "#163b32";
          ctx.fillRect(40, 45, 720, 8);
          ctx.font = "bold 40px sans-serif";
          ctx.fillText(`TEST INVOICE - PAGE ${number}`, 45, 120);
          ctx.fillStyle = "#111111";
          ctx.font = "25px sans-serif";
          [
            "Invoice INV-700",
            "Issue date: 1 September 2026",
            "Supplier: Fixture supplier",
            "Customer: Fixture customer",
            "",
            "Review services          2 x NGN 100.00",
            "VAT 7.5%                          NGN 15.00",
            "Total                              NGN 215.00",
          ].forEach((line, index) => ctx.fillText(line, 45, 220 + index * 70));
          return canvas.toDataURL("image/png").split(",")[1];
        }),
      );
      const fields = [
        extractionField("invoiceNumber", "INV-700", true),
        extractionField("issueDate", "2026-09-01"),
        extractionField("dueDate", "2026-09-30"),
        extractionField("currency", "NGN"),
      ];
      const baseCase = {
        id: "scan",
        kind: "extraction",
        status: "extracted",
        sourceType: "pdf",
        sourceName: "September invoice.pdf",
        sourceText: null,
        createdAt: "2026-09-01T12:00:00Z",
        updatedAt: "2026-09-01T12:00:00Z",
        createdBy: "operator",
        preflight: [
          {
            field: "invoiceNumber",
            message: "Confirm the invoice number against the source.",
          },
        ],
        extraction: {
          fields,
          lines: [
            {
              description: "Review services",
              quantity: "2",
              unitPrice: "100",
              vatRate: "0.075",
              confidence: 0.99,
            },
          ],
          model: "fixture",
          promptVersion: "test-v1",
        },
      };
      const cases = [
        baseCase,
        {
          ...baseCase,
          id: "voice",
          sourceName: "Original voice note",
          sourceType: "voice",
          sourceDurationSec: 15,
          sourceText:
            "Original transcript.\nInvoice INV-700 for review services.\nPlease keep this wording intact.",
        },
        {
          ...baseCase,
          id: "notice",
          kind: "notice",
          sourceName: "Notice review",
          sourceType: "text",
          sourceText:
            "Original notice reference REF-7. Respond by 30 September 2026.",
          extraction: null,
          preflight: [],
          noticeExtraction: {
            noticeType: "demand_notice",
            fields: [
              extractionField("referenceNumber", "REF-7", true),
              extractionField("authority", "firs"),
              extractionField("responseDueDate", "2026-09-30"),
            ],
            model: "fixture",
            promptVersion: "test-v1",
          },
        },
      ];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") {
          mutations.push({ path: url.pathname, data: request.postDataJSON() });
          return route.fulfill({
            status: 409,
            json: {
              code: "CASE_CLAIMED",
              error: "This case is claimed by another operator.",
            },
          });
        }
        let body = [];
        if (url.pathname === "/api/me")
          body = {
            userId: "operator",
            role: "operator",
            fullName: "Test operator",
            email: "fixture@example.test",
            capabilities: ["clerk.use", "clerk.read", "clerk.decide"],
            consentCaptured: true,
            features: ["clerk_ai"],
          };
        else if (url.pathname === "/api/healthz")
          body = { contractVersion: "0.103.0" };
        else if (url.pathname === "/api/feature-flags")
          body = [{ key: "clerk_ai", enabled: true }];
        else if (url.pathname === "/api/firms")
          body = [{ id: "firm", name: "Fixture firm" }];
        else if (url.pathname === "/api/parties")
          body = [
            { id: "supplier", legalName: "Fixture supplier" },
            { id: "buyer", legalName: "Fixture customer" },
          ];
        else if (url.pathname === "/api/clerk/cases")
          body = cases.filter(
            (item) =>
              item.kind === (url.searchParams.get("kind") ?? "extraction"),
          );
        else if (url.pathname.endsWith("/source-pages"))
          body = { pages, purged: false };
        else if (url.pathname.endsWith("/party-suggestions"))
          body = { supplier: [], buyer: [] };
        else if (url.pathname === "/api/clerk/metrics")
          body = { corrections: [] };
        else if (url.pathname.startsWith("/api/clerk/cases/"))
          body = cases.find((item) => url.pathname.endsWith(`/${item.id}`));
        return route.fulfill({ json: body ?? [] });
      });
      await page.goto(`${origin}/console/clerk`);
      await page.getByTestId("button-view-source-pages").click();
      await page.getByTestId("img-source-page-1").waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="img-source-page-1"]')
            ?.naturalWidth === 800,
      );

      const source = page.getByRole("region", {
        name: "Source document",
        exact: true,
      });
      const next = page.getByRole("button", {
        name: "Next field needing review",
      });
      const desktopSource = await source.boundingBox();
      const desktopReview = await next.boundingBox();
      assert(
        desktopSource.x + desktopSource.width <= desktopReview.x + 1,
        "Desktop source and review must be side by side",
      );
      await next.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .getByLabel("Invoice number", { exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.getByLabel("Invoice number", { exact: true }).fill("INV-701");
      await page.keyboard.press("Enter");
      assert.equal(
        mutations.length,
        0,
        "Editing or field navigation must not submit",
      );
      await page.screenshot({
        path: path.join(evidence, "desktop-review.png"),
        fullPage: false,
      });
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.getByRole("button", { name: "Rotate clockwise" }).focus();
      await page.keyboard.press("Space");
      assert.match(
        await page.getByTestId("img-source-page-1").getAttribute("style"),
        /rotate\(90deg\)/,
      );
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      assert.equal(
        await page.getByTestId("img-source-page-2").getAttribute("src"),
        `data:image/png;base64,${pages[1]}`,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Next page", exact: true })
          .isDisabled(),
        true,
      );
      await page.getByRole("button", { name: "Reset document view" }).click();
      assert.match(
        await page.getByTestId("document-viewer").innerText(),
        /100%/,
      );
      const pixels = await page
        .getByTestId("img-source-page-2")
        .evaluate((image) => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(50, 48, 1, 1).data];
        });
      assert.deepEqual(
        pixels,
        [22, 59, 50, 255],
        "Source bitmap must actually render",
      );

      for (const width of [1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        const sourceBox = await source.boundingBox();
        const reviewBox = await next.boundingBox();
        if (width >= 1024)
          assert(sourceBox.x + sourceBox.width <= reviewBox.x + 1);
        else
          assert(
            sourceBox.y + sourceBox.height <= reviewBox.y + 1,
            "Mobile must stack source above review",
          );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
          `No horizontal overflow at ${width}px`,
        );
        if (width === 390) {
          await page.screenshot({
            path: path.join(evidence, "mobile-source.png"),
          });
          await next.focus();
          await page.keyboard.press("Space");
          await page.screenshot({
            path: path.join(evidence, "mobile-review.png"),
          });
        }
      }

      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByTestId("select-firm").click();
      await page.getByRole("option", { name: "Fixture firm" }).click();
      await page.getByTestId("select-supplier").click();
      await page.getByRole("option", { name: "Fixture supplier" }).click();
      await page.getByTestId("select-buyer").click();
      await page.getByRole("option", { name: "Fixture customer" }).click();
      const summary = page.getByRole("region", { name: "Approval summary" });
      assert.match(await summary.innerText(), /INV-701/);
      assert.match(await summary.innerText(), /not submitted or filed/);
      assert.equal(mutations.length, 0);
      await page.getByTestId("button-approve-case").click();
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="button-approve-case"]')
            ?.disabled,
      );
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0].data.invoiceNumber, "INV-701");
      assert.equal(mutations[0].data.lines[0].vatRate, "0.075");
      await page
        .getByText("This case is claimed by another operator.", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByTestId("banner-draft-created").count(),
        0,
        "Claim rejection must not become success",
      );

      const queueSummary = page
        .locator("summary")
        .filter({ hasText: "Queue and capture" });
      await queueSummary.click();
      await page.getByTestId("row-case-voice").click();
      assert.equal(
        await page
          .getByRole("region", { name: "Original source text" })
          .innerText(),
        cases[1].sourceText,
      );
      assert.equal(await page.getByTestId("document-viewer").count(), 0);
      await page.getByTestId("tab-kind-notice").click();
      await page.getByTestId("row-case-notice").click();
      assert.match(
        await page
          .getByRole("region", { name: "Approval summary" })
          .innerText(),
        /open response obligation/,
      );
      assert.equal(
        await page.getByTestId("button-approve-notice").isDisabled(),
        true,
      );
      await page.evaluate(axe.source);
      const accessibility = await page.evaluate(async () =>
        globalThis.axe.run(
          document.querySelector('[aria-label="Case review"]'),
          {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          },
        ),
      );
      assert.deepEqual(
        accessibility.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target),
        })),
        [],
      );
      assert.deepEqual(errors, []);
      console.log(`Screenshots: ${evidence}`);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
