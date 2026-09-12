// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Router, Route, Switch, useLocation, useSearch } from "wouter";
import {
  UnsavedWorkProvider,
  useProtectedLocation,
  useProtectedSearch,
} from "../../../../lib/web-ui/src/unsaved-work";
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
  window.history.replaceState(
    null,
    "",
    "/clients/client-a/business?tab=identity",
  );
  vi.clearAllMocks();
  h.id = "client-a";
  h.me = {
    userId: "user-a",
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
      <UnsavedWorkProvider>
        <Router hook={useProtectedLocation} searchHook={useProtectedSearch}>
          <NavigationProbe />
          <Switch>
            <Route path="/clients/:id/business">
              <BusinessDetails />
            </Route>
            <Route>
              <h1>Client workspace</h1>
            </Route>
          </Switch>
        </Router>
      </UnsavedWorkProvider>
    </QueryClientProvider>
  );
}
function NavigationProbe() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  return (
    <>
      <output aria-label="Route">
        {location}?{search}
      </output>
      <button
        onClick={() =>
          navigate("/portfolio?scope=mine", {
            replace: true,
            state: { from: "business" },
          })
        }
      >
        Open portfolio
      </button>
    </>
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
    data: { city: "Abuja", expectedUpdatedAt: "2026-09-09T08:00:00Z" },
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
      data: { city: "Abuja", expectedUpdatedAt: "2026-09-09T08:00:00Z" },
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

test("a 409 from a newer save refetches the record and keeps the unsaved edit (R113)", async () => {
  h.mutate.mockRejectedValueOnce(
    Object.assign(new Error("Conflict"), {
      status: 409,
      data: {
        error:
          "These business details changed since you loaded them. Review the latest saved values and try again.",
      },
    }),
  );
  render(page());
  editCity();
  fireEvent.click(
    screen.getByRole("button", { name: "Save business details" }),
  );
  await screen.findByText(/changed since you loaded them/);
  expect(h.retry).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({
    id: "client-a",
    data: { city: "Abuja", expectedUpdatedAt: "2026-09-09T08:00:00Z" },
  });
});

test("wouter back link supports Stay and Discard without sending a save", async () => {
  render(page());
  editCity();
  fireEvent.click(screen.getByRole("link", { name: "Back to client" }));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(window.location.search).toBe("?tab=identity");
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  fireEvent.click(screen.getByRole("link", { name: "Back to client" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(window.location.pathname).toBe("/clients/client-a");
  expect(
    screen.getByRole("heading", { name: "Client workspace" }),
  ).toBeTruthy();
  expect(h.mutate).not.toHaveBeenCalled();
});

test("programmatic replacement waits for confirmed save and keeps the destination query", async () => {
  h.mutate.mockRejectedValueOnce({
    status: 409,
    data: { error: "Newer saved details exist." },
  });
  render(page());
  editCity();
  const length = window.history.length;
  fireEvent.click(screen.getByRole("button", { name: "Open portfolio" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await screen.findByText("Newer saved details exist.");
  expect(window.location.pathname).toBe("/clients/client-a/business");
  expect(h.retry).toHaveBeenCalledOnce();
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Client workspace" });
  expect(window.location.search).toBe("?scope=mine");
  expect(window.history.length).toBe(length);
  expect(h.mutate).toHaveBeenCalledTimes(2);
});

test("an account switch cancels pending navigation, drops the old draft and ignores the old save response", async () => {
  let finish!: (value: Party) => void;
  h.mutate.mockImplementationOnce(
    () =>
      new Promise<Party>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(page());
  editCity();
  fireEvent.click(screen.getByRole("button", { name: "Open portfolio" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => expect(h.mutate).toHaveBeenCalledOnce());
  h.me = { ...h.me!, userId: "user-b" };
  view.rerender(page());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Lagos",
  );
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(client.getQueryData(getGetPartyQueryKey("client-a"))).toBeUndefined();
  expect(window.location.pathname).toBe("/clients/client-a/business");
});

test("a mismatched successful response is rejected before it can replace the cached editor", async () => {
  h.mutate.mockResolvedValueOnce({ ...party, id: "another-business" });
  render(page());
  editCity();
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText(
    "The saved business record did not match this business.",
  );
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(client.getQueryData(getGetPartyQueryKey("client-a"))).toBeUndefined();
});
