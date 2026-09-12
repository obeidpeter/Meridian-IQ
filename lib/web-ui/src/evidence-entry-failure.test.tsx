// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EvidenceHub } from "./evidence-lazy";
import type { EvidenceHubProps } from "./evidence-hub";

vi.mock("./evidence-hub", () => {
  throw new Error("Synthetic evidence chunk failure");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("the compatibility entry exposes a recoverable error when its feature chunk fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<EvidenceHub {...({} as EvidenceHubProps)} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "This page could not open",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByText("Synthetic evidence chunk failure")).toBeNull();
});
