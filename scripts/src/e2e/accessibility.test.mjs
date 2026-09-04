import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  collectAxeResults,
  tabTo,
  checkDialogKeyboard,
} from "./accessibility.mjs";

test("real axe engine detects names and contrast; keyboard assertion catches a leaking dialog", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<html lang="en"><head><title>Axe fixture</title></head><body><main><h1>Fixture</h1><button></button><p style="color:#eee;background:white">Insufficient contrast</p></main></body></html>',
    );
    const results = await collectAxeResults(page);
    assert.ok(results.violations.some((rule) => rule.id === "button-name"));
    assert.ok(results.violations.some((rule) => rule.id === "color-contrast"));
    await page.setContent(
      '<html lang="en"><head><title>Keyboard fixture</title></head><body><button id="open">Open</button><div role="dialog" aria-label="Leaky dialog" hidden><button>Inside</button></div><button>Outside</button><script>document.querySelector("#open").onclick=()=>{document.querySelector("[role=dialog]").hidden=false;document.querySelector("[role=dialog] button").focus()}</script></body></html>',
    );
    await assert.rejects(
      checkDialogKeyboard(
        page,
        page.locator("#open"),
        page.getByRole("dialog"),
        (_label, ok) => assert.ok(ok),
        "fixture",
      ),
    );
    await page.setContent(
      '<button tabindex="-1">Unreachable</button><button>Reachable</button>',
    );
    await assert.rejects(
      tabTo(page, page.getByRole("button", { name: "Unreachable" }), 4),
      /not keyboard reachable/,
    );
  } finally {
    await browser.close();
  }
});
