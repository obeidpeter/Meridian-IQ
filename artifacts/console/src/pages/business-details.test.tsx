// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, Party } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  id: "client-a",
  me: undefined as Me | undefined,
  party: undefined as Party | undefined,
  meError: null as Error | null,
  error: null as Error | null,
  loading: false,
  read: vi.fn(),
  mutate: vi.fn(),
  retry: vi.fn(),
  retryMe: vi.fn(),
}));
vi.mock("wouter", async (original) => ({
  ...(await original<typeof import("wouter")>()),
  useParams: () => ({ id: h.id }),
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: h.me, error: h.meError, refetch: h.retryMe }),
  useGetParty: (...args: unknown[]) => {
    h.read(...args);
    return {
      data: h.party,
      error: h.error,
      isLoading: h.loading,
      refetch: h.retry,
    };
  },
  useUpdateParty: () => ({ mutateAsync: h.mutate }),
}));
import BusinessDetails from "./business-details";
import {
  getGetPartyQueryKey,
  getGetWorkspaceTodayQueryKey,
} from "@workspace/api-client-react";

const party: Party = {
  id: "client-a",
  type: "client_business",
  legalName: "Acme Ltd",
  tin: "1234567890",
  tinValidated: false,
  street: "1 Market Road",
  city: "Lagos",
  countryCode: "NG",
  createdAt: "2026-09-09T08:00:00Z",
  updatedAt: "2026-09-09T08:00:00Z",
};
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  h.id = "client-a";
  h.me = {
    role: "firm_staff",
    capabilities: ["party.read", "party.write"],
  } as Me;
  h.party = party;
  h.meError = null;
  h.error = null;
  h.loading = false;
  h.mutate.mockResolvedValue({ ...party, city: "Abuja" });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function page() {
  return (
    <QueryClientProvider client={client}>
      <BusinessDetails />
    </QueryClientProvider>
  );
}
function editCity() {
  fireEvent.change(screen.getByLabelText("City"), {
    target: { value: "Abuja" },
  });
}

test("firm staff uses the selected party and changed-only PATCH, then refreshes journey data", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(page());
  expect(h.read).toHaveBeenLastCalledWith("client-a", {
    query: { queryKey: getGetPartyQueryKey("client-a"), enabled: true },
  });
  editCity();
  fireEvent.click(
    screen.getByRole("button", { name: "Save business details" }),
  );
  await screen.findByText("Business details saved.");
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({
    id: "client-a",
    data: { city: "Abuja" },
  });
  expect(client.getQueryData(getGetPartyQueryKey("client-a"))).toMatchObject({
    city: "Abuja",
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: getGetWorkspaceTodayQueryKey(),
  });
  expect(
    screen.getByRole("link", { name: "Back to client" }).getAttribute("href"),
  ).toBe("/clients/client-a");
});

test.each([
  ["firm_staff", ["party.read"]],
  ["auditor", ["party.read"]],
  ["client_user", ["party.read", "party.write"]],
])(
  "%s without permitted firm editing cannot load or submit",
  (role, capabilities) => {
    h.me = { role, capabilities } as Me;
    render(page());
    expect(h.read.mock.lastCall?.[1].query.enabled).toBe(false);
    expect(screen.queryByRole("form")).toBeNull();
    expect(h.mutate).not.toHaveBeenCalled();
  },
);

test("load failure retries and does not show a fabricated blank editor", () => {
  h.party = undefined;
  h.error = new Error("offline");
  render(page());
  expect(screen.queryByRole("form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.retry).toHaveBeenCalledOnce();
});

test("cached refetch failures and account-refresh failures retain unsaved input", async () => {
  const { rerender } = render(page());
  editCity();
  h.error = new Error("offline");
  rerender(page());
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  h.error = null;
  h.meError = new Error("offline");
  rerender(page());
  fireEvent.submit(screen.getByRole("form"));
  expect(h.mutate).not.toHaveBeenCalled();
  h.meError = null;
  rerender(page());
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() =>
    expect(h.mutate).toHaveBeenCalledWith({
      id: "client-a",
      data: { city: "Abuja" },
    }),
  );
});

test("a server save rejection keeps the editor dirty", async () => {
  h.mutate.mockRejectedValue({
    status: 400,
    data: { error: "Save rejected." },
  });
  render(page());
  editCity();
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText("Save rejected.");
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
});

test("merged or mismatched parties cannot be edited", () => {
  h.party = { ...party, mergedIntoId: "client-b" };
  const { rerender } = render(page());
  fireEvent.submit(screen.getByRole("form"));
  expect(h.mutate).not.toHaveBeenCalled();
  h.party = { ...party, id: "client-b" };
  rerender(page());
  expect(screen.queryByRole("form")).toBeNull();
});

test("browser unload warns only while dirty and listeners are cleaned up", () => {
  const warned = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const { unmount } = render(page());
  expect(warned()).toBe(false);
  editCity();
  expect(warned()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(warned()).toBe(false);
  editCity();
  unmount();
  expect(warned()).toBe(false);
});
