// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ActivityCenter, OperationStatusPanel } from "./operation-status";
import type { OperationRecord } from "./operation-journal";

afterEach(cleanup);
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
