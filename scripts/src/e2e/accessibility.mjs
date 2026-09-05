/* global document, getComputedStyle */
import axe from "axe-core";
import { assertDialogClosedAndFocusRestored } from "./state-catalogue/dialog-focus.mjs";

export async function collectAxeResults(page) {
  await page.evaluate(axe.source);
  return page.evaluate(async () =>
    globalThis.axe.run(document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ],
      },
    }),
  );
}

// Collect the full issue list for the current page (also used standalone by
// ux-snapshot.mjs for before/after measurement, where the complete list —
// not the check()'s 8-issue summary — is the datum).
export async function collectAccessibilityIssues(page, { reportAxe } = {}) {
  const axeResults = await collectAxeResults(page);
  reportAxe?.(axeResults);
  const issues = await page.evaluate(() => {
    const findings = [];
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        !element.closest("[hidden], [inert]") &&
        !element.closest('[aria-hidden="true"]')
      );
    };
    const text = (element) => (element.textContent ?? "").trim();

    const ids = new Map();
    for (const element of document.querySelectorAll("[id]")) {
      ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count > 1) findings.push(`duplicate id #${id} (${count})`);
    }

    // Accessible names (including nested SVG and native semantics) are axe's
    // responsibility; textContent is not an accessible-name implementation.

    for (const element of document.querySelectorAll(
      "[aria-labelledby], [aria-describedby], [aria-errormessage]",
    )) {
      for (const attribute of [
        "aria-labelledby",
        "aria-describedby",
        "aria-errormessage",
      ]) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        for (const id of value.split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) {
            findings.push(`${attribute} references missing #${id}`);
          }
        }
      }
    }

    for (const dialog of document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]',
    )) {
      if (!visible(dialog)) continue;
      if (!dialog.contains(document.activeElement)) {
        findings.push("visible dialog does not contain keyboard focus");
      }
    }

    for (const tablist of document.querySelectorAll('[role="tablist"]')) {
      if (!visible(tablist)) continue;
      const selected = tablist.querySelectorAll(
        '[role="tab"][aria-selected="true"]',
      ).length;
      if (selected !== 1) {
        findings.push(`visible tablist has ${selected} selected tabs`);
      }
    }

    for (const control of document.querySelectorAll(
      'button, a[href][aria-label], [role="button"][aria-label]',
    )) {
      if (!visible(control) || text(control)) continue;
      const rect = control.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        findings.push(
          `icon control smaller than 24px (${Math.round(rect.width)}x${Math.round(rect.height)})`,
        );
      }
    }

    for (const image of document.querySelectorAll("img")) {
      if (visible(image) && !image.hasAttribute("alt")) {
        findings.push(`image missing alt${image.id ? ` #${image.id}` : ""}`);
      }
    }

    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(
      visible,
    );
    let previousLevel = 0;
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1));
      if (previousLevel > 0 && level > previousLevel + 1) {
        findings.push(`heading jumps h${previousLevel} to h${level}`);
      }
      previousLevel = level;
    }

    const visibleMains = [...document.querySelectorAll("main")].filter(visible);
    // A modal correctly hides the underlying page from the accessibility tree.
    const dialogOpen = [
      ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    ].some(visible);
    const modalOpen =
      dialogOpen &&
      [...document.querySelectorAll("main")].some((main) =>
        main.closest('[aria-hidden="true"], [inert]'),
      );
    if (!modalOpen && visibleMains.length !== 1) {
      findings.push("page must contain exactly one main landmark");
    }
    if (!modalOpen && !headings.some((heading) => heading.tagName === "H1")) {
      findings.push("page has no visible h1");
    }
    if (!document.documentElement.lang) findings.push("html lang is missing");
    if (!document.title.trim()) findings.push("document title is missing");
    if (
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
    ) {
      findings.push("page has horizontal viewport overflow");
    }
    return findings;
  });

  await page.keyboard.press("Tab");
  const focusIssue = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body)
      return "Tab did not reach a control";
    const style = getComputedStyle(active);
    const focusVisible = active.matches(":focus-visible");
    const hasIndicator =
      (style.outlineStyle !== "none" && style.outlineWidth !== "0px") ||
      style.boxShadow !== "none";
    return focusVisible && hasIndicator
      ? null
      : "first keyboard target has no visible focus indicator";
  });
  if (focusIssue) issues.push(focusIssue);

  await page.emulateMedia({ reducedMotion: "reduce" });
  // Let focus and colour transitions that began before the media preference
  // changed settle. Animations still running after this window are the ones
  // the reduced-motion override must stop.
  await page.waitForTimeout(250);
  const motionIssue = await page.evaluate(() => {
    const running = document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        if (!timing) return false;
        if (timing.iterations === Infinity) return true;
        // Total intended runtime, not per-iteration duration: an in-flight
        // one-shot transition keeps its pre-override duration (changing
        // transition-duration never retargets a running transition), and on
        // some headless builds a ~150ms focus-ring transition still reports
        // "running" after the settle window. That is not the sustained
        // motion this check exists for — only flag animations that would
        // visibly run on (>500ms of total motion) under the override.
        return Number(timing.duration) * (Number(timing.iterations) || 1) > 500;
      });
    return running.length
      ? `${running.length} long-running animation(s) ignore reduced motion`
      : null;
  });
  if (motionIssue) issues.push(motionIssue);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 640) {
    await page.setViewportSize({
      width: 320,
      height: viewport.height,
    });
    await page.waitForTimeout(50);
    const reflowIssue = await page.evaluate(() =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
        ? "page has horizontal overflow at 320 CSS pixels (not a browser zoom test)"
        : null,
    );
    if (reflowIssue) issues.push(reflowIssue);
    await page.setViewportSize(viewport);
  }
  return [
    ...axeResults.violations.map(
      (rule) =>
        `axe ${rule.id} (${rule.impact}): ${rule.nodes.map((node) => node.target.join(" ")).join(", ")} - ${rule.helpUrl}`,
    ),
    ...issues,
  ];
}

// Keyboard reachability rather than programmatic focus is part of the assertion.
export async function tabTo(page, target, limit = 80) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(
    `Control was not keyboard reachable after ${limit} Tab presses`,
  );
}

export async function checkDialogKeyboard(page, trigger, dialog, check, label) {
  await tabTo(page, trigger);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  for (const key of ["Tab", "Shift+Tab"]) {
    // More than one complete cycle in each direction, including the wrap boundary.
    const count = await dialog
      .locator('button, input, select, textarea, a[href], [tabindex="0"]')
      .count();
    for (let i = 0; i < count + 2; i++) {
      await page.keyboard.press(key);
      check(
        `${label}: ${key} focus stays inside dialog`,
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      );
    }
  }
  await page.keyboard.press("Escape");
  await assertDialogClosedAndFocusRestored(page, trigger);
  check(
    `${label}: Escape restores trigger focus`,
    await trigger.evaluate((element) => element === document.activeElement),
  );
}

export async function checkPageAccessibility(page, check, label) {
  const issues = await collectAccessibilityIssues(page);
  check(
    `${label}: accessibility smoke`,
    issues.length === 0,
    issues.slice(0, 8).join("; "),
  );
}
