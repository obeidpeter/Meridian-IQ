// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  WorkManagement,
  type CreateCollaborativeWorkInput,
} from "./work-management";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const task = (id = "task-a") => ({
  id,
  clientPartyId: null,
  clientName: null,
  title: `Task ${id}`,
  description: null,
  status: "open" as const,
  priority: "normal" as const,
  dueAt: null,
  assignedTo: null,
  assignedToName: null,
  createdByName: null,
  href: null,
  version: 1,
  updatedAt: "2026-09-09T12:00:00Z",
});

test("failed discussion loads never appear empty and stale comments remain readable", () => {
  const retry = vi.fn();
  const props = {
    ...baseProps,
    items: [task()],
    selectedId: "task-a",
    onCreate: async () => {},
    commentsError: "Offline",
    onRetryComments: retry,
  };
  const view = render(<WorkManagement {...props} />);
  expect(screen.queryByText(/No comments yet/)).toBeNull();
  expect(screen.getByText("Discussion could not be loaded.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry discussion" }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(
    <WorkManagement
      {...props}
      comments={[
        {
          id: "comment",
          authorName: "Ada",
          body: "Previously loaded decision",
          createdAt: "2026-09-09T12:00:00Z",
        },
      ]}
    />,
  );
  expect(screen.getByText("Previously loaded decision")).toBeTruthy();
  expect(screen.getByText(/Showing the last loaded comments/)).toBeTruthy();
});

test("comment drafts stay with their task and preserve retry identity after remount", async () => {
  const attempts: string[] = [];
  const onComment = vi.fn(async (_item, _body: string, id: string) => {
    attempts.push(id);
    if (attempts.length === 1) throw new Error("Response lost");
  });
  const props = {
    ...baseProps,
    items: [task(), task("task-b")],
    onCreate: async () => {},
    onComment,
    commentDraftStorageKey: "meridianiq:work-comment:user:firm:client",
  };
  const view = render(<WorkManagement {...props} selectedId="task-a" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Draft for task A" },
  });
  view.rerender(<WorkManagement {...props} selectedId="task-b" />);
  expect(
    (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value,
  ).toBe("");
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Draft for task B" },
  });
  view.rerender(<WorkManagement {...props} selectedId="task-a" />);
  expect(screen.getByDisplayValue("Draft for task A")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Comment", exact: true }));
  expect(await screen.findByText("Response lost")).toBeTruthy();
  view.unmount();
  render(<WorkManagement {...props} selectedId="task-a" />);
  expect(screen.getByDisplayValue("Draft for task A")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Comment", exact: true }));
  await waitFor(() => expect(onComment).toHaveBeenCalledTimes(2));
  expect(attempts[1]).toBe(attempts[0]);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value,
    ).toBe(""),
  );
});

test("pagination is accessible and a load failure does not say no active tasks", () => {
  const load = vi.fn();
  const view = render(
    <WorkManagement
      {...baseProps}
      onCreate={async () => {}}
      items={[task()]}
      total={125}
      hasMore
      onLoadMore={load}
    />,
  );
  expect(screen.getByText("Showing 1 of 125 tasks")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
  expect(load).toHaveBeenCalledOnce();
  view.rerender(
    <WorkManagement {...baseProps} onCreate={async () => {}} error="Offline" />,
  );
  expect(screen.queryByText("No active tasks")).toBeNull();
  expect(screen.getByText("Team work could not be loaded")).toBeTruthy();
});

test("duplicate comment submissions are suppressed and late success clears only its own draft", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const onComment = vi.fn(() => pending);
  const props = { ...baseProps, items: [task(), task("task-b")], onCreate: async () => {}, onComment };
  const view = render(<WorkManagement {...props} selectedId="task-b" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Keep task B draft" } });
  view.rerender(<WorkManagement {...props} selectedId="task-a" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Send task A" } });
  const form = screen.getByLabelText("Add a comment").closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onComment).toHaveBeenCalledOnce();
  view.rerender(<WorkManagement {...props} selectedId="task-b" />);
  finish();
  await waitFor(() => expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.getByDisplayValue("Keep task B draft")).toBeTruthy();
  view.rerender(<WorkManagement {...props} selectedId="task-a" />);
  expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toBe("");
});

test("comment storage is account and workspace scoped and safely tolerates denied storage", () => {
  const props = { ...baseProps, items: [task()], selectedId: "task-a", onCreate: async () => {} };
  const view = render(<WorkManagement {...props} commentDraftStorageKey="meridianiq:work-comment:user-a:firm-a" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Private draft for A" } });
  view.rerender(<WorkManagement {...props} commentDraftStorageKey="meridianiq:work-comment:user-b:firm-b" />);
  expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toBe("");
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try {
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Memory-only draft" } });
    expect(screen.getByDisplayValue("Memory-only draft")).toBeTruthy();
  } finally { storage.mockRestore(); }
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
    <WorkManagement {...baseProps} onCreate={onCreate} openNewInitially />,
  );
  view.rerender(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={key}
    />,
  );
  expect(await screen.findByDisplayValue("Review monthly return")).toBeTruthy();
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
  expect(
    await screen.findByDisplayValue("Confirm filing evidence"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
  expect(attempts[1].clientRequestId).toBe(attempts[0].clientRequestId);
  await waitFor(() => {
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(`${key}:attempt`)).toBeNull();
  });
});
