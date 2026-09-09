// @vitest-environment jsdom
import { vi } from "vitest";
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
import { runTeamWorkPageSuite } from "@workspace/web-ui/team-work-page-suite";

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

// The suite itself is shared with the other app (R114); this file supplies
// the mocks above, the typed rows, and the identity this app signs in as.
runTeamWorkPageSuite({
  WorkPage,
  harness: h,
  task,
  identity: () =>
    ({
      userId: "user-a",
      firmId: "firm-a",
      clientPartyId: null,
      role: "firm_admin",
      capabilities: ["work.read", "work.write"],
    }) as Me,
  createQueryClient: () =>
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
  QueryClientProvider,
  listPageQueryKey: getListWorkItemsPageQueryKey,
});
