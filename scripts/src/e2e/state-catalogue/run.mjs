import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { collectAxeResults } from "../accessibility.mjs";
import { measureActionReadability } from "./readability.mjs";
import { assertDialogClosedAndFocusRestored } from "./dialog-focus.mjs";
import { verifyDialogFocusGuard } from "./dialog-focus.testing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const configRequire = createRequire(
  path.join(root, "lib/web-config/package.json"),
);
const uiRequire = createRequire(path.join(root, "lib/web-ui/package.json"));
const { build, preview } = await import(
  pathToFileURL(configRequire.resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(configRequire.resolve("@vitejs/plugin-react")).href
);
const { default: tailwind } = await import(
  pathToFileURL(configRequire.resolve("@tailwindcss/vite")).href
);
const selectedStates = new Set(
  process.argv
    .find((argument) => argument.startsWith("--states="))
    ?.slice(9)
    .split(",") ?? [],
);
const out = path.resolve(
  process.env.CATALOGUE_OUT_DIR ??
    path.join(
      root,
      "tmp/state-catalogue-r198",
      selectedStates.size ? "followup" : "",
    ),
);
await mkdir(out, { recursive: true });
const states = [
  "loading",
  "empty",
  "offline",
  "stale",
  "partial",
  "forbidden",
  "disabled",
  "failed",
  "route-failed",
  "dialog",
  "running",
];
for (const state of selectedStates)
  assert(states.includes(state), `Unknown catalogue state: ${state}`);
const activeStates = selectedStates.size
  ? states.filter((state) => selectedStates.has(state))
  : states;
const cases = ["light", "dark"].flatMap((theme) =>
  [320, 768, 1440].flatMap((width) =>
    activeStates.map((state) => ({ state, theme, width, text: 100 })),
  ),
);
cases.push(
  ...["light", "dark"].flatMap((theme) =>
    activeStates.map((state) => ({
      state,
      theme,
      width: 320,
      text: 200,
    })),
  ),
);
const config = {
  configFile: false,
  root: here,
  plugins: [react(), tailwind()],
  resolve: {
    alias: ["react", "react-dom"].map((name) => ({
      find: name,
      replacement: path.dirname(uiRequire.resolve(`${name}/package.json`)),
    })),
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: path.join(out, "site"), emptyOutDir: true },
  preview: { host: "127.0.0.1", port: 0 },
};
await build(config);
const server = await preview(config);
let browser;
const report = {
  generatedAt: new Date().toISOString(),
  browser: "",
  executable: "",
  cases: [],
  interactions: [],
  readabilitySelfTest: [],
  dialogFocusSelfTest: [],
};
try {
  const base = server.resolvedUrls.local[0];
  const installed = chromium.executablePath();
  const executable =
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (existsSync(installed)
      ? installed
      : process.platform === "win32"
        ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
        : undefined);
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
  });
  report.browser = browser.version();
  report.executable = executable ?? installed;
  const probe = await browser.newPage();
  await probe.setContent(`<style>
    .mi-activity__actions button { display: flex; box-sizing: border-box; width: 48px; padding: 8px; font: 24px sans-serif; overflow-wrap: anywhere; }
    .mi-activity__action-label { min-width: 0; }
  </style><div class="mi-activity__actions"><button><span class="mi-activity__action-label">Verify result</span></button></div>`);
  let measured = await probe.evaluate(measureActionReadability);
  assert(
    await probe.evaluate(() => {
      const label = globalThis.document.querySelector(
        ".mi-activity__action-label",
      );
      return label.scrollWidth <= label.clientWidth + 2;
    }),
    "Readability regression fixture must fit horizontally",
  );
  assert(
    measured.failures[0]?.brokenWords.length,
    "Readability guard missed letter-by-letter wrapping",
  );
  report.readabilitySelfTest.push(
    "rejects words split across lines even without horizontal overflow",
  );
  await probe.addStyleTag({
    content: ".mi-activity__actions button { overflow-wrap: normal; }",
  });
  measured = await probe.evaluate(measureActionReadability);
  assert(
    measured.failures.some(
      (action) => action.usableWidth + 2 < action.requiredWordWidth,
    ),
    "Readability guard missed insufficient label width",
  );
  report.readabilitySelfTest.push(
    "rejects insufficient usable width for intact words",
  );
  await probe.addStyleTag({
    content: ".mi-activity__actions button { width: 110px; }",
  });
  measured = await probe.evaluate(measureActionReadability);
  assert.equal(
    measured.failures.length,
    0,
    "Readability guard rejected normal word wrapping",
  );
  assert(
    measured.actions[0].labelLines > 1,
    "Readability control fixture must wrap between words",
  );
  report.readabilitySelfTest.push(
    "accepts a readable label wrapped between intact words",
  );
  await probe.setContent(`<style>
    .mi-network-status__copy { display: block; width: 48px; font: 24px sans-serif; overflow-wrap: anywhere; }
    .mi-network-status__copy small { display: block; font: inherit; }
  </style><div class="mi-network-status"><span class="mi-network-status__copy"><small>Reconnect before submitting</small></span></div>`);
  measured = await probe.evaluate(measureActionReadability);
  assert(
    measured.failures.some((item) =>
      item.brokenWords.some((word) => word.word === "Reconnect"),
    ),
    "Readability guard missed broken words in connectivity copy",
  );
  report.readabilitySelfTest.push(
    "rejects ordinary words split in connectivity copy",
  );
  await probe.addStyleTag({
    content: ".mi-network-status__copy { width: 180px; }",
  });
  measured = await probe.evaluate(measureActionReadability);
  assert.equal(
    measured.failures.length,
    0,
    "Readability guard rejected intact connectivity words",
  );
  assert(measured.actions[0].labelLines > 1);
  report.readabilitySelfTest.push(
    "accepts connectivity copy wrapped between words",
  );
  report.dialogFocusSelfTest = await verifyDialogFocusGuard(probe);
  await probe.close();
  for (const specimen of cases) {
    const { state, theme, width, text } = specimen;
    const id = `${state}-${theme}-${width}${text === 200 ? "-text200" : ""}`;
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: "reduce",
      timezoneId: "Africa/Lagos",
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2026-09-04T12:00:00.000Z"));
    await page.goto(
      `${base}?${new URLSearchParams({ state, theme, text: String(text) })}`,
      { waitUntil: "networkidle" },
    );
    await page.locator("[data-specimen]").waitFor();
    if (state === "offline") {
      await context.setOffline(true);
      await page.locator('[data-tone="offline"]').waitFor();
    }
    if (state === "dialog") {
      await page
        .getByRole("button", { name: "Operation history", exact: true })
        .click();
      await page.getByText("Server history checked", { exact: true }).waitFor();
    }
    if (["disabled", "failed", "partial", "dialog"].includes(state)) {
      await page
        .getByRole("button", { name: "Verify result", exact: true })
        .click();
      if (state === "disabled")
        assert(
          await page
            .getByRole("button", { name: "Checking result...", exact: true })
            .isDisabled(),
        );
      if (state === "failed") await page.getByRole("alert").waitFor();
      if (["partial", "dialog"].includes(state))
        await page
          .getByText("Saved result (HTTP 200)", { exact: true })
          .click();
    }
    if (state === "route-failed")
      await page
        .getByRole("heading", { name: "This page could not open" })
        .waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    const axe = await collectAxeResults(page);
    const geometry = await page.evaluate(() => {
      const scope =
        globalThis.document.querySelector('[role="dialog"]') ??
        globalThis.document.querySelector("[data-specimen]");
      const visible = (node) =>
        node.getClientRects().length &&
        globalThis.getComputedStyle(node).visibility !== "hidden" &&
        !node.closest(".sr-only,.mi-sr-only");
      const elements = [...scope.querySelectorAll("*")].filter(visible);
      return {
        documentWidth: globalThis.document.documentElement.scrollWidth,
        viewportWidth: globalThis.innerWidth,
        clippedText: elements
          .filter(
            (node) =>
              node.children.length === 0 &&
              node.textContent.trim() &&
              node.scrollWidth > node.clientWidth + 2 &&
              globalThis.getComputedStyle(node).display !== "inline",
          )
          .map((node) => ({
            tag: node.tagName,
            text: node.textContent.slice(0, 120),
            client: node.clientWidth,
            scroll: node.scrollWidth,
          })),
        outsideViewport: elements
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.width > 0 &&
              (box.left < -1 || box.right > globalThis.innerWidth + 1)
            );
          })
          .map((node) => ({
            tag: node.tagName,
            className: node.getAttribute("class"),
          })),
        smallControls: elements
          .filter(
            (node) =>
              node.matches("button") &&
              (() => {
                const box = node.getBoundingClientRect();
                return box.width < 24 || box.height < 24;
              })(),
          )
          .map((node) => node.getAttribute("aria-label") ?? node.textContent),
        activeAnimations: elements
          .flatMap((node) => node.getAnimations())
          .filter((animation) => animation.playState === "running").length,
        loadingHeight:
          scope.querySelector('[aria-busy="true"]')?.getBoundingClientRect()
            .height ?? null,
      };
    });
    geometry.readability = await page.evaluate(measureActionReadability);
    await page.screenshot({
      path: path.join(out, `${id}.png`),
      fullPage: true,
    });
    await writeFile(
      path.join(out, `${id}.axe.json`),
      JSON.stringify(axe, null, 2),
    );
    report.cases.push({
      ...specimen,
      id,
      screenshot: `${id}.png`,
      axe: `${id}.axe.json`,
      violations: axe.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        count: nodes.length,
      })),
      incomplete: axe.incomplete.map(({ id, nodes }) => ({
        id,
        count: nodes.length,
      })),
      geometry,
    });
    if (state === "dialog") {
      const focusChecks = [];
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const node = globalThis.document.activeElement;
          const dialog = node?.closest('[role="dialog"]');
          if (!dialog) return { contained: false };
          const box = node.getBoundingClientRect();
          const bounds = dialog.getBoundingClientRect();
          const style = globalThis.getComputedStyle(node);
          return {
            contained: true,
            label: node.getAttribute("aria-label") ?? node.textContent.trim(),
            visible:
              box.top >= bounds.top - 1 &&
              box.bottom <= bounds.bottom + 1 &&
              box.left >= bounds.left - 1 &&
              box.right <= bounds.right + 1,
            focusVisible:
              node.matches(":focus-visible") &&
              style.outlineStyle !== "none" &&
              parseFloat(style.outlineWidth) > 0,
          };
        });
        assert(focused.contained, "Dialog leaked focus");
        assert(
          focused.visible,
          `Focused dialog control is outside its scrollport: ${focused.label}`,
        );
        assert(
          focused.focusVisible,
          `Dialog control has no visible keyboard focus: ${focused.label}`,
        );
        focusChecks.push(focused.label);
      }
      assert(
        focusChecks.includes("Saved operation result"),
        "Saved result was not keyboard reachable",
      );
      await page.keyboard.press("Escape");
      await assertDialogClosedAndFocusRestored(
        page,
        page.getByRole("button", { name: "Operation history", exact: true }),
      );
      report.interactions.push(
        `${id}: dialog traps/restores keyboard focus; controls scroll into view with visible focus; result keyboard reachable`,
      );
    }
    if (state === "route-failed") {
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Page recovered" }).waitFor();
      report.interactions.push(
        `${id}: keyboard retry recreates the failed lazy import`,
      );
    }
    if (state === "disabled") {
      assert(
        await page
          .getByRole("button", {
            name: "Refresh operation history",
            exact: true,
          })
          .isDisabled(),
      );
      report.interactions.push(
        `${id}: refresh and result actions disabled while pending`,
      );
    }
    if (state === "forbidden")
      assert.equal(await page.locator(".mi-operation-status").count(), 0);
    if (state === "offline" && width === 1440) {
      const banner = page.locator(".mi-network-status");
      assert(
        await banner.evaluate((node) => {
          const copy = node.querySelector(".mi-network-status__copy");
          const button = node.querySelector("button");
          return (
            button.getBoundingClientRect().left >=
            copy.getBoundingClientRect().right
          );
        }),
        "Wide connectivity banner must retain its inline action",
      );
      // Constrain the component, not the viewport: narrow panes need the same
      // readable layout even when the surrounding desktop remains wide.
      await banner.evaluate((node) => {
        node.style.width = "256px";
      });
      assert(
        await banner.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const style = globalThis.getComputedStyle(node);
          const left =
            bounds.left +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft);
          const right =
            bounds.right -
            parseFloat(style.borderRightWidth) -
            parseFloat(style.paddingRight);
          return [
            node.querySelector(".mi-network-status__copy"),
            node.querySelector("button"),
          ].every((child) => {
            const box = child.getBoundingClientRect();
            return Math.abs(box.left - left) <= 1 && box.right <= right + 1;
          });
        }),
        "Narrow connectivity copy and action must use their full row without overflow",
      );
      assert.equal(
        (await page.evaluate(measureActionReadability)).failures.length,
        0,
        "Narrow connectivity pane must preserve intact words",
      );
      await banner.evaluate((node) => {
        node.style.removeProperty("width");
      });
      report.interactions.push(
        `${id}: desktop inline action and narrow-container full-row copy/action remain readable`,
      );
    }
    console.log(
      `${id}: ${axe.violations.length} axe violations; ${geometry.clippedText.length} clipped; ${geometry.outsideViewport.length} outside; ${geometry.readability.failures.length} unreadable actions`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
const failures = report.cases.filter(
  ({ violations, geometry }) =>
    violations.length ||
    geometry.documentWidth > geometry.viewportWidth ||
    geometry.clippedText.length ||
    geometry.outsideViewport.length ||
    geometry.smallControls.length ||
    geometry.readability.failures.length ||
    geometry.activeAnimations,
);
console.log(
  `Evidence: ${out}; ${report.cases.length} specimens; ${failures.length} failures.`,
);
assert.equal(report.cases.length, cases.length, "Incomplete catalogue");
assert.equal(
  failures.length,
  0,
  "Review rendered/axe evidence for failing specimens",
);
