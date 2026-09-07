// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Me } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  me: undefined as Me | undefined,
  mount: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return { ...actual, useGetMe: () => ({ data: harness.me }) };
});
import { CapabilityGate, RoleGate } from "./capability-gate";

function ProtectedPage() {
  harness.mount();
  return <h1>Protected financial evidence</h1>;
}
beforeEach(() => {
  harness.mount.mockClear();
  harness.me = {
    role: "firm_admin",
    email: "demo.admin@valo.example",
    capabilities: [],
  } as unknown as Me;
});
afterEach(cleanup);

test.each(
  [[], ["credit.read"], ["credit.data_room.read.extra"]].map(
    (capabilities) => ({ capabilities }),
  ),
)(
  "denied capability $capabilities has a page heading and never mounts the financial page",
  ({ capabilities }) => {
    harness.me!.capabilities = capabilities;
    render(
      <CapabilityGate capability="credit.data_room.read">
        <ProtectedPage />
      </CapabilityGate>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Not available for your account",
      }),
    ).toBeTruthy();
    expect(screen.getByText("credit.data_room.read")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Console home" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Switch account" })).toBeTruthy();
    expect(harness.mount).not.toHaveBeenCalled();
  },
);

test("exact capability mounts the page without a denial heading", () => {
  harness.me!.role = "bank_user";
  harness.me!.capabilities = ["credit.data_room.read"];
  render(
    <CapabilityGate capability="credit.data_room.read">
      <ProtectedPage />
    </CapabilityGate>,
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(
    screen.getByRole("heading", { name: "Protected financial evidence" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("card-access-denied")).toBeNull();
  expect(harness.mount).toHaveBeenCalledTimes(1);
});

test("unresolved session remains fail closed without mounting protected content", () => {
  harness.me = undefined;
  const { container } = render(
    <CapabilityGate capability="credit.data_room.read">
      <ProtectedPage />
    </CapabilityGate>,
  );
  expect(container.innerHTML).toBe("");
  expect(harness.mount).not.toHaveBeenCalled();
});

test("role denial uses the same heading without granting access by capability", () => {
  harness.me!.role = "firm_staff";
  harness.me!.capabilities = ["credit.data_room.read"];
  render(
    <RoleGate role="firm_admin">
      <ProtectedPage />
    </RoleGate>,
  );
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "Not available for your account",
    }),
  ).toBeTruthy();
  expect(harness.mount).not.toHaveBeenCalled();
});

test("matching role keeps the original authorized content", () => {
  render(
    <RoleGate role="firm_admin">
      <ProtectedPage />
    </RoleGate>,
  );
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "Protected financial evidence",
    }),
  ).toBeTruthy();
  expect(harness.mount).toHaveBeenCalledTimes(1);
});
