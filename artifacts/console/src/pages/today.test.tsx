// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, WorkItem } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  me: undefined as Me | undefined,
  rows: [] as WorkItem[],
  listError: false,
  commentsError: null as { status: number } | null,
  messages: [] as Array<{
    id: string;
    body: string;
    authorName: string;
    createdAt: string;
  }>,
  list: vi.fn(),
  readComments: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  comment: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (original) => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...(await original<typeof import("@workspace/api-client-react")>()),
    useGetMe: () => ({ data: h.me }),
    useGetPortfolio: () => ({ data: { clients: [] } }),
    useListFirmTeam: () => ({ data: [] }),
    listWorkItemsPage: (...args: unknown[]) => h.list(...args),
    useListWorkItemComments: (
      id: string,
      options: { query: { queryKey: unknown[]; enabled: boolean } },
    ) => useQuery({ ...options.query, queryFn: () => h.readComments(id) }),
    useCreateWorkItem: () => ({ mutateAsync: h.create, isPending: false }),
    useUpdateWorkItem: () => ({ mutateAsync: h.update, isPending: false }),
    useCreateWorkItemComment: () => ({
      mutateAsync: h.comment,
      isPending: false,
    }),
  };
});
vi.mock("@workspace/web-ui", async (original) => ({
  ...(await original<typeof import("@workspace/web-ui")>()),
  trackUsabilityEvent: vi.fn(),
}));
import { WorkPage } from "./today";
import { getListWorkItemsPageQueryKey } from "@workspace/api-client-react";

let client: QueryClient;
let created: WorkItem;
function task(id: string, status: WorkItem["status"] = "open"): WorkItem {
  return {
    id,
    firmId: "firm-a",
    clientPartyId: null,
    clientName: "Fixture client",
    title: id === "created" ? "New low-priority task" : "Existing " + id,
    description: null,
    status,
    priority: id === "created" ? "low" : "high",
    dueAt: null,
    assignedTo: null,
    assignedToName: null,
    createdBy: "user-a",
    createdByName: "Accountant",
    entityType: null,
    entityId: null,
    href: null,
    version: 1,
    completedAt: null,
    createdAt: "2026-09-09T08:00:00Z",
    updatedAt: "2026-09-09T08:00:00Z",
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.me = {
    userId: "user-a",
    firmId: "firm-a",
    clientPartyId: null,
    role: "firm_admin",
    capabilities: ["work.read", "work.write"],
  } as Me;
  created = task("created");
  h.rows = [
    ...Array.from({ length: 125 }, (_, i) => task("task-" + i)),
    task("done", "done"),
  ];
  h.listError = false;
  h.commentsError = null;
  h.messages = [];
  h.list.mockImplementation(async ({ view }: { view: string }) => {
    if (h.listError) throw new Error("Task refresh unavailable");
    const rows = h.rows.filter(
      (item) =>
        view === "all" ||
        (view === "done" ? item.status === "done" : item.status !== "done"),
    );
    return {
      items: rows.slice(0, 50),
      total: rows.length,
      nextCursor: rows.length > 50 ? "page-2" : null,
    };
  });
  h.readComments.mockImplementation(async (id: string) => {
    if (id === "created" && h.commentsError) throw h.commentsError;
    return id === "created" ? h.messages : [];
  });
  h.create.mockResolvedValue(created);
  h.update.mockImplementation(async ({ data }: { data: Partial<WorkItem> }) => {
    created = { ...created, ...data, version: created.version + 1 };
    return created;
  });
  h.comment.mockImplementation(async ({ data }: { data: { body: string } }) => {
    h.messages = [
      {
        id: "comment",
        body: data.body,
        authorName: "Accountant",
        createdAt: "2026-09-09T08:00:00Z",
      },
    ];
    return h.messages[0];
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
function page() {
  return (
    <QueryClientProvider client={client}>
      <WorkPage />
    </QueryClientProvider>
  );
}
function header() {
  return within(
    screen.getByRole("heading", { name: "Team work" }).closest("header")!,
  );
}
function detail() {
  return within(screen.getByRole("region", { name: "Selected work item" }));
}
function filters() {
  return within(screen.getByRole("group", { name: "Filter team work" }));
}
async function start() {
  const view = render(page());
  await screen.findByText("Showing 50 of 125 tasks");
  return view;
}
async function createTask() {
  fireEvent.click(header().getByRole("button", { name: "New task" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Task title"), {
    target: { value: created.title },
  });
  fireEvent.change(within(dialog).getByLabelText("Priority"), {
    target: { value: "low" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("heading", { name: created.title })).toBeTruthy();
}
async function refresh() {
  await act(async () => {
    await client.invalidateQueries({
      queryKey: getListWorkItemsPageQueryKey(),
    });
  });
}

test.each([false, true])(
  "creation beyond 50 rows retains its discussion when refresh failure is %s",
  async (failure) => {
    await start();
    h.listError = failure;
    await createTask();
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: created.title,
        priority: "low",
        clientRequestId: expect.any(String),
      }),
    });
    expect(screen.getByText("Showing 50 of 125 tasks")).toBeTruthy();
    if (failure)
      expect(screen.getByRole("alert").textContent).toContain(
        "Task refresh unavailable",
      );
    expect(h.readComments).toHaveBeenCalledWith("created");
    fireEvent.change(detail().getByLabelText("Add a comment"), {
      target: { value: "Decision for newly created task" },
    });
    fireEvent.click(detail().getByRole("button", { name: "Comment" }));
    await screen.findByText("Decision for newly created task");
    expect(h.comment).toHaveBeenCalledWith({
      id: "created",
      data: {
        body: "Decision for newly created task",
        clientRequestId: expect.any(String),
      },
    });
    expect(screen.getByRole("heading", { name: created.title })).toBeTruthy();
  },
);

test("creation from Completed reveals Active and retains the new selection", async () => {
  await start();
  fireEvent.click(filters().getByRole("button", { name: "Completed" }));
  await screen.findByText("Showing 1 of 1 tasks");
  await createTask();
  expect(
    filters()
      .getByRole("button", { name: "Active" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("heading", { name: created.title })).toBeTruthy();
  expect(h.readComments).toHaveBeenCalledWith("created");
});

test("status updates retain the latest version, and completion clears the Active selection", async () => {
  await start();
  await createTask();
  fireEvent.change(detail().getByLabelText("Status"), {
    target: { value: "blocked" },
  });
  await waitFor(() =>
    expect((detail().getByLabelText("Status") as HTMLSelectElement).value).toBe(
      "blocked",
    ),
  );
  fireEvent.change(detail().getByLabelText("Status"), {
    target: { value: "done" },
  });
  await waitFor(() =>
    expect(h.update).toHaveBeenLastCalledWith({
      id: "created",
      data: { version: 2, status: "done" },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
  );
});

test.each([
  "userId",
  "firmId",
  "clientPartyId",
  "role",
  "capabilities",
] as const)(
  "changing %s drops created selection and its private discussion",
  async (field) => {
    const view = await start();
    await createTask();
    fireEvent.change(detail().getByLabelText("Add a comment"), {
      target: { value: "Private unsent comment" },
    });
    h.me = {
      ...h.me!,
      [field]:
        field === "capabilities"
          ? ["work.read"]
          : field === "role"
            ? "firm_staff"
            : "other-scope",
    };
    view.rerender(page());
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
    );
    expect(screen.queryByDisplayValue("Private unsent comment")).toBeNull();
    const commentQueries = client
      .getQueryCache()
      .findAll()
      .filter((query) => String(query.queryKey[0]).includes("/comments"));
    expect(
      commentQueries.some((query) =>
        JSON.stringify(query.queryKey).includes("user-a"),
      ),
    ).toBe(true);
  },
);

test("a late create response cannot reselect a task after the account changes", async () => {
  let finish!: (item: WorkItem) => void;
  h.create.mockImplementation(
    () =>
      new Promise<WorkItem>((resolve) => {
        finish = resolve;
      }),
  );
  const view = await start();
  fireEvent.click(header().getByRole("button", { name: "New task" }));
  fireEvent.change(screen.getByLabelText("Task title"), {
    target: { value: created.title },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Create task",
    }),
  );
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  h.me = { ...h.me!, userId: "user-b" };
  view.rerender(page());
  await act(async () => {
    finish(created);
  });
  expect(screen.queryByRole("heading", { name: created.title })).toBeNull();
  expect(h.readComments).not.toHaveBeenCalledWith("created");
});

test.each([401, 403, 404])(
  "a %s discussion response clears the off-page record",
  async (status) => {
    await start();
    await createTask();
    h.commentsError = { status };
    await act(async () => {
      await client.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0]).includes("/created/comments"),
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
    );
  },
);

test.each([401, 403, 404])(
  "list %s clears the creation even when discussion has a transient failure",
  async (status) => {
    await start();
    await createTask();
    h.commentsError = { status: 503 };
    h.list.mockRejectedValue({ status });
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
    );
  },
);

test("a confirmed mutation access failure clears the off-page selection", async () => {
  await start();
  await createTask();
  h.comment.mockRejectedValue({ status: 403 });
  fireEvent.change(detail().getByLabelText("Add a comment"), {
    target: { value: "No longer permitted" },
  });
  fireEvent.click(detail().getByRole("button", { name: "Comment" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
  );
});

test("once loaded, a later removal does not resurrect the creation snapshot", async () => {
  await start();
  await createTask();
  h.rows.unshift(created);
  await refresh();
  expect(
    (await screen.findByText(created.title, { selector: "strong" })).closest(
      "button",
    ),
  ).toBeTruthy();
  h.rows.shift();
  await refresh();
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
  );
});

test("a fresh complete result excluding the created task clears its snapshot", async () => {
  await start();
  await createTask();
  h.rows = [];
  await refresh();
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: created.title })).toBeNull(),
  );
});

test("changing view or selecting another row discards the off-page fallback", async () => {
  await start();
  await createTask();
  fireEvent.click(
    screen
      .getByText("Existing task-0", { selector: "strong" })
      .closest("button")!,
  );
  expect(screen.queryByRole("heading", { name: created.title })).toBeNull();
  fireEvent.click(filters().getByRole("button", { name: "Completed" }));
  await screen.findByText("Showing 1 of 1 tasks");
  fireEvent.click(filters().getByRole("button", { name: "Active" }));
  await screen.findByText("Showing 50 of 125 tasks");
  expect(screen.queryByRole("heading", { name: created.title })).toBeNull();
});
