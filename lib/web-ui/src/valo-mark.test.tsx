// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ValoMark } from "./valo-mark";

afterEach(cleanup);
const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

test("the ribbon mark is decorative, scalable and inherits its surface colour", () => {
  const { container } = render(
    <a href="/" aria-label="Valo home">
      <ValoMark width={24} height={24} />
      Valo
    </a>,
  );
  const svg = container.querySelector("svg")!;
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.getAttribute("focusable")).toBe("false");
  expect(svg.getAttribute("viewBox")).toBe("0 0 32 32");
  expect(svg.getAttribute("width")).toBe("24");
  expect(svg.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  expect(
    svg.querySelector("path")?.getAttribute("d")?.match(/M/g),
  ).toHaveLength(2);
  expect(svg.querySelector("title")).toBeNull();
});

test("native, favicon and downloadable vectors retain the exact shared silhouette", () => {
  const { container } = render(<ValoMark />);
  const geometry = container.querySelector("path")!.getAttribute("d")!;
  expect(read("artifacts/mobile/components/valo-mark.tsx")).toContain(
    `d="${geometry}"`,
  );
  for (const app of [
    "landing",
    "console",
    "sme-compliance",
    "buyer-portal",
    "penalty-calculator",
  ]) {
    const favicon = read(`artifacts/${app}/public/favicon.svg`);
    expect(favicon).toContain(`d="${geometry}"`);
    expect(favicon).toContain('fill="#536149"');
  }
  for (const name of [
    "valo-logo",
    "valo-logo-white",
    "valo-logo-mono",
    "valo-mark",
  ]) {
    const svg = read(`artifacts/landing/public/brand/${name}.svg`);
    expect(svg).toContain(`d="${geometry}"`);
    expect(svg).toContain("<title");
    expect(svg).not.toMatch(/<script|<text|<image|@font-face|href=/);
  }
  expect(read("artifacts/landing/public/brand/Inter-LICENSE.txt")).toContain(
    "SIL OPEN FONT LICENSE",
  );
});
