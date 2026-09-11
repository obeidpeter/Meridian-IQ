// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const session = vi.hoisted(() => ({ role: undefined as string | undefined }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({
      data: session.role
        ? {
            role: session.role,
            userId: "language-test-user",
            fullName: "Workspace user",
            capabilities: [
              "clients.import",
              "billing.read",
              "console.portfolio.read",
              "theme.write",
              "party.merge",
              "operator.queue.read",
              "audit.read",
            ],
            features: ["white_label"],
          }
        : undefined,
    }),
  };
});
vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/components/stale-build-banner", () => ({
  StaleBuildBanner: () => null,
}));

import { Layout } from "./layout";

let client: QueryClient;
beforeEach(() => {
  session.role = undefined;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function renderShell() {
  return render(
    <QueryClientProvider client={client}>
      <Layout>
        <h1>Workspace content</h1>
      </Layout>
    </QueryClientProvider>,
  );
}

test("the mobile brand and navigation controls belong to a banner", () => {
  renderShell();
  const menu = screen.getByRole("button", { name: "Open navigation" });
  const header = menu.closest("header");
  expect(header).not.toBeNull();
  expect(within(header!).getByText("Valo")).toBeTruthy();
  // CSS selects one responsive header; neither belongs inside the main content.
  expect(screen.getAllByRole("banner")).toHaveLength(2);
  expect(header!.closest("main, section, article, aside, nav")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Console" })).toBeTruthy();
});

test("mobile workspace context is named without changing the content landmark", () => {
  renderShell();
  const context = screen.getByRole("region", { name: "Current workspace" });
  const labels = context.querySelectorAll("p");
  expect(labels).toHaveLength(2);
  for (const label of labels) expect(label.textContent?.trim()).toBeTruthy();
  const main = screen.getByRole("main");
  expect(
    within(main).getByRole("heading", { name: "Workspace content" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Skip to content" }).getAttribute("href"),
  ).toBe("#" + main.id);
});

test.each(["firm_admin", "firm_staff", "operator", "auditor", "bank_user"])(
  "%s has a role-neutral brand link without changing the home route",
  (role) => {
    session.role = role;
    renderShell();
    const brands = screen.getAllByRole("link", {
      name: "Valo — go to your workspace home",
    });
    expect(brands.length).toBeGreaterThan(0);
    for (const brand of brands) expect(brand.getAttribute("href")).toBe("/");
  },
);

test("plain navigation labels retain their existing test IDs and routes", () => {
  session.role = "firm_admin";
  renderShell();
  for (const section of [
    "Client services and setup",
    "Growth and revenue",
    "Platform",
  ]) {
    const toggle = screen.getByRole("button", { name: section });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  }
  for (const [label, id, href] of [
    ["Import clients", "client-import", "/clients/import"],
    ["API and webhooks", "api-&-webhooks", "/api-access"],
    ["Plans and billing", "plans-&-billing", "/billing"],
    ["Potential revenue", "unearned-income", "/unearned-income"],
    ["Branding", "white-label", "/whitelabel"],
    ["Business records", "party-integrity", "/parties"],
    ["Platform operations", "platform-ops", "/platform-ops"],
    ["Audit and evidence", "audit-&-evidence", "/audit"],
  ]) {
    const link = screen.getByRole("link", { name: label });
    expect(link.getAttribute("data-testid")).toBe(`nav-${id}`);
    expect(link.getAttribute("href")).toBe(href);
  }
});
