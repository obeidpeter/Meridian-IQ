import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  collectAxeResults,
  collectAccessibilityIssues,
  tabTo,
  checkDialogKeyboard,
} from "./accessibility.mjs";

test("icon target diagnostics identify controls and retain the strict 24px boundary", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Icon target fixture</title>
        <style>button { display: block; padding: 0; border: 0; margin-bottom: 16px; }</style>
      </head><body><main><h1>Icon targets</h1>
        <button data-testid="dismiss-warning" aria-label="Dismiss build warning" style="width:20px;height:20px"></button>
        <button aria-label="Too narrow" style="width:23px;height:32px"></button>
        <button aria-label="Too short" style="width:32px;height:23px"></button>
        <button aria-label="Minimum target" style="width:24px;height:24px"></button>
        <button aria-label="Comfortable target" style="width:32px;height:32px"></button>
      </main></body></html>
    `);
    const issues = await collectAccessibilityIssues(page);
    assert.deepEqual(
      issues.filter((issue) => issue.startsWith("icon control smaller")),
      [
        'icon control smaller than 24px (20x20): button[data-testid="dismiss-warning"][aria-label="Dismiss build warning"]',
        'icon control smaller than 24px (23x32): button[aria-label="Too narrow"]',
        'icon control smaller than 24px (32x23): button[aria-label="Too short"]',
      ],
    );
  } finally {
    await browser.close();
  }
});

test("landmark checks respect modal isolation without hiding page defects", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    const cases = [
      {
        body: '<main aria-hidden="true"><h1>Page</h1></main><div role="dialog" aria-label="Navigation"><button>Close</button></div>',
        main: false,
        heading: false,
      },
      {
        body: "<main><p>No heading</p><button>Action</button></main>",
        main: false,
        heading: true,
      },
      {
        body: "<h1>Page</h1><button>Action</button>",
        main: true,
        heading: false,
      },
    ];
    for (const fixture of cases) {
      await page.setContent(
        `<html lang="en"><head><title>Landmark fixture</title></head><body>${fixture.body}</body></html>`,
      );
      await page.getByRole("button").focus();
      const issues = await collectAccessibilityIssues(page);
      assert.equal(
        issues.includes("page must contain exactly one main landmark"),
        fixture.main,
      );
      assert.equal(issues.includes("page has no visible h1"), fixture.heading);
    }
  } finally {
    await browser.close();
  }
});

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
