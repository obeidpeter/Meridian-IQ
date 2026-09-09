// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWithClient } from "../test-utils";

const harness = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({
      data: { userId: "user", firmId: "firm", clientPartyId: "client" },
    }),
  };
});
vi.mock("@/lib/invoice-pages", () => ({
  useInvoicePages: () => ({
    loaded: [],
    hasLoaded: true,
    hasMore: false,
    loadingMore: false,
    initialLoading: false,
    isError: false,
    refetch: vi.fn(),
    loadMore: vi.fn(),
    resetToFirstPage: vi.fn(),
    query: "",
    counts: {},
    total: 0,
  }),
}));

import { Invoices } from "./invoices";

beforeEach(() => {
  harness.submit.mockReset();
  vi.stubGlobal("fetch", harness.submit);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog() {
  renderWithClient(<Invoices />);
  const trigger = screen.getByTestId("button-bulk-submit");
  fireEvent.click(trigger);
  await screen.findByRole("dialog");
  // Radix installs its outside-pointer listener in the following task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return trigger;
}

for (const method of ["Escape", "Cancel", "Close", "outside"]) {
  test(`${method} closes the idle bulk dialog and restores its external trigger`, async () => {
    const trigger = await openDialog();
    if (method === "Escape")
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    else if (method === "outside")
      fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    else fireEvent.click(screen.getByRole("button", { name: method }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(harness.submit).not.toHaveBeenCalled();
  });
}

test("pending confirmation and next batch cannot dismiss onto a disabled trigger", async () => {
  let finish: (value: { rows: []; remaining: number }) => void;
  // Exercise the generated mutation hook and transport; hold only HTTP completion.
  harness.submit.mockImplementation((url, options) => {
    expect(url).toBe("/api/invoices/bulk-submit");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ clientPartyId: "client" });
    return new Promise<Response>((resolve) => {
      finish = (value) =>
        resolve(
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
    });
  });
  const trigger = await openDialog();
  for (const batch of [1, 2]) {
    fireEvent.click(
      screen.getByTestId(
        batch === 1 ? "button-confirm-bulk-submit" : "button-bulk-next-batch",
      ),
    );
    await waitFor(() =>
      expect((trigger as HTMLButtonElement).disabled).toBe(true),
    );
    const dialog = screen.getByRole("dialog");
    for (const close of screen.getAllByRole("button", {
      name: batch === 1 ? /^(Cancel|Close)$/ : "Close",
    })) {
      expect((close as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(close);
    }
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(harness.submit).toHaveBeenCalledTimes(batch);
    await act(async () => {
      finish({ rows: [], remaining: batch === 1 ? 1 : 0 });
    });
    await waitFor(() =>
      expect((trigger as HTMLButtonElement).disabled).toBe(false),
    );
  }
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
