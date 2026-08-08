/* global CSS, document, getComputedStyle */

export async function checkPageAccessibility(page, check, label) {
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
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]',
    )) {
      if (visible(element) && !accessibleName(element)) {
        findings.push(
          `unnamed ${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
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

  check(
    `${label}: accessibility smoke`,
    issues.length === 0,
    issues.slice(0, 8).join("; "),
  );
}
