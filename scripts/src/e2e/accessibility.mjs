/* global CSS, document, getComputedStyle */

// Collect the full issue list for the current page (also used standalone by
// ux-snapshot.mjs for before/after measurement, where the complete list —
// not the check()'s 8-issue summary — is the datum).
export async function collectAccessibilityIssues(page) {
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
    const accessibleName = (element) => {
      const ariaLabel = element.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const value = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map(text)
          .join(" ")
          .trim();
        if (value) return value;
      }
      if (element.id) {
        const escaped = CSS.escape(element.id);
        const label = document.querySelector(`label[for="${escaped}"]`);
        if (label && text(label)) return text(label);
      }
      const wrappingLabel = element.closest("label");
      if (wrappingLabel && text(wrappingLabel)) return text(wrappingLabel);
      return (
        element.getAttribute("alt")?.trim() ||
        element.getAttribute("title")?.trim() ||
        text(element)
      );
    };

    const ids = new Map();
    for (const element of document.querySelectorAll("[id]")) {
      ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count > 1) findings.push(`duplicate id #${id} (${count})`);
    }

    for (const element of document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="menuitem"]',
    )) {
      if (visible(element) && !accessibleName(element)) {
        findings.push(
          `unnamed ${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
        );
      }
    }

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
      if (!accessibleName(dialog)) findings.push("visible dialog has no name");
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
    if (visibleMains.length !== 1) {
      findings.push("page must contain exactly one main landmark");
    }
    if (!headings.some((heading) => heading.tagName === "H1")) {
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
  await page.waitForTimeout(30);
  const motionIssue = await page.evaluate(() => {
    const running = document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return (
          timing &&
          (timing.iterations === Infinity || Number(timing.duration) > 100)
        );
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
      width: Math.max(320, Math.floor(viewport.width / 2)),
      height: viewport.height,
    });
    await page.waitForTimeout(50);
    const reflowIssue = await page.evaluate(() =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
        ? "page has horizontal overflow at 200% reflow"
        : null,
    );
    if (reflowIssue) issues.push(reflowIssue);
    await page.setViewportSize(viewport);
  }
  return issues;
}

export async function checkPageAccessibility(page, check, label) {
  const issues = await collectAccessibilityIssues(page);
  check(
    `${label}: accessibility smoke`,
    issues.length === 0,
    issues.slice(0, 8).join("; "),
  );
}
