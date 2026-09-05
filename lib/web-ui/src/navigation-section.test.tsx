// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NavigationSection } from "./navigation-section";

afterEach(cleanup);
test("secondary tools are discoverable through an accessible disclosure", () => {
  render(
    <NavigationSection title="Compliance" active={false} route="/">
      <a href="/vat">VAT</a>
    </NavigationSection>,
  );
  const toggle = screen.getByRole("button", { name: "Compliance" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "VAT" })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: "VAT" })).toBeTruthy();
  expect(
    document.getElementById(toggle.getAttribute("aria-controls")!),
  ).toBeTruthy();
});
test("daily work starts open and a deep-linked section reveals the active page", () => {
  const { rerender } = render(
    <NavigationSection title="Daily work" primary active={false} route="/">
      <a href="/invoices">Invoices</a>
    </NavigationSection>,
  );
  expect(screen.getByRole("link", { name: "Invoices" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  rerender(
    <NavigationSection title="Daily work" primary active route="/invoices">
      <a href="/invoices">Invoices</a>
    </NavigationSection>,
  );
  expect(screen.getByRole("link", { name: "Invoices" })).toBeTruthy();
});
