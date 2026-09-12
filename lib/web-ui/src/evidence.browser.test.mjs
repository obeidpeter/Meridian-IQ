/* global document, window */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { collectAccessibilityIssues } from "../../../scripts/src/e2e/accessibility.mjs";
import {
  evidenceFixtureDetail,
  evidenceFixtureIds,
  evidenceFixtureMe,
} from "./evidence-fixtures.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
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
const output = path.join(repo, "tmp/evidence-hub");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixtureRoutes(page, state, app) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname;
    const reply = (body, status = 200, contentType = "application/json") =>
      route.fulfill({
        status,
        contentType,
        body:
          typeof body === "string" || Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body),
      });
    state.calls.push({
      endpoint,
      method: request.method(),
      search: url.search,
    });
    if (endpoint === "/api/me")
      return reply({
        ...evidenceFixtureMe,
        role: app === "sme" ? "client_user" : "firm_staff",
        clientPartyId: app === "sme" ? evidenceFixtureIds.client : null,
        features: state.dark ? [] : ["evidence_hub"],
      });
    if (endpoint === "/api/parties")
      return reply([
        {
          id: evidenceFixtureIds.client,
          legalName: "Example Client Ltd",
          type: "client_business",
        },
      ]);
    if (endpoint === "/api/console/team")
      return reply([
        {
          userId: evidenceFixtureIds.user,
          fullName: "Ada Okafor",
          role: "firm_staff",
        },
        {
          userId: "00000000-0000-4000-8000-000000000099",
          fullName: "Tunde Akin",
          role: "firm_admin",
        },
      ]);
    if (endpoint === `/api/parties/${evidenceFixtureIds.client}`)
      return reply({
        id: evidenceFixtureIds.client,
        legalName: "Example Client Ltd",
        type: "client_business",
      });
    if (endpoint === "/api/evidence/requests" && request.method() === "GET")
      return fixtureList(url, state, reply);
    if (await fixtureMutation(request, endpoint, state, reply, route)) return;
    if (endpoint.endsWith("/download"))
      return reply(
        state.detail.files[0].contentType === "image/png" ? png : "%PDF-test",
        200,
        "application/octet-stream",
      );
    if (endpoint.endsWith("/pack")) return fixturePack(state, reply);
    if (/\/api\/evidence\/requests\/[^/]+$/.test(endpoint))
      return reply(state.detail);
    throw new Error(`Unmocked API route: ${request.method()} ${endpoint}`);
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, (route) =>
    route.abort("blockedbyclient"),
  );
}

async function fits(page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const overflow = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "main, [role=dialog], .evidence-row, .evidence-field, .evidence-sheet button, .evidence-sheet p",
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          !element.closest('[aria-hidden="true"]') &&
          rect.width > 0 &&
          (rect.right > window.innerWidth + 2 ||
            rect.left < -2 ||
            element.scrollWidth > element.clientWidth + 2)
        );
      })
      .map((element) => element.textContent.slice(0, 90)),
  );
  assert.deepEqual(overflow, []);
  assert.deepEqual(await collectAccessibilityIssues(page), []);
}

test(
  "self-hosted Evidence Hub: both app adapters, responsive review, upload retry and safe media",
  { timeout: 240_000 },
  async (t) => {
    const server = await createServer({
      configFile: false,
      root: path.join(import.meta.dirname, "evidence-browser-fixture"),
      plugins: [react(), tailwind()],
      resolve: {
        alias: {
          "@": path.join(repo, "artifacts/console/src"),
          "@tanstack/react-query": path.join(
            repo,
            "artifacts/console/node_modules/@tanstack/react-query",
          ),
        },
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
    for (const app of ["console", "sme"])
      for (const width of [320, 768, 1440]) {
        await t.test(`${app} at ${width}px`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          page.setDefaultTimeout(10_000);
          page.setDefaultNavigationTimeout(30_000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const state = {
            detail: structuredClone(evidenceFixtureDetail),
            calls: [],
            creates: [],
            uploads: [],
            reviews: [],
            updates: [],
            scans: [],
            assists: 0,
            scanAvailable: false,
            failList: true,
          };
          if (width === 768) {
            state.detail.files[0].contentType = "image/png";
            state.detail.files[0].filename = "delivery.png";
            state.detail.files[0].byteSize = png.length;
          }
          if (width === 320)
            state.detail.request.title = "DeliveryEvidence".repeat(10);
          await fixtureRoutes(page, state, app);
          try {
            await page.goto(
              `${origin}/?app=${app}&theme=${width === 768 ? "dark" : "light"}`,
            );
            await page.getByRole("alert").waitFor();
            await page.getByRole("button", { name: "Try again" }).click();
            await page
              .getByRole("button", {
                name: new RegExp(state.detail.request.title),
              })
              .waitFor();
            await fits(page);
            await page.screenshot({
              path: path.join(output, `${app}-${width}-list.png`),
              fullPage: true,
            });
            await page
              .getByRole("button", { name: "Next page", exact: true })
              .click();
            await page.getByRole("button", { name: /Last request/ }).waitFor();
            assert.ok(
              state.calls.some((call) => call.search.includes("offset=20")),
            );
            await page
              .getByRole("combobox", { name: "Status", exact: true })
              .selectOption("cancelled");
            await page
              .getByRole("heading", { name: "No evidence requests" })
              .waitFor();
            await page
              .getByRole("combobox", { name: "Status", exact: true })
              .selectOption("");
            const opener = page.getByRole("button", {
              name: new RegExp(state.detail.request.title),
            });
            await opener.click();
            const dialog = page.getByRole("dialog");
            await dialog
              .getByRole("heading", { name: "File versions (1)" })
              .waitFor();
            await fits(page);
            assert.equal(state.assists, 0);
            assert.equal(
              await page.locator("iframe, object, embed").count(),
              0,
            );
            if (width === 768) {
              await dialog
                .getByRole("button", { name: "Preview image" })
                .click();
              await page.waitForFunction(
                () =>
                  document.querySelector("img.evidence-preview")?.naturalWidth >
                  0,
              );
              await assertDownloadFocus(dialog, "Close preview");
              await fits(page);
              await page.screenshot({
                path: path.join(output, `${app}-${width}-image.png`),
                fullPage: true,
              });
              await dialog
                .getByRole("button", { name: "Close preview" })
                .click();
              assert.equal(await dialog.locator("img").count(), 0);
            } else
              assert.equal(
                await dialog
                  .getByRole("button", { name: "Preview image" })
                  .count(),
                0,
              );
            const fileDownload = page.waitForEvent("download");
            await dialog
              .getByRole("button", { name: "Download", exact: true })
              .click();
            assert.match(
              (await fileDownload).suggestedFilename(),
              /\.(pdf|png)$/,
            );
            await assertDownloadFocus(dialog, "Download");
            await fits(page);
            assert.equal(
              await dialog
                .getByRole("button", { name: "Download pack" })
                .isDisabled(),
              true,
            );
            if (app === "console") {
              await dialog
                .getByRole("button", { name: "Edit assignment and deadline" })
                .click();
              await dialog
                .getByRole("combobox", { name: "Request owner", exact: true })
                .selectOption("00000000-0000-4000-8000-000000000099");
              await dialog.getByLabel("Request deadline (optional)").fill("");
              await dialog
                .getByRole("button", { name: "Save assignment" })
                .click();
              await dialog
                .getByRole("button", { name: "Edit assignment and deadline" })
                .waitFor();
              assert.equal(state.updates[0].dueAt, null);
              await dialog
                .getByRole("button", { name: "Ask Clerk to assist" })
                .click();
              await dialog
                .getByRole("heading", { name: "Clerk assistance" })
                .waitFor();
              assert.equal(state.assists, 1);
              await dialog
                .getByRole("combobox", { name: "Decision", exact: true })
                .selectOption("accepted");
              await dialog
                .getByRole("button", { name: "Record decision" })
                .click();
              await page.waitForFunction(() =>
                document.querySelector('[data-state="accepted"]'),
              );
              assert.equal(state.reviews[0].fileId, evidenceFixtureIds.file);
            } else {
              assert.equal(
                await dialog
                  .getByRole("form", { name: "Review evidence" })
                  .count(),
                0,
              );
              await dialog
                .getByLabel("PDF or photo (up to 5 MB)")
                .setInputFiles({
                  name: "replacement.pdf",
                  mimeType: "application/pdf",
                  buffer: Buffer.from("%PDF-replacement"),
                });
              await dialog
                .getByRole("button", { name: "Upload document", exact: true })
                .click();
              await dialog
                .getByRole("button", { name: "Retry upload" })
                .click();
              await dialog
                .getByRole("heading", { name: "File versions (2)" })
                .waitFor();
              assert.deepEqual(state.uploads[0], state.uploads[1]);
              assert.equal(
                await dialog
                  .getByRole("button", { name: "Download", exact: true })
                  .count(),
                1,
              );
              assert.equal(
                await dialog
                  .getByRole("button", { name: "Download pack" })
                  .isDisabled(),
                true,
              );
              simulateRemoteStaffAcceptance(state);
              await dialog
                .getByRole("button", { name: "Refresh record" })
                .click();
              await dialog.locator('[data-state="accepted"]').waitFor();
              assert.equal(state.reviews.length, 0);
            }
            const packDownload = page.waitForEvent("download");
            await dialog.getByRole("button", { name: "Download pack" }).click();
            assert.match((await packDownload).suggestedFilename(), /\.zip$/);
            await assertDownloadFocus(dialog, "Download pack");
            await fits(page);
            await page.screenshot({
              path: path.join(output, `${app}-${width}-detail.png`),
              fullPage: true,
            });
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden" });
            await page.waitForFunction(() =>
              document.activeElement?.classList.contains("evidence-row"),
            );
            assert.equal(
              await page.evaluate(() =>
                Object.keys(localStorage).some((key) => /evidence/i.test(key)),
              ),
              false,
            );
            assert.deepEqual(errors, []);
          } catch (error) {
            await page.screenshot({
              path: path.join(output, `${app}-${width}-failure.png`),
              fullPage: true,
            });
            throw new Error(
              `${error.message}\nPage errors: ${JSON.stringify(errors)}\nBody: ${(await page.locator("body").innerText()).slice(0, 1200)}`,
              { cause: error },
            );
          } finally {
            await page.close();
          }
        });
      }
  },
);

async function assertDownloadFocus(dialog, name) {
  await dialog
    .locator('button[aria-busy="false"]')
    .filter({ hasText: new RegExp(`^${name}$`) })
    .waitFor();
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    true,
    `${name} must retain focus inside the evidence dialog`,
  );
}

function fixturePack(state, reply) {
  const { request, files } = state.detail;
  const cleanAcceptedFile = files.some(
    (file) => file.id === request.acceptedFileId && file.scanStatus === "clean",
  );
  if (request.status !== "accepted" || !cleanAcceptedFile)
    return reply(
      { error: "Accept a clean evidence file before exporting a pack" },
      409,
    );
  return reply(Buffer.from([80, 75, 3, 4]), 200, "application/zip");
}

function simulateRemoteStaffAcceptance(state) {
  const { request, files, events } = state.detail;
  const file = files.find((item) => item.id === request.latestFileId);
  assert.ok(file);
  // Simulate scanner completion and a separate staff review, never a client action.
  file.scanStatus = "clean";
  file.scanError = null;
  file.scannedAt = "2026-09-12T11:00:00Z";
  request.status = "accepted";
  request.acceptedFileId = file.id;
  request.version += 1;
  events.push({
    id: "remote-staff-review",
    requestId: request.id,
    actorId: "00000000-0000-4000-8000-000000000099",
    action: "accepted",
    comment: "Reviewed the replacement document.",
    fileId: file.id,
    createdAt: "2026-09-12T11:01:00Z",
  });
}

async function fixtureMutation(request, endpoint, state, reply, route) {
  const send = (...args) => reply(...args).then(() => true);
  if (endpoint === "/api/evidence/requests" && request.method() === "POST") {
    const body = request.postDataJSON();
    state.creates.push(body);
    if (state.creates.length === 1)
      return route.abort("failed").then(() => true);
    state.detail.request = {
      ...state.detail.request,
      ...body,
      version: 1,
      status: "requested",
    };
    return send(state.detail, 201);
  }
  if (endpoint.endsWith("/files") && request.method() === "POST") {
    const body = request.postDataJSON();
    state.uploads.push(body);
    if (state.uploads.length === 1)
      return route.abort("failed").then(() => true);
    state.detail.files.push({
      ...state.detail.files[0],
      id: "uploaded-file",
      filename: body.filename,
      contentType: body.contentType,
      scanStatus: "quarantined",
      scanError: null,
      createdAt: "2026-09-12T10:00:00Z",
    });
    state.detail.request.version += 1;
    state.detail.request.latestFileId = "uploaded-file";
    return send(state.detail);
  }
  if (endpoint.endsWith("/review")) {
    const body = request.postDataJSON();
    state.reviews.push(body);
    state.detail.request.status = body.decision;
    state.detail.request.version += 1;
    state.detail.request.acceptedFileId =
      body.decision === "accepted" ? body.fileId : null;
    state.detail.events.push({
      id: "review-1",
      requestId: state.detail.request.id,
      actorId: evidenceFixtureIds.user,
      action: body.decision,
      comment: body.comment ?? null,
      fileId: body.fileId ?? null,
      createdAt: "2026-09-12T11:00:00Z",
    });
    return send(state.detail);
  }
  if (request.method() === "PATCH") {
    const body = request.postDataJSON();
    state.updates.push(body);
    Object.assign(state.detail.request, body, {
      version: state.detail.request.version + 1,
    });
    return send(state.detail);
  }
  if (endpoint.endsWith("/assist")) {
    state.assists += 1;
    return send({
      summary: "The source requires staff review.",
      suggestedDocumentType: "delivery_note",
      extractedText: "Signed delivery note",
      checks: [
        {
          label: "Invoice reference",
          status: "unknown",
          sourceValue: null,
          expectedValue: "INV-001",
        },
      ],
    });
  }
  if (endpoint.endsWith("/scan")) {
    state.scans.push(request.postDataJSON());
    return send(state.detail);
  }
  return false;
}

function fixtureList(url, state, reply) {
  if (state.failList) {
    state.failList = false;
    return reply({ error: "Unavailable" }, 503);
  }
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const status = url.searchParams.get("status");
  const items =
    status === "cancelled"
      ? []
      : Array.from({ length: offset ? 1 : 20 }, (_, i) => ({
          ...state.detail.request,
          id:
            offset || i
              ? `00000000-0000-4000-8000-${String(100 + offset + i).padStart(12, "0")}`
              : state.detail.request.id,
          title: offset
            ? "Last request"
            : i
              ? `Order supporting evidence ${i}`
              : state.detail.request.title,
        }));
  return reply({
    items,
    total: status === "cancelled" ? 0 : 21,
    uploadAvailable: true,
    scanAvailable: state.scanAvailable,
    notice: state.scanAvailable
      ? null
      : "Scanning unavailable; new documents remain quarantined.",
  });
}
