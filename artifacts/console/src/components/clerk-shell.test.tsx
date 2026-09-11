// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  ClerkDisabledBanner,
  ClerkPageHeader,
  ClerkShell,
} from "./clerk-shell";

vi.mock("./stale-build-banner", () => ({ StaleBuildBanner: () => null }));
const stylesheet = document.createElement("style");
const originalClass = document.documentElement.className;

beforeAll(() => {
  stylesheet.textContent = readFileSync(
    resolve(import.meta.dirname, "../../../../lib/web-ui/src/styles.css"),
    "utf8",
  ).replace('@source "./";', "");
  document.head.append(stylesheet);
});

afterEach(() => {
  cleanup();
  document.documentElement.className = originalClass;
});

afterAll(() => stylesheet.remove());

test.each([
  ["/clerk", "Review queue"],
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

test.each(["light", "dark"])(
  "%s Clerk shell uses platform surfaces and 44px shared navigation",
  (theme) => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
    const { hook } = memoryLocation({ path: "/console/clerk" });
    const { container } = render(
      <Router hook={hook} base="/console">
        <ClerkShell>
          <ClerkPageHeader
            eyebrow="Clerk operations"
            title="Review queue"
            titleTestId="text-clerk-title"
            description="Pending items for review."
            right={
              <button className="inline-flex justify-center">Guardrails</button>
            }
          />
        </ClerkShell>
      </Router>,
    );
    expect(container.querySelector(".mi-platform")?.className).toContain(
      "bg-[var(--mi-canvas)]",
    );
    expect(container.querySelector("aside")?.className).toContain(
      "bg-[var(--mi-sidebar)]",
    );
    const desktopHeader = screen
      .getByText("Approval required")
      .closest("header")!;
    expect(desktopHeader.className).toContain("bg-[var(--mi-paper)]");
    expect(desktopHeader.className).toContain("border-[var(--mi-line)]");
    expect(screen.getByText("Approval required").className).toContain(
      "text-[var(--mi-positive)]",
    );
    const mobileBack = screen
      .getAllByRole("link", { name: "Back to console" })
      .find((link) => link.hasAttribute("aria-label"))!;
    expect(mobileBack.className).toContain("size-11");
    const mobileNav = within(mobileBack.closest("header")!).getByRole(
      "navigation",
      { name: "Clerk" },
    );
    expect(mobileNav.className).toContain("overflow-x-auto");
    expect(mobileNav.className).toContain("flex-row");
    for (const nav of screen.getAllByRole("navigation", { name: "Clerk" })) {
      for (const link of within(nav).getAllByRole("link")) {
        expect(link.className).toContain("mi-nav__link");
        expect(getComputedStyle(link).minHeight).toBe("2.75rem");
        if (nav === mobileNav) {
          expect(link.style.width).toBe("auto");
          expect(link.style.flexShrink).toBe("0");
        }
      }
    }
    const heading = screen.getByRole("heading", {
      name: "Review queue",
      level: 1,
    });
    expect(heading.getAttribute("data-testid")).toBe("text-clerk-title");
    expect(heading.closest(".mi-workspace-header")).not.toBeNull();
    expect(getComputedStyle(heading).fontSize).toBe("1.75rem");
    expect(screen.getByText("Pending items for review.").className).toBe(
      "mi-workspace-header__description",
    );
    expect(
      screen
        .getByRole("button", { name: "Guardrails" })
        .closest(".mi-workspace-header__actions"),
    ).not.toBeNull();
    expect(
      getComputedStyle(screen.getByRole("button", { name: "Guardrails" }))
        .minHeight,
    ).toBe("2.75rem");
  },
);

test("mobile navigation retains base routes and active-page state", () => {
  const { hook } = memoryLocation({ path: "/console/clerk" });
  render(
    <Router hook={hook} base="/console">
      <ClerkShell>
        <h1>Clerk</h1>
      </ClerkShell>
    </Router>,
  );
  fireEvent.click(screen.getAllByRole("link", { name: "Claims" })[0]);
  for (const link of screen.getAllByRole("link", { name: "Claims" })) {
    expect(link.getAttribute("href")).toBe("/console/clerk/claims");
    expect(link.getAttribute("aria-current")).toBe("page");
  }
  for (const link of screen.getAllByRole("link", { name: "Review queue" })) {
    expect(link.getAttribute("data-testid")).toBe("clerk-nav-intake-queue");
    expect(link.hasAttribute("aria-current")).toBe(false);
  }
});

test("disabled Clerk retains its destructive alert and feature-flag identity", () => {
  render(<ClerkDisabledBanner>Intake is unavailable.</ClerkDisabledBanner>);
  const alert = screen.getByRole("alert");
  expect(alert.getAttribute("data-testid")).toBe("banner-clerk-disabled");
  expect(alert.textContent).toContain("Clerk is switched off");
  expect(alert.textContent).toContain("clerk_ai");
  expect(alert.textContent).toContain("Intake is unavailable.");
  expect(alert.className).toContain("text-destructive");
});
