// @vitest-environment jsdom
import {
  act,
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
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onComment = vi.fn(() => pending);
  const props = {
    ...baseProps,
    items: [task(), task("task-b")],
    onCreate: async () => {},
    onComment,
  };
  const view = render(<WorkManagement {...props} selectedId="task-b" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Keep task B draft" },
  });
  view.rerender(<WorkManagement {...props} selectedId="task-a" />);
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Send task A" },
  });
  const form = screen.getByLabelText("Add a comment").closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onComment).toHaveBeenCalledOnce();
  view.rerender(<WorkManagement {...props} selectedId="task-b" />);
  finish();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  expect(screen.getByDisplayValue("Keep task B draft")).toBeTruthy();
  view.rerender(<WorkManagement {...props} selectedId="task-a" />);
  expect(
    (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value,
  ).toBe("");
});

test("comment storage is account and workspace scoped and safely tolerates denied storage", () => {
  const props = {
    ...baseProps,
    items: [task()],
    selectedId: "task-a",
    onCreate: async () => {},
  };
  const view = render(
    <WorkManagement
      {...props}
      commentDraftStorageKey="meridianiq:work-comment:user-a:firm-a"
    />,
  );
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Private draft for A" },
  });
  view.rerender(
    <WorkManagement
      {...props}
      commentDraftStorageKey="meridianiq:work-comment:user-b:firm-b"
    />,
  );
  expect(
    (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value,
  ).toBe("");
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    fireEvent.change(screen.getByLabelText("Add a comment"), {
      target: { value: "Memory-only draft" },
    });
    expect(screen.getByDisplayValue("Memory-only draft")).toBeTruthy();
  } finally {
    storage.mockRestore();
  }
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

test("an off-page creation remains selected without changing page counts or discussion target", async () => {
  const created = { ...task("new-task"), priority: "low" as const };
  const onSelect = vi.fn();
  const onComment = vi.fn(async () => {});
  const props = {
    ...baseProps,
    items: Array.from({ length: 50 }, (_, index) => task(`existing-${index}`)),
    selectedId: created.id,
    selectedItem: created,
    total: 126,
    onSelect,
    onComment,
    onCreate: async () => {},
  };
  const view = render(<WorkManagement {...props} />);
  expect(screen.getByRole("heading", { name: created.title })).toBeTruthy();
  expect(screen.getByText("Showing 50 of 126 tasks")).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "New task decision" },
  });
  view.rerender(<WorkManagement {...props} error="Refresh unavailable" />);
  expect(screen.getByDisplayValue("New task decision")).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Comment", exact: true }));
  await waitFor(() =>
    expect(onComment).toHaveBeenCalledWith(
      created,
      "New task decision",
      expect.any(String),
    ),
  );
});

test("loaded record updates take precedence over an off-page creation snapshot", async () => {
  const created = task("new-task");
  const loaded = { ...created, version: 2, title: "Updated task" };
  const onComment = vi.fn(async () => {});
  render(
    <WorkManagement
      {...baseProps}
      items={[loaded]}
      selectedId={created.id}
      selectedItem={created}
      onCreate={async () => {}}
      onComment={onComment}
    />,
  );
  expect(screen.getByRole("heading", { name: "Updated task" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Latest version" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment", exact: true }));
  await waitFor(() =>
    expect(onComment).toHaveBeenCalledWith(
      loaded,
      "Latest version",
      expect.any(String),
    ),
  );
});

test("off-page selections obey filters and cannot select a different id", () => {
  const onSelect = vi.fn();
  const created = task("new-task");
  const props = {
    ...baseProps,
    items: [task()],
    selectedId: created.id,
    selectedItem: created,
    onSelect,
    onCreate: async () => {},
  };
  const view = render(<WorkManagement {...props} pageView="done" />);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  view.rerender(<WorkManagement {...props} selectedId="unknown" />);
  expect(screen.queryByRole("heading", { name: created.title })).toBeNull();
  expect(onSelect).toHaveBeenLastCalledWith("task-a");
});

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

test("load more stays focused and busy while the next page loads, and the count region persists (R115)", () => {
  const load = vi.fn();
  const props = {
    ...baseProps,
    onCreate: async () => {},
    items: [task()],
    total: 125,
    hasMore: true,
    onLoadMore: load,
  };
  const view = render(<WorkManagement {...props} />);
  const count = screen.getByText("Showing 1 of 125 tasks");
  const loadMore = screen.getByRole("button", { name: "Load more tasks" });
  loadMore.focus();
  fireEvent.click(loadMore);
  expect(load).toHaveBeenCalledOnce();
  view.rerender(<WorkManagement {...props} loadingMore />);
  const loading = screen.getByRole("button", { name: "Loading more tasks" });
  expect(loading).toBe(loadMore);
  expect(document.activeElement).toBe(loadMore);
  expect(loadMore.getAttribute("aria-busy")).toBe("true");
  expect(loadMore.getAttribute("aria-disabled")).toBe("true");
  expect(loadMore.hasAttribute("disabled")).toBe(false);
  fireEvent.click(loadMore);
  expect(load).toHaveBeenCalledOnce();
  view.rerender(
    <WorkManagement {...props} items={[task(), task("task-b")]} total={126} />,
  );
  expect(document.activeElement).toBe(loadMore);
  expect(loadMore.hasAttribute("aria-disabled")).toBe(false);
  // The same region announces the new count: it was never unmounted.
  expect(screen.getByText("Showing 2 of 126 tasks")).toBe(count);
  expect(count.getAttribute("role")).toBe("status");
});

test("sending a comment and retrying the discussion keep keyboard focus (R115)", async () => {
  let finish!: () => void;
  const onComment = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const retry = vi.fn();
  const props = {
    ...baseProps,
    items: [task()],
    selectedId: "task-a",
    onCreate: async () => {},
    onComment,
    commentsError: { status: 503 },
    onRetryComments: retry,
  };
  const view = render(<WorkManagement {...props} />);
  fireEvent.change(screen.getByLabelText("Add a comment"), {
    target: { value: "Decision recorded" },
  });
  const send = screen.getByRole("button", { name: "Comment", exact: true });
  send.focus();
  fireEvent.click(send);
  expect(onComment).toHaveBeenCalledOnce();
  const sending = screen.getByRole("button", { name: "Sending comment" });
  expect(sending).toBe(send);
  expect(document.activeElement).toBe(send);
  expect(send.getAttribute("aria-busy")).toBe("true");
  expect(
    (screen.getByLabelText("Add a comment") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  fireEvent.click(send);
  expect(onComment).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(document.activeElement).toBe(send);
  expect(send.getAttribute("aria-disabled")).toBe("true");
  expect(send.hasAttribute("disabled")).toBe(false);

  const retryButton = screen.getByRole("button", { name: "Retry discussion" });
  retryButton.focus();
  fireEvent.click(retryButton);
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<WorkManagement {...props} commentsLoading />);
  expect(document.activeElement).toBe(retryButton);
  expect(retryButton.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(retryButton);
  expect(retry).toHaveBeenCalledOnce();
});

test("a draft under the user-only key is adopted by the scoped key once, and a scoped draft wins (R116)", async () => {
  const legacy = "meridianiq:work-draft:user-a";
  const scoped = "meridianiq:work-draft:user-a:firm-a:firm";
  const draft = (title: string) =>
    JSON.stringify({
      title,
      description: "",
      clientPartyId: "",
      priority: "normal",
      dueDate: "",
      assignedTo: "",
    });
  const attempt = JSON.stringify({
    signature: "sig",
    id: "6f1d4e5a-3b2c-4d8e-9f0a-1b2c3d4e5f60",
  });
  window.localStorage.setItem(legacy, draft("From the old key"));
  window.localStorage.setItem(`${legacy}:attempt`, attempt);
  const onCreate = vi.fn(async (_input: CreateCollaborativeWorkInput) => {});
  const first = render(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={scoped}
      legacyDraftStorageKey={legacy}
    />,
  );
  expect(await screen.findByDisplayValue("From the old key")).toBeTruthy();
  expect(window.localStorage.getItem(legacy)).toBeNull();
  expect(window.localStorage.getItem(`${legacy}:attempt`)).toBeNull();
  expect(window.localStorage.getItem(`${scoped}:attempt`)).toBe(attempt);
  expect(JSON.parse(window.localStorage.getItem(scoped) ?? "{}").title).toBe(
    "From the old key",
  );
  first.unmount();

  window.localStorage.setItem(legacy, draft("Stale legacy draft"));
  window.localStorage.setItem(scoped, draft("Scoped draft"));
  render(
    <WorkManagement
      {...baseProps}
      onCreate={onCreate}
      openNewInitially
      draftStorageKey={scoped}
      legacyDraftStorageKey={legacy}
    />,
  );
  expect(await screen.findByDisplayValue("Scoped draft")).toBeTruthy();
  expect(window.localStorage.getItem(legacy)).toBeNull();
});
