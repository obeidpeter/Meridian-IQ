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

test("segment selection colors stay atomic under global reduced-motion durations", () => {
  const button = document.createElement("button");
  button.className = "mi-segmented__item";
  button.innerHTML =
    '<span>ERP</span><span class="mi-segmented__count">0</span>';
  document.body.append(button);
  try {
    for (const element of [button, ...button.children]) {
      element.setAttribute("style", "transition-duration: 0.01ms !important");
      expect(getComputedStyle(element).transitionProperty).toBe("none");
    }
  } finally {
    button.remove();
  }
});

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

test.each(["light", "dark"])(
  "%s workspace text, navigation and control boundaries retain AA contrast",
  (theme) => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
    for (const surface of ["paper", "canvas", "teal-soft"]) {
      for (const foreground of ["ink", "muted", "teal"]) {
        expect(
          contrast(token(foreground), token(surface)),
          `${theme} ${foreground} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(token("input-line"), token(surface)),
      ).toBeGreaterThanOrEqual(3);
      expect(contrast(token("teal"), token(surface))).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(token("primary-ink"), token("teal")),
    ).toBeGreaterThanOrEqual(4.5);
    for (const surface of ["sidebar", "sidebar-active"]) {
      for (const foreground of ["sidebar-ink", "sidebar-accent"]) {
        expect(
          contrast(token(foreground), token(surface)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
);

test("the light workspace uses the agreed reference palette", () => {
  document.documentElement.className = "";
  expect(token("teal")).toBe("#536149");
  expect(token("canvas")).toBe("#f5f6f3");
  expect(token("paper")).toBe("#ffffff");
  expect(token("ink")).toBe("#262925");
  expect(token("muted")).toBe("#60655d");
  expect(token("line")).toBe("#d5d8d0");
  expect(token("sidebar")).toBe("#252b24");
});

test("workspace controls keep 44px targets without expanding status labels", () => {
  for (const selector of [
    ".mi-segmented__item",
    ".mi-command__close",
    ".mi-nav__link",
    ".mi-topbar__action",
    ".mi-account-menu__item",
    ".mi-icon-button",
    ".mi-platform :where(button, a, label).inline-flex.justify-center",
    '.mi-platform :where(input, textarea, [role="combobox"]).border-input',
    '.mi-platform [role="tab"][data-orientation="horizontal"]',
  ]) {
    expect(declaration(selector, "min-height"), selector).toBe("2.75rem");
  }
  expect(declaration(".mi-mobilebar button", "min-width")).toBe("2.75rem");
  expect(declaration(".mi-nav__more", "background")).toBe("var(--mi-sidebar)");
  expect(declaration(".mi-topbar", "background")).toBe("var(--mi-paper)");
  expect(declaration(".mi-workspace-header h1", "font-size")).toBe("1.75rem");
  expect(declaration(":root", "--mi-radius")).toBe("0.5rem");
});

test.each(["console", "sme-compliance", "buyer-portal"])(
  "%s Tailwind tokens match the shared palette in both themes",
  (app) => {
    const css = readFileSync(
      resolve(import.meta.dirname, `../../../artifacts/${app}/src/index.css`),
      "utf8",
    );
    const appStyles = document.createElement("style");
    appStyles.textContent = css.slice(
      css.indexOf(":root {"),
      css.indexOf("@layer base"),
    );
    document.head.append(appStyles);
    try {
      const pairs = {
        background: "canvas",
        foreground: "ink",
        card: "paper",
        "card-foreground": "ink",
        "card-border": "line",
        popover: "paper",
        "popover-foreground": "ink",
        "popover-border": "line",
        primary: "teal",
        "primary-foreground": "primary-ink",
        "muted-foreground": "muted",
        border: "line",
        input: "input-line",
        ring: "teal",
      };
      for (const theme of ["", "dark"]) {
        document.documentElement.className = theme;
        const computed = getComputedStyle(document.documentElement);
        for (const [appToken, sharedToken] of Object.entries(pairs)) {
          const probe = document.createElement("span");
          const hsl = computed.getPropertyValue(`--${appToken}`).trim();
          probe.style.color = `hsl(${hsl})`;
          document.body.append(probe);
          const actual = getComputedStyle(probe).color;
          probe.style.color = token(sharedToken);
          expect(actual, `${app} ${theme || "light"} ${appToken}`).toBe(
            getComputedStyle(probe).color,
          );
          probe.remove();
        }
      }
    } finally {
      appStyles.remove();
    }
  },
);
