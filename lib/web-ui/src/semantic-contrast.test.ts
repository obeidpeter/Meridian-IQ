// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const stylesheet = document.createElement("style");
const originalClass = document.documentElement.className;

beforeAll(() => {
  // Tailwind consumes this build-time directive; jsdom's CSS parser does not.
  stylesheet.textContent = readFileSync(
    resolve(import.meta.dirname, "styles.css"),
    "utf8",
  ).replace('@source "./";', "");
  document.head.append(stylesheet);
});

afterAll(() => {
  stylesheet.remove();
  document.documentElement.className = originalClass;
});

function token(name: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--mi-${name}`)
    .trim();
  expect(value, `Missing or unsupported --mi-${name}`).toMatch(
    /^#[\da-f]{6}$/i,
  );
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

function declaration(selector: string, property: string): string {
  const rule = Array.from(stylesheet.sheet!.cssRules).find(
    (candidate): candidate is CSSStyleRule =>
      "selectorText" in candidate && candidate.selectorText === selector,
  );
  expect(rule, `Missing ${selector}`).toBeDefined();
  return rule!.style.getPropertyValue(property).trim();
}

function color(selector: string, property: string): string {
  const value = declaration(selector, property);
  const variable = /^var\(--mi-([\w-]+)\)$/.exec(value);
  if (variable) return token(variable[1]);
  if (value === "white" || value === "#fff") return "#ffffff";
  expect(value).toMatch(/^#[\da-f]{6}$/i);
  return value;
}

const selectedSegment = '.mi-segmented__item[aria-pressed="true"]';
const unselectedCount =
  '.mi-segmented__item:not([aria-pressed="true"]) .mi-segmented__count';

test.each(["light", "dark"])(
  "%s filled controls and both segment states retain small-text contrast",
  (theme) => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
    const selectedBackground = color(selectedSegment, "background");
    const selectedForeground = color(selectedSegment, "color");
    expect(declaration(".mi-segmented__count", "background")).toBe(
      "rgb(255 255 255 / 14%)",
    );
    // The selected count inherits the label color over its translucent badge.
    const countBackground =
      "#" +
      [1, 3, 5]
        .map((offset) =>
          Math.round(
            255 * 0.14 +
              Number.parseInt(
                selectedBackground.slice(offset, offset + 2),
                16,
              ) *
                0.86,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    const pairs = [
      ["selected label", selectedForeground, selectedBackground],
      ["selected count", selectedForeground, countBackground],
      [
        "unselected label",
        color(".mi-segmented__item", "color"),
        token("paper"),
      ],
      [
        "unselected count",
        color(unselectedCount, "color"),
        color(unselectedCount, "background"),
      ],
      [
        "primary button",
        color(".mi-button-primary", "color"),
        color(".mi-button-primary", "background"),
      ],
    ];
    for (const [name, foreground, background] of pairs) {
      expect
        .soft(contrast(foreground, background), `${theme} ${name}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    if (theme === "light") {
      expect(selectedForeground).toBe("#ffffff");
      expect(color(".mi-button-primary", "color")).toBe("#ffffff");
    }
  },
);

const semanticPairs = ["light", "dark"].flatMap((theme) =>
  ["critical", "warning", "positive", "info"].flatMap((tone) =>
    ["paper", "canvas", `${tone}-soft`].map((surface) => ({
      theme,
      tone,
      surface,
    })),
  ),
);

test.each(semanticPairs)(
  "$theme $tone text meets 4.5:1 on $surface at small text sizes",
  ({ theme, tone, surface }) => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
    expect(contrast(token(tone), token(surface))).toBeGreaterThanOrEqual(4.5);
  },
);

test.each([
  "teal-soft",
  "gold-soft",
  "critical-soft",
  "positive-soft",
  "info-soft",
  "line",
])("light warning remains legible on the shared %s surface", (surface) => {
  document.documentElement.className = "";
  expect(contrast(token("warning"), token(surface))).toBeGreaterThanOrEqual(
    4.5,
  );
});

test("warning accents remain distinct from the critical tone in both themes", () => {
  for (const theme of ["", "dark"]) {
    document.documentElement.className = theme;
    expect(token("warning")).not.toBe(token("critical"));
  }
  expect(token("warning")).toBe("#fdb022");
  expect(token("warning-soft")).toBe("#3a2a10");
});

test("contrast calculation rejects the original small warning text", () => {
  expect(contrast("#000000", "#ffffff")).toBe(21);
  expect(contrast("#ffffff", "#ffffff")).toBe(1);
  expect(contrast("#b5620a", "#ffffff")).toBeCloseTo(4.45273, 5);
  expect(contrast("#b5620a", "#fdf1dd")).toBeCloseTo(3.98683, 5);
});
