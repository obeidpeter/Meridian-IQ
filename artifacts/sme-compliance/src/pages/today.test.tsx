// @vitest-environment jsdom
import { describe, vi } from "vitest";
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
// R113 setup-panel harness: the api-client-react mock factory below is
// hoisted, so this must be too.
const setup = vi.hoisted(() => ({
  error: null as Error | null,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (original) => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...(await original<typeof import("@workspace/api-client-react")>()),
    useGetWorkspaceToday: () => ({
      data: todaySetupFixture,
      isLoading: false,
      isFetching: setup.isFetching,
      error: setup.error,
      refetch: setup.refetch,
    }),
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
import { Today, WorkPage } from "./today";
import { getListWorkItemsPageQueryKey } from "@workspace/api-client-react";
import { runTeamWorkPageSuite } from "@workspace/web-ui/team-work-page-suite";
import {
  runTodaySetupSuite,
  todaySetupFixture,
} from "@workspace/web-ui/today-setup-suite";

function task(id: string, status: WorkItem["status"] = "open"): WorkItem {
  return {
    id,
    firmId: "firm-a",
    clientPartyId: "client-a",
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

// The suites themselves are shared with the other app (R114, R113); this
// file supplies the mocks above, the typed rows, and the identity this app
// signs in as. Each suite registers its own beforeEach/afterEach, so each
// sits in its own describe and the hooks never wrap the other's tests.
describe("team work page", () => {
  runTeamWorkPageSuite({
    WorkPage,
    harness: h,
    task,
    identity: () =>
      ({
        userId: "user-a",
        firmId: "firm-a",
        clientPartyId: "client-a",
        role: "client_user",
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
});

describe("today setup (R113)", () => {
  runTodaySetupSuite({ Today, harness: setup });
});
