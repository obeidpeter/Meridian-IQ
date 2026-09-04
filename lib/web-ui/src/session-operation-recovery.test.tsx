// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  createOperationRecoveryFetcher,
  operationSessionKey,
  SessionActivityCenter,
  useSessionOperations,
} from "./session-operation-recovery";
import { beginOperation } from "./operation-journal";
const me = { userId: "A", firmId: "firm-A", clientPartyId: "client-A" };
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

test.each(["firmId", "userId", "clientPartyId"] as const)(
  "the shared hook hides previous local work and cancels recovery when %s changes",
  async (field) => {
    const signals: AbortSignal[] = [];
    const request = vi.fn(async (_path: string, options: RequestInit) => {
      signals.push(options.signal!);
      return { operations: [] };
    });
    act(() => {
      beginOperation(operationSessionKey(me), {
        title: "Scoped local work",
        kind: "export",
        route: "/clients",
      });
    });
    const view = renderHook(
      ({ identity }) => useSessionOperations(identity, request),
      { initialProps: { identity: me } },
    );
    await waitFor(() => expect(view.result.current.syncState).toBe("synced"));
    expect(view.result.current.operations[0]?.title).toBe("Scoped local work");
    view.rerender({ identity: { ...me, [field]: "different" } });
    expect(view.result.current.operations).toEqual([]);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(operationSessionKey({ ...me, [field]: "different" })).not.toBe(
      operationSessionKey(me),
    );
  },
);
test("recovery requests bind firm, preserve abort and no-store, and do not accept arbitrary paths", async () => {
  const request = vi.fn(async () => ({ operations: [] }));
  const fetcher = createOperationRecoveryFetcher(me, request);
  const signal = new AbortController().signal;
  await fetcher("/api/operations?limit=24", { signal, cache: "no-store" });
  expect(request).toHaveBeenCalledWith(
    "/api/operations?limit=24",
    expect.objectContaining({
      signal,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-firm-id": "firm-A" },
    }),
  );
  await expect(
    fetcher("https://foreign.invalid/api/operations", {
      signal,
      cache: "no-store",
    }),
  ).rejects.toThrow();
  expect(operationSessionKey(me)).toBe(
    "meridianiq:operations:firm-A:A:client-A",
  );
  expect(operationSessionKey({ ...me, userId: "B" })).not.toBe(
    operationSessionKey(me),
  );
});
test("ActivityCenter exposes server sync and refresh without recreating the fetcher on equivalent identity", async () => {
  const request = vi.fn(async () => ({ operations: [] }));
  const open = vi.fn();
  const view = render(
    <SessionActivityCenter me={me} request={request} onOpen={open} />,
  );
  await screen.findByText("Server history checked");
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(
    <SessionActivityCenter me={{ ...me }} request={request} onOpen={open} />,
  );
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh operation history" }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  view.rerender(
    <SessionActivityCenter
      me={{ ...me, firmId: "firm-B" }}
      request={request}
      onOpen={open}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.at(-1)?.[1]).toEqual(
    expect.objectContaining({ headers: { "x-firm-id": "firm-B" } }),
  );
});
