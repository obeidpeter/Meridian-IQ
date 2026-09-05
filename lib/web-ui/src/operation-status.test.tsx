// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ActivityCenter,
  OperationStatusPanel,
  operationActionLabel,
} from "./operation-status";
import type { OperationRecord } from "./operation-journal";

afterEach(cleanup);
test("recovery actions describe the task rather than its technical source", () => {
  expect(
    operationActionLabel({ command: "invoice.create", kind: "invoice" }),
  ).toBe("View invoice");
  expect(
    operationActionLabel({ command: "invoice.import", kind: "import" }),
  ).toBe("View import");
  expect(operationActionLabel({ kind: "clerk" })).toBe("Return to task");
});
const operation: OperationRecord = {
  id: "local",
  serverId: "server",
  kind: "import",
  title: "Invoice import",
  status: "partial",
  route: "/import",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  verification: "server",
  verifiedAt: new Date().toISOString(),
  savedSummary: "1 created; 1 invalid.",
};

test("operation status distinguishes server verification from an unconfirmed local record", () => {
  const { rerender } = render(<OperationStatusPanel {...operation} />);
  expect(screen.getByText(/Server verified/)).toBeTruthy();
  rerender(<OperationStatusPanel {...operation} verification="unconfirmed" />);
  expect(screen.getByText("Not yet verified by the server")).toBeTruthy();
});

test("empty history still exposes server retry and unavailable state", () => {
  const refresh = vi.fn();
  render(
    <ActivityCenter
      operations={[]}
      onOpen={vi.fn()}
      onDismiss={vi.fn()}
      onClearCompleted={vi.fn()}
      syncState="unavailable"
      onRefresh={refresh}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh operation history" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toMatch(/unavailable/);
});

test("repeated operation titles remain named live groups inside one history landmark", () => {
  const records: OperationRecord[] = ["first", "second"].map((id) => ({
    ...operation,
    id,
    status: "succeeded",
  }));
  const { rerender } = render(
    <ActivityCenter
      operations={records}
      onOpen={vi.fn()}
      onDismiss={vi.fn()}
      onClearCompleted={vi.fn()}
    />,
  );

  const history = screen.getByRole("region", { name: "Recent operations" });
  expect(screen.getAllByRole("region")).toEqual([history]);
  const items = within(history).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  for (const item of items) {
    const summary = within(item).getByRole("group", {
      name: "Invoice import: Completed",
    });
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(within(summary).getByText("Invoice import")).toBeTruthy();
    expect(within(summary).getByText("Completed")).toBeTruthy();
    expect(within(summary).getByText("1 created; 1 invalid.")).toBeTruthy();
  }

  rerender(<OperationStatusPanel {...operation} status="failed" />);
  expect(
    screen
      .getByRole("group", { name: "Invoice import: Failed" })
      .getAttribute("aria-live"),
  ).toBe("assertive");
});

test("result verification failure is announced without claiming the command failed", async () => {
  const recover = vi.fn().mockRejectedValue(new Error("offline"));
  render(
    <ActivityCenter
      operations={[operation]}
      onOpen={vi.fn()}
      onDismiss={vi.fn()}
      onClearCompleted={vi.fn()}
      onRecover={recover}
      syncState="synced"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify result" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(
      /could not be verified/,
    ),
  );
  expect(recover).toHaveBeenCalledWith("local");
  expect(screen.getByText("Needs review")).toBeTruthy();
});
