import assert from "node:assert/strict";
import { assertDialogClosedAndFocusRestored } from "./dialog-focus.mjs";

export async function verifyDialogFocusGuard(page) {
  const results = [];
  for (const mode of ["delayed", "missing-focus", "stuck-dialog"]) {
    await page.setContent(`
      <button id="trigger">Operation history</button>
      <div role="dialog"><button id="inside">Inside</button></div>
    `);
    await page.evaluate((mode) => {
      const trigger = globalThis.document.querySelector("#trigger");
      const dialog = globalThis.document.querySelector('[role="dialog"]');
      const inside = globalThis.document.querySelector("#inside");
      inside.focus();
      inside.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (mode === "stuck-dialog") {
          trigger.focus();
          return;
        }
        if (mode === "missing-focus") {
          dialog.remove();
          return;
        }
        // Fixture lifecycle only: removal and restoration are separate tasks,
        // like Presence followed by FocusScope's deferred close autofocus.
        setTimeout(() => {
          dialog.remove();
          setTimeout(() => trigger.focus(), 250);
        }, 250);
      });
    }, mode);
    await page.keyboard.press("Escape");
    const trigger = page.getByRole("button", {
      name: "Operation history",
      exact: true,
    });
    if (mode === "delayed") {
      await assertDialogClosedAndFocusRestored(page, trigger);
      results.push(
        "accepts deferred dialog removal and subsequent focus restoration",
      );
    } else {
      await assert.rejects(
        assertDialogClosedAndFocusRestored(page, trigger, { timeout: 150 }),
        mode === "stuck-dialog"
          ? /Dialog did not close/
          : /Dialog did not restore focus/,
      );
      if (mode === "missing-focus") {
        assert.equal(
          await trigger.evaluate(
            (node) => node === globalThis.document.activeElement,
          ),
          false,
          "Focus guard must not repair missing application focus restoration",
        );
      }
      results.push(
        mode === "stuck-dialog"
          ? "rejects a remaining dialog even when its trigger is focused"
          : "rejects a removed dialog whose trigger never regains focus",
      );
    }
  }
  return results;
}
