import { expect } from "playwright/test";

export async function assertDialogClosedAndFocusRestored(
  page,
  trigger,
  { timeout = 2000 } = {},
) {
  // Radix Presence can defer unmount for an exit animation; FocusScope then
  // restores focus from setTimeout(0), even without an animation. Observe both.
  await expect(
    page.locator('[role="dialog"]'),
    "Dialog did not close",
  ).toHaveCount(0, { timeout });
  await expect(trigger, "Dialog did not restore focus").toBeFocused({
    timeout,
  });
}
