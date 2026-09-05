// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { ClerkShell } from "./clerk-shell";

vi.mock("./stale-build-banner", () => ({ StaleBuildBanner: () => null }));
afterEach(cleanup);

test.each([
  ["/clerk", "Intake queue"],
  ["/clerk/ask", "Ask Clerk"],
  ["/clerk/claims", "Claims"],
  ["/clerk/health", "Health"],
])(
  "%s keeps the mobile brand and navigation inside the header landmark",
  (path, label) => {
    const { hook } = memoryLocation({ path: `/console${path}` });
    render(
      <Router hook={hook} base="/console">
        <ClerkShell>
          <h1>{label}</h1>
        </ClerkShell>
      </Router>,
    );
    const mobileBack = screen
      .getAllByRole("link", { name: "Back to console" })
      .find((link) => link.hasAttribute("aria-label"))!;
    const header = mobileBack.closest("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByText("Clerk AI")).toBeTruthy();
    const nav = within(header!).getByRole("navigation", { name: "Clerk" });
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    expect(
      within(nav)
        .getByRole("link", { name: label })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(mobileBack.getAttribute("href")).toBe("/console/");
    expect(screen.getByRole("main").id).toBe("clerk-main");
    expect(
      screen
        .getByRole("link", { name: "Skip to content" })
        .getAttribute("href"),
    ).toBe("#clerk-main");
  },
);
