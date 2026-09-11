// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import * as fixtures from "./__tests__/fixtures";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const data = await import("./__tests__/fixtures");
  const query = (value: unknown) => ({
    data: value,
    isLoading: false,
    isError: false,
  });
  return {
    ...actual,
    useGetGateMetrics: () => query(data.activation),
    useListBuyerPilots: () => query(data.buyers),
    useGetComplianceOperations: () => query(data.cases),
    useGetIntegrationReliability: () => query(data.reliability),
    useGetEvidenceVault: () => query(data.evidence),
    useGetClerkAssurance: () => query(data.clerk),
  };
});

import { ControlCentre } from "./index";
import { Progress } from "@/components/ui/progress";

afterEach(cleanup);

test.each([
  "activation",
  "buyers",
  "cases",
  "reliability",
  "evidence",
  "clerk",
] as const)(
  "%s keeps current-page navigation and readable ordinal text",
  (section) => {
    render(<ControlCentre section={section} />);
    const nav = screen.getByRole("navigation", {
      name: "Control centre workspaces",
    });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(7);
    const selected = links.filter(
      (link) => link.getAttribute("aria-current") === "page",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("href")).toBe(`/control-centre/${section}`);
    for (const [index, link] of links.entries()) {
      expect(link.classList.contains("dark:focus-visible:ring-teal-700")).toBe(
        true,
      );
      const ordinal = within(link).getByText(`0${index + 1}`);
      expect(ordinal.className).not.toMatch(/opacity-/);
      expect(ordinal.classList.contains("text-current")).toBe(true);
    }
  },
);

test("activation gates expose names, numeric progress and their actual targets", () => {
  render(<ControlCentre section="activation" />);
  expect(screen.getAllByRole("progressbar")).toHaveLength(6);
  const gate = screen.getByRole("progressbar", {
    name: "Subscribed practices",
  });
  expect(gate.getAttribute("aria-valuenow")).toBe("50");
  expect(gate.getAttribute("aria-valuetext")).toBe(
    "75; target: 150 channel-sourced subscriptions",
  );
  expect(
    screen
      .getByRole("progressbar", { name: "Median time to stamp" })
      .getAttribute("aria-valuenow"),
  ).toBe("75");
});

test("buyer progress identifies each buyer and exposes zero through complete values", () => {
  render(<ControlCentre section="buyers" />);
  for (const pilot of fixtures.buyers.pilots) {
    const progress = screen.getByRole("progressbar", {
      name: `${pilot.buyerName} readiness`,
    });
    expect(progress.getAttribute("aria-valuenow")).toBe(
      String(pilot.readinessScore),
    );
  }
  for (const label of screen.getAllByText(
    /^(Readiness|Suppliers|Stamped|Response|Paid signals)$/,
  )) {
    expect(label.classList.contains("text-slate-600")).toBe(true);
  }
});

test("Clerk results retain a named complementary landmark distinct from the shell", () => {
  render(
    <>
      <aside>Workspace navigation</aside>
      <main>
        <ControlCentre section="clerk" />
      </main>
    </>,
  );
  expect(screen.getAllByRole("complementary")).toHaveLength(2);
  const results = screen.getByRole("complementary", {
    name: "Clerk assurance results",
  });
  for (const text of [
    "Safety check results",
    "Watch",
    "Healthy",
    "Latest eval",
  ]) {
    expect(
      within(results).getByText(text).classList.contains("text-slate-600"),
    ).toBe(true);
  }
  for (const action of screen.getAllByRole("link", { name: "Open" })) {
    expect(action.classList.contains("dark:focus-visible:ring-teal-700")).toBe(
      true,
    );
    expect(action.classList.contains("text-slate-900")).toBe(true);
    expect(action.classList.contains("hover:bg-slate-100")).toBe(true);
    expect(action.classList.contains("hover:text-slate-950")).toBe(true);
  }
});

test("indeterminate progress remains indeterminate and determinate progress reports its value", () => {
  const view = render(
    <Progress aria-label="Evidence completion" value={null} />,
  );
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(
    false,
  );
  view.rerender(<Progress aria-label="Evidence completion" value={42} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "42",
  );
});

test("populated connection captions use the shared theme-aware surface and muted token", () => {
  render(<ControlCentre section="reliability" />);
  const connections = screen.getByRole("region", { name: "Connection estate" });
  expect(connections.classList.contains("bg-[var(--mi-paper)]")).toBe(true);
  const labels = within(connections).getAllByText(
    /^(Last sync|Run|Read \/ written|Row errors)$/,
  );
  expect(labels).toHaveLength(fixtures.reliability.connections.length * 4);
  for (const label of labels) {
    expect(label.classList.contains("text-[var(--mi-muted)]")).toBe(true);
    expect(label.tagName).toBe("DT");
    expect(label.nextElementSibling?.tagName).toBe("DD");
  }
});

test.each(["buyers", "cases"] as const)(
  "%s truncated-list notices use the theme-aware canvas foreground",
  (section) => {
    render(<ControlCentre section={section} />);
    expect(
      screen
        .getByText(/^Showing the/)
        .classList.contains("text-[var(--mi-muted)]"),
    ).toBe(true);
  },
);
