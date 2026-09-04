// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getParty, listParties, type Party } from "@workspace/api-client-react";
import { CustomerDirectoryPicker } from "./customer-directory-picker";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { firmId: "firm", userId: "user", clientPartyId: "client" },
  }),
  getParty: vi.fn(),
  listParties: vi.fn(),
}));
const parties = Array.from(
  { length: 630 },
  (_, index) =>
    ({
      id: `buyer-${index}`,
      legalName: `Customer ${String(index).padStart(3, "0")}`,
      type: "buyer",
      tin: `TIN-${index}`,
    }) as Party,
);
function renderPicker(value = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Form() {
    const [selected, setSelected] = useState(value);
    return (
      <>
        <label htmlFor="customer">Customer</label>
        <CustomerDirectoryPicker
          id="customer"
          value={selected}
          onChange={setSelected}
        />
        <output data-testid="selection">{selected}</output>
      </>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(getParty).mockImplementation(
    async (id) => parties.find((party) => party.id === id)!,
  );
  vi.mocked(listParties).mockImplementation(async (params) =>
    parties
      .filter(
        (party) =>
          !params?.q ||
          party.legalName.includes(params.q) ||
          party.tin?.includes(params.q),
      )
      .slice(
        params?.offset ?? 0,
        (params?.offset ?? 0) + (params?.limit ?? 30),
      ),
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("customer directory combobox", () => {
  test("searches and selects a customer beyond 500 using only the keyboard", async () => {
    renderPicker();
    const input = screen.getByRole("combobox", { name: "Customer" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Customer 600" } });
    await screen.findByRole("option", { name: /Customer 600/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("selection").textContent).toBe("buyer-600");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(
      vi
        .mocked(listParties)
        .mock.calls.every(([params]) => params?.limit === 30),
    ).toBe(true);
  });
  test("hydrates a saved selected ID independently of the first search page", async () => {
    renderPicker("buyer-612");
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
        "Customer 612",
      ),
    );
    expect(getParty).toHaveBeenCalledWith(
      "buyer-612",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(listParties).not.toHaveBeenCalled();
  });
  test("loads subsequent directory pages", async () => {
    renderPicker();
    fireEvent.focus(screen.getByRole("combobox"));
    await screen.findByRole("option", { name: /Customer 029/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Load more customers" }),
    );
    await screen.findByRole("option", { name: /Customer 030/ });
    expect(
      vi
        .mocked(listParties)
        .mock.calls.some(([params]) => params?.offset === 30),
    ).toBe(true);
  });
  test("aborts stale searches and never displays their late results", async () => {
    let oldSignal: AbortSignal | undefined;
    let finish!: (parties: Party[]) => void;
    vi.mocked(listParties).mockImplementationOnce((_params, options) => {
      oldSignal = options?.signal ?? undefined;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    renderPicker();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await waitFor(() => expect(oldSignal).toBeDefined());
    fireEvent.change(input, { target: { value: "Customer 620" } });
    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    finish([parties[0]]);
    await screen.findByRole("option", { name: /Customer 620/ });
    expect(screen.queryByRole("option", { name: /Customer 000/ })).toBeNull();
  });
  test("reports errors separately from empty results and supports retry", async () => {
    vi.mocked(listParties).mockRejectedValueOnce(new Error("offline"));
    renderPicker();
    fireEvent.focus(screen.getByRole("combobox"));
    await screen.findByRole("button", { name: "Retry search" });
    expect(screen.queryByText("No matching customers.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    await screen.findByRole("option", { name: /Customer 000/ });
  });
  test("Escape closes the popup without changing the selected customer", async () => {
    renderPicker("buyer-600");
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "another" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("selection").textContent).toBe("buyer-600");
  });
});
