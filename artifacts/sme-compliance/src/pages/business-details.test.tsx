// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Router, Route, Switch, useLocation } from "wouter";
import {
  UnsavedWorkProvider,
  useProtectedLocation,
  useProtectedSearch,
} from "../../../../lib/web-ui/src/unsaved-work";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, Party } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  me: undefined as Me | undefined,
  party: undefined as Party | undefined,
  error: null as Error | null,
  loading: false,
  read: vi.fn(),
  mutate: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: h.me, error: null, refetch: vi.fn() }),
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
  id: "own-client",
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
  h.me = {
    userId: "user-a",
    role: "client_user",
    clientPartyId: "own-client",
    capabilities: ["party.read"],
  } as Me;
  h.party = party;
  h.error = null;
  h.loading = false;
  h.mutate.mockResolvedValue({ ...party, city: "Abuja" });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  window.history.replaceState(
    {},
    "",
    "/business?clientPartyId=other-client&id=other-client",
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  window.history.replaceState({}, "", "/");
});
function page() {
  return (
    <QueryClientProvider client={client}>
      <UnsavedWorkProvider>
        <Router hook={useProtectedLocation} searchHook={useProtectedSearch}>
          <NavigationProbe />
          <Switch>
            <Route path="/business">
              <BusinessDetails />
            </Route>
            <Route>
              <h1>Today workspace</h1>
            </Route>
          </Switch>
        </Router>
      </UnsavedWorkProvider>
    </QueryClientProvider>
  );
}
function NavigationProbe() {
  const [, navigate] = useLocation();
  return (
    <button
      onClick={() =>
        navigate("/invoices?status=draft", { state: { from: "business" } })
      }
    >
      Open invoices
    </button>
  );
}
function editCity() {
  fireEvent.change(screen.getByLabelText("City"), {
    target: { value: "Abuja" },
  });
}

test("client self-service reads and writes me.clientPartyId only, without party.write", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(page());
  expect(h.read).toHaveBeenLastCalledWith("own-client", {
    query: { queryKey: getGetPartyQueryKey("own-client"), enabled: true },
  });
  editCity();
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText("Business details saved.");
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({
    id: "own-client",
    data: { city: "Abuja", expectedUpdatedAt: "2026-09-09T08:00:00Z" },
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: getGetWorkspaceTodayQueryKey(),
  });
  expect(
    screen.getByRole("link", { name: "Back to Today" }).getAttribute("href"),
  ).toBe("/");
});

test.each([
  ["client_user", null],
  ["firm_staff", "own-client"],
  ["buyer_user", "own-client"],
])(
  "%s with scope %s cannot choose a business from the URL",
  (role, clientPartyId) => {
    h.me = {
      role,
      clientPartyId,
      capabilities: ["party.read", "party.write"],
    } as Me;
    render(page());
    expect(h.read.mock.lastCall?.[1].query.enabled).toBe(false);
    expect(screen.queryByRole("form")).toBeNull();
    expect(h.mutate).not.toHaveBeenCalled();
  },
);

test("load error offers retry, while loading has no blank editable defaults", () => {
  h.party = undefined;
  h.loading = true;
  const { rerender } = render(page());
  expect(screen.queryByRole("form")).toBeNull();
  h.loading = false;
  h.error = new Error("offline");
  rerender(page());
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.retry).toHaveBeenCalledOnce();
});

test("dirty values survive a cached refetch error and a save rejection", async () => {
  h.mutate.mockRejectedValue(new Error("Save rejected."));
  const { rerender } = render(page());
  editCity();
  h.error = new Error("offline");
  rerender(page());
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText("Save rejected.");
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
});

test("a mismatched response is never an editable sibling-business record", () => {
  h.party = { ...party, id: "other-client" };
  render(page());
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(
    "These details do not belong to your business.",
  );
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
    id: "own-client",
    data: { city: "Abuja", expectedUpdatedAt: "2026-09-09T08:00:00Z" },
  });
});

test("wouter back link supports Stay and Discard without sending a save", () => {
  render(page());
  editCity();
  fireEvent.click(screen.getByRole("link", { name: "Back to Today" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  fireEvent.click(screen.getByRole("link", { name: "Back to Today" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(window.location.pathname).toBe("/");
  expect(screen.getByRole("heading", { name: "Today workspace" })).toBeTruthy();
  expect(h.mutate).not.toHaveBeenCalled();
});

test("programmatic navigation keeps the user on network failure and resumes only after confirmed retry", async () => {
  h.mutate.mockRejectedValueOnce(new Error("Connection interrupted."));
  render(page());
  editCity();
  fireEvent.click(screen.getByRole("button", { name: "Open invoices" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Connection interrupted.");
  expect(window.location.pathname).toBe("/business");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Today workspace" });
  expect(window.location.search).toBe("?status=draft");
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
  fireEvent.click(screen.getByRole("button", { name: "Open invoices" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(h.mutate).toHaveBeenCalledOnce());
  h.me = { ...h.me!, userId: "user-b" };
  view.rerender(page());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Lagos",
  );
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(
    client.getQueryData(getGetPartyQueryKey("own-client")),
  ).toBeUndefined();
  expect(window.location.pathname).toBe("/business");
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
  expect(
    client.getQueryData(getGetPartyQueryKey("own-client")),
  ).toBeUndefined();
});
