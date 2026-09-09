// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { reliability } from "./__tests__/fixtures";

const query = vi.hoisted(() => ({
  data: undefined as typeof reliability | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetIntegrationReliability: () => query,
}));

import { IntegrationReliabilityWorkspace } from "./reliability";

beforeEach(() => {
  query.data = structuredClone(reliability);
  query.data.connections = query.data.connections.map((connection, index) => ({
    ...connection,
    clientName: `Connection ${index}`,
  }));
  query.isLoading = false;
  query.isError = false;
  query.refetch.mockReset();
});
afterEach(cleanup);

test("filters connections without changing population metrics or truncation context", () => {
  render(<IntegrationReliabilityWorkspace />);
  const filters = screen.getByRole("group", { name: "Filter connections" });
  const attention = within(filters).getByRole("button", {
    name: "Attention 2",
  });
  fireEvent.click(attention);
  expect(attention.getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByText("Connection 0")).toBeNull();
  expect(screen.getByText("Connection 1")).toBeTruthy();
  expect(screen.getByText("Connection 2")).toBeTruthy();
  expect(screen.getByText("3/5")).toBeTruthy();
  expect(screen.getByRole("note").textContent).toMatch(
    /3 most affected of 5 connections/,
  );

  fireEvent.click(within(filters).getByRole("button", { name: "ERP 1" }));
  expect(screen.getByText("Connection 0")).toBeTruthy();
  expect(screen.queryByText("Connection 1")).toBeNull();
  fireEvent.click(within(filters).getByRole("button", { name: "Bank feed 2" }));
  expect(screen.queryByText("Connection 0")).toBeNull();
  expect(screen.getByText("Connection 1")).toBeTruthy();
  fireEvent.click(within(filters).getByRole("button", { name: "All 3" }));
  expect(screen.getAllByText(/^Connection [0-2]$/)).toHaveLength(3);
  expect(query.refetch).not.toHaveBeenCalled();
});

test("retains complete long values and semantic status, warning and critical tones", () => {
  const connection = query.data!.connections[0];
  connection.clientName = "LongClientReference".repeat(12);
  connection.firmName = "LongFirmReference".repeat(12);
  connection.connectorKey = "LongConnectorKey".repeat(12);
  connection.issue = "LongDiagnosticReference".repeat(12);
  connection.recordsRead = 9876543210123;
  const { container } = render(<IntegrationReliabilityWorkspace />);
  expect(screen.getByText(connection.clientName).className).not.toMatch(
    /truncate/,
  );
  expect(
    screen.getByText(`${connection.firmName} / ${connection.connectorKey}`)
      .className,
  ).not.toMatch(/truncate/);
  expect(screen.getByText(connection.issue).className).toContain(
    "text-[var(--mi-warning)]",
  );
  expect(
    screen.getByText(`9876543210123 / ${connection.recordsWritten}`),
  ).toBeTruthy();
  expect(screen.getByText("Healthy").getAttribute("data-tone")).toBe(
    "positive",
  );
  expect(screen.getByText("Stale").getAttribute("data-tone")).toBe("warning");
  expect(screen.getByText("Incident").getAttribute("data-tone")).toBe(
    "critical",
  );
  expect(container.querySelectorAll("dl")).toHaveLength(3);
  expect(
    container.querySelectorAll("dd.text-\\[var\\(--mi-critical\\)\\]"),
  ).toHaveLength(3);
  for (const element of container.querySelectorAll("[class]")) {
    expect(element.getAttribute("class")).not.toMatch(
      /(?:text|bg|border|divide)-(?:slate|teal|white)(?:-|\b)/,
    );
  }
});

test("only active signals render and keep their severity and investigation destination", () => {
  query.data!.qualitySignals = ["critical", "warning", "info"].map(
    (severity, index) => ({
      ...reliability.qualitySignals[0],
      key: severity,
      label: `${severity} signal`,
      severity: severity as "critical" | "warning" | "info",
      count: index + 1,
      actionHref: `/clients/import?signal=${severity}`,
    }),
  );
  query.data!.qualitySignals.push({
    ...reliability.qualitySignals[0],
    key: "zero",
    count: 0,
  });
  render(<IntegrationReliabilityWorkspace />);
  const links = screen.getAllByRole("link", { name: "Investigate" });
  expect(links).toHaveLength(3);
  for (const [index, severity] of ["critical", "warning", "info"].entries()) {
    expect(links[index].getAttribute("href")).toBe(
      `/clients/import?signal=${severity}`,
    );
    expect(links[index].closest("li")?.getAttribute("data-tone")).toBe(
      severity,
    );
  }
});

test("a filtered empty result does not claim that active reliability signals are clear", () => {
  query.data!.connections = query.data!.connections.filter(
    (connection) => connection.type === "bank_feed",
  );
  render(<IntegrationReliabilityWorkspace />);
  fireEvent.click(screen.getByRole("button", { name: "ERP 0" }));
  expect(screen.getByRole("status").textContent).toBe(
    "No connections in this view.",
  );
  expect(screen.getByRole("link", { name: "Investigate" })).toBeTruthy();
  expect(screen.queryByText("Reliability signals are clear")).toBeNull();
});

test("empty data is distinct from unavailable data and absent sync/run values are safe", () => {
  query.data!.connections[0].lastSyncAt = null;
  query.data!.connections[0].latestRunStatus = null;
  const view = render(<IntegrationReliabilityWorkspace />);
  expect(screen.getByText("No run")).toBeTruthy();
  query.data!.connections = [];
  query.data!.connectionsTruncated = false;
  query.data!.qualitySignals = [];
  view.rerender(<IntegrationReliabilityWorkspace />);
  expect(screen.getByRole("status").textContent).toBe(
    "No connections in this view.",
  );
  expect(screen.getByText("Reliability signals are clear")).toBeTruthy();
  expect(screen.queryByRole("note")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("loading stays busy until real data is available", () => {
  query.isLoading = true;
  query.data = undefined;
  render(<IntegrationReliabilityWorkspace />);
  expect(
    screen.getByLabelText("Loading workspace").getAttribute("aria-busy"),
  ).toBe("true");
  expect(screen.queryByText("Reliability signals are clear")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Connection estate" }),
  ).toBeNull();
});

test.each([true, false])(
  "error/missing data offers retry instead of healthy metrics (isError=%s)",
  (isError) => {
    query.isError = isError;
    if (!isError) query.data = undefined;
    const view = render(<IntegrationReliabilityWorkspace />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Unable to load integration reliability.",
    );
    expect(
      screen.queryByRole("region", { name: "Integration reliability summary" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
    query.isError = false;
    query.data = structuredClone(reliability);
    view.rerender(<IntegrationReliabilityWorkspace />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Connection estate" }),
    ).toBeTruthy();
  },
);
