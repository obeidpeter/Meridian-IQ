// The console and SME Team work pages are the same page for two identities
// (a firm admin and a client user), so their page suites were byte-identical
// apart from the identity fixture. This is the one suite both apps run
// (R114); each app keeps only its module mocks, its typed task factory and
// the identity it signs in as. Not a test file itself: nothing runs unless an
// app calls runTeamWorkPageSuite.
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";

export interface TeamWorkRow {
  id: string;
  title: string;
  status: string;
  version: number;
}

// Mirrors the optional/nullable shape of the generated Me type so an app's
// Me fixture is assignable without a cast.
export interface TeamWorkIdentity {
  userId: string;
  firmId?: string | null;
  clientPartyId?: string | null;
  role: string;
  capabilities: string[];
}

export interface TeamWorkHarness<
  T extends TeamWorkRow,
  I extends TeamWorkIdentity,
> {
  me: I | undefined;
  rows: T[];
  listError: boolean;
  commentsError: { status: number } | null;
  messages: Array<{
    id: string;
    body: string;
    authorName: string;
    createdAt: string;
  }>;
  list: Mock;
  readComments: Mock;
  create: Mock;
  update: Mock;
  comment: Mock;
}

// The structural slice of a TanStack QueryClient the suite touches; web-ui
// deliberately does not depend on react-query, the calling app supplies it.
export interface QueryLike {
  queryKey: readonly unknown[];
}

export interface QueryClientLike {
  clear(): void;
  getQueryCache(): { findAll(): QueryLike[] };
  invalidateQueries(filters?: {
    queryKey?: readonly unknown[];
    predicate?: (query: QueryLike) => boolean;
  }): Promise<void>;
}

export function runTeamWorkPageSuite<
  T extends TeamWorkRow,
  I extends TeamWorkIdentity,
  Q extends QueryClientLike,
>(options: {
  WorkPage: ComponentType;
  harness: TeamWorkHarness<T, I>;
  task: (id: string, status?: T["status"]) => T;
  identity: () => I;
  createQueryClient: () => Q;
  QueryClientProvider: ComponentType<{ client: Q; children?: ReactNode }>;
  listPageQueryKey: () => readonly unknown[];
}): void {
  const {
    WorkPage,
    harness: h,
    task,
    identity,
    createQueryClient,
    QueryClientProvider,
    listPageQueryKey: getListWorkItemsPageQueryKey,
  } = options;
  let client: Q;
  let created: T;
  beforeEach(() => {
    vi.clearAllMocks();
    h.me = identity();
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
    h.update.mockImplementation(async ({ data }: { data: Partial<T> }) => {
      created = { ...created, ...data, version: created.version + 1 };
      return created;
    });
    h.comment.mockImplementation(
      async ({ data }: { data: { body: string } }) => {
        h.messages = [
          {
            id: "comment",
            body: data.body,
            authorName: "Accountant",
            createdAt: "2026-09-09T08:00:00Z",
          },
        ];
        return h.messages[0];
      },
    );
    client = createQueryClient();
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
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create task" }),
    );
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

  test("task drafts are saved under the user, firm and client scoped key (R116)", async () => {
    await start();
    fireEvent.click(header().getByRole("button", { name: "New task" }));
    fireEvent.change(
      within(screen.getByRole("dialog")).getByLabelText("Task title"),
      { target: { value: "Scoped draft title" } },
    );
    const me = h.me!;
    const key = `meridianiq:work-draft:${me.userId}:${me.firmId ?? "none"}:${me.clientPartyId ?? "firm"}`;
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(key) ?? "{}").title).toBe(
        "Scoped draft title",
      ),
    );
    expect(
      window.localStorage.getItem(`meridianiq:work-draft:${me.userId}`),
    ).toBeNull();
  });

  test("loading more shows the newest page's scoped total, not the first page's (R114)", async () => {
    const active = () => h.rows.filter((row) => row.status !== "done");
    h.list.mockImplementation(async ({ cursor }: { cursor?: string }) => ({
      items: cursor ? active().slice(50, 100) : active().slice(0, 50),
      total: cursor ? 126 : 125,
      nextCursor: cursor ? null : "page-2",
    }));
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByText("Showing 100 of 126 tasks");
  });

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
      expect(
        (detail().getByLabelText("Status") as HTMLSelectElement).value,
      ).toBe("blocked"),
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
        expect(
          screen.queryByRole("heading", { name: created.title }),
        ).toBeNull(),
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
    let finish!: (item: T) => void;
    h.create.mockImplementation(
      () =>
        new Promise<T>((resolve) => {
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
        expect(
          screen.queryByRole("heading", { name: created.title }),
        ).toBeNull(),
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
        expect(
          screen.queryByRole("heading", { name: created.title }),
        ).toBeNull(),
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
}
