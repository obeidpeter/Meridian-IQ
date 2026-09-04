// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkManagement, type CreateCollaborativeWorkInput } from "./work-management";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const baseProps = {
  items: [],
  comments: [],
  selectedId: null,
  onSelect: () => {},
  onRetry: () => {},
  onUpdateStatus: async () => {},
  onComment: async () => {},
};

test("a task draft loads when the signed-in storage key arrives late", async () => {
  const key = "meridianiq:work-draft:test-user";
  window.localStorage.setItem(
    key,
    JSON.stringify({
      title: "Review monthly return",
      description: "Check the supporting schedule",
      clientPartyId: "",
      priority: "high",
      dueDate: "2026-09-30",
      assignedTo: "",
    }),
  );
  const onCreate = vi.fn(async (_input: CreateCollaborativeWorkInput) => {});
  const view = render(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
    />,
  );
  view.rerender(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={key}
    />,
  );
  expect(
    await screen.findByDisplayValue("Review monthly return"),
  ).toBeTruthy();
  expect(screen.getByText("Draft saved on this device.")).toBeTruthy();
});

test("a failed create reuses its idempotency key after remount", async () => {
  const key = "meridianiq:work-draft:retry-user";
  const attempts: CreateCollaborativeWorkInput[] = [];
  const onCreate = vi.fn(async (input: CreateCollaborativeWorkInput) => {
    attempts.push(input);
    if (attempts.length === 1) throw new Error("Network response lost");
  });
  const first = render(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={key}
    />,
  );
  fireEvent.change(screen.getByLabelText("Task title"), {
    target: { value: "Confirm filing evidence" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByText("Network response lost")).toBeTruthy();
  await waitFor(() => {
    expect(window.localStorage.getItem(`${key}:attempt`)).not.toBeNull();
  });
  first.unmount();

  render(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={key}
    />,
  );
  expect(await screen.findByDisplayValue("Confirm filing evidence")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
  expect(attempts[1].clientRequestId).toBe(attempts[0].clientRequestId);
  await waitFor(() => {
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(`${key}:attempt`)).toBeNull();
  });
});
