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

test("dialog keyboard guard observes deferred close and never repairs missing focus", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  try {
    for (const mode of ["delayed", "missing-focus", "hidden-dialog"]) {
      const page = await browser.newPage();
      try {
        await page.setContent(`
          <button id="trigger">Open</button>
          <div role="dialog" aria-label="Fixture" hidden><button id="inside">Inside</button></div>
          <script>
            const trigger = document.querySelector('#trigger');
            const dialog = document.querySelector('[role=dialog]');
            const inside = document.querySelector('#inside');
            trigger.onclick = () => { dialog.hidden = false; inside.focus(); };
            inside.onkeydown = (event) => {
              if (event.key === 'Tab') { event.preventDefault(); inside.focus(); }
              if (event.key !== 'Escape') return;
              if (${JSON.stringify(mode)} === 'hidden-dialog') {
                dialog.hidden = true; trigger.focus(); return;
              }
              // Fixture lifecycle only; the production guard never sets focus.
              setTimeout(() => {
                dialog.remove();
                if (${JSON.stringify(mode)} === 'delayed') setTimeout(() => trigger.focus(), 150);
              }, 150);
            };
          </script>
        `);
        const trigger = page.locator("#trigger");
        const run = checkDialogKeyboard(
          page,
          trigger,
          page.getByRole("dialog"),
          (label, ok) => assert.ok(ok, label),
          mode,
        );
        if (mode === "delayed") {
          await run;
          assert.equal(
            await trigger.evaluate(
              (element) => element === globalThis.document.activeElement,
            ),
            true,
          );
        } else {
          await assert.rejects(
            run,
            mode === "missing-focus"
              ? /Dialog did not restore focus/
              : /Dialog did not close/,
          );
          if (mode === "missing-focus") {
            assert.equal(
              await trigger.evaluate(
                (element) => element === globalThis.document.activeElement,
              ),
              false,
            );
          }
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
