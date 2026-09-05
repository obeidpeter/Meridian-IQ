// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  beginOperation,
  clearCompletedOperations,
  dismissOperation,
  readOperations,
  updateOperation,
  reconcileOperations,
  useOperationJournal,
} from "./operation-journal";

const KEY = "meridianiq:operations:user-1";
const RUN_ROUTE = "/import?run=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function serverOperation(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    command: "invoice.import",
    idempotencyKey: "run-one",
    status: "succeeded",
    route: "/import",
    summary: "2 drafts created; 0 rows not created.",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function beginDurable() {
  return beginOperation(KEY, {
    title: "Invoice import",
    kind: "import",
    route: "/import",
    command: "invoice.import",
    idempotencyKey: "run-one",
  })!;
}

describe("server operation reconciliation", () => {
  test("beginOperation ID is the default durable request key", () => {
    const record = beginOperation(KEY, {
      title: "Create invoice",
      kind: "invoice",
      route: "/invoices",
      command: "invoice.create",
    });
    expect(record?.idempotencyKey).toBe(record?.id);
    expect(record?.verification).toBe("unconfirmed");
  });

  test("matches a lost-response local command and replaces its unconfirmed outcome", async () => {
    const local = beginDurable();
    const fetcher = vi.fn().mockResolvedValue({
      operations: [
        serverOperation({
          status: "partial",
          summary: "1 created; 1 invalid.",
        }),
      ],
    });
    const records = await reconcileOperations(
      [local],
      { fetcher },
      new AbortController().signal,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: local.id,
      serverId: serverOperation().id,
      status: "partial",
      verification: "server",
      savedSummary: "1 created; 1 invalid.",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/operations?limit=24",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  test.each([
    ["invoice.create", "/invoices"],
    ["invoice.import", "/import"],
    ["invoice.import", RUN_ROUTE],
  ])(
    "second-device history preserves authorized %s route %s without local records",
    async (command, route) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue({
          operations: [serverOperation({ command, route })],
        });
      const records = await reconcileOperations(
        [],
        { fetcher },
        new AbortController().signal,
      );
      expect(records[0].verification).toBe("server");
      expect(records[0].route).toBe(route);
      expect(window.localStorage.getItem(KEY)).toBeNull();
    },
  );

  test.each([
    "/import",
    "/import?run=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "https://foreign.invalid/import",
  ])(
    "reconciliation replaces local route %s with the joined server run",
    async (route) => {
      const local = { ...beginDurable(), route };
      const records = await reconcileOperations(
        [local],
        {
          fetcher: async () => ({
            operations: [serverOperation({ route: RUN_ROUTE })],
          }),
        },
        new AbortController().signal,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: local.id,
        route: RUN_ROUTE,
        verification: "server",
      });
    },
  );

  test("a legacy server operation never borrows a local run-shaped route or key", async () => {
    const local = {
      ...beginDurable(),
      route: RUN_ROUTE,
      idempotencyKey: "import-run:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0",
    };
    const records = await reconcileOperations(
      [local],
      {
        fetcher: async () => ({
          operations: [
            serverOperation({ idempotencyKey: local.idempotencyKey }),
          ],
        }),
      },
      new AbortController().signal,
    );
    expect(records[0].route).toBe("/import");
  });

  test("looks up old keys outside the recent page and retains exact recovered results only in memory", async () => {
    const local = beginDurable();
    const body = {
      rows: [{ rowNumber: 1, status: "created", invoiceId: "saved-id" }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ operations: [] })
      .mockResolvedValueOnce(
        serverOperation({
          route: RUN_ROUTE,
          result: { statusCode: 200, body },
        }),
      );
    const records = await reconcileOperations(
      [local],
      { fetcher },
      new AbortController().signal,
    );
    expect(records[0].serverResult?.body).toEqual(body);
    expect(records[0].route).toBe(RUN_ROUTE);
    expect(fetcher.mock.calls[1][0]).toBe(
      "/api/operations/lookup?command=invoice.import&idempotencyKey=run-one",
    );
    expect(window.localStorage.getItem(KEY)).not.toContain("saved-id");
  });

  test.each([
    ["invoice.import", undefined],
    ["invoice.import", null],
    ["invoice.import", "/invoices"],
    ["invoice.create", "/import"],
    ["invoice.create", RUN_ROUTE],
    ["invoice.create", "/invoices/new"],
    ["invoice.create", "/invoices?run=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["invoice.import", "https://foreign.invalid" + RUN_ROUTE],
    ["invoice.import", "//foreign.invalid" + RUN_ROUTE],
    ["invoice.import", "/\\foreign.invalid"],
    ["invoice.import", "/import/../clients/import"],
    ["invoice.import", "/Import?run=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["invoice.import", "/import?run=not-a-uuid"],
    ["invoice.import", "/import?run="],
    ["invoice.import", RUN_ROUTE + "&run=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["invoice.import", RUN_ROUTE + "&next=https://foreign.invalid"],
    ["invoice.import", RUN_ROUTE + "#result"],
    ["invoice.import", RUN_ROUTE + "/"],
    ["invoice.import", RUN_ROUTE + "\n"],
    ["invoice.import", RUN_ROUTE + "\r\n"],
    ["invoice.import", RUN_ROUTE.replace("run=", "%72un=")],
    ["invoice.import", RUN_ROUTE.replace("-", "%2D")],
  ])(
    "rejects an unauthorized server route for %s: %s",
    async (command, route) => {
      await expect(
        reconcileOperations(
          [],
          {
            fetcher: async () => ({
              operations: [serverOperation({ command, route })],
            }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Invalid operation response");
    },
  );

  test("a missing committed record stays unconfirmed, never infers failure or success", async () => {
    const local = beginDurable();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ operations: [] })
      .mockRejectedValueOnce({ status: 404 });
    const records = await reconcileOperations(
      [local],
      { fetcher },
      new AbortController().signal,
    );
    expect(records[0]).toMatchObject({
      status: "partial",
      verification: "unconfirmed",
      savedSummary: "Outcome unconfirmed.",
    });
  });

  test("rejects mismatched lookup results and malformed server data", async () => {
    const local = beginDurable();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ operations: [] })
      .mockResolvedValueOnce(
        serverOperation({ idempotencyKey: "different-key" }),
      );
    await expect(
      reconcileOperations([local], { fetcher }, new AbortController().signal),
    ).rejects.toThrow("lookup mismatch");
    await expect(
      reconcileOperations(
        [],
        {
          fetcher: async () => ({
            operations: [serverOperation({ status: "running" })],
          }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Invalid operation response");
  });

  test("localStorage cannot restore server authority, result bodies, or external routes", () => {
    const local = beginDurable();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          ...local,
          verification: "server",
          serverResult: { statusCode: 200, body: "forged" },
          verifiedAt: new Date().toISOString(),
        },
        { ...local, id: "unsafe", route: "//outside.example" },
      ]),
    );
    const records = readOperations(KEY);
    expect(records).toHaveLength(1);
    expect(records[0].verification).toBe("unconfirmed");
    expect(records[0].serverResult).toBeUndefined();
    expect(records[0].verifiedAt).toBeUndefined();
  });

  test("aborted reconciliation does not accept even a late successful response", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileOperations(
        [],
        { fetcher: async () => ({ operations: [serverOperation()] }) },
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });
});

describe("operation history hook", () => {
  test("keeps local fallback and new operations when the server is unavailable", async () => {
    beginDurable();
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network error"));
    const { result } = renderHook(() => useOperationJournal(KEY, { fetcher }));
    await waitFor(() => expect(result.current.syncState).toBe("unavailable"));
    expect(result.current.operations).toHaveLength(1);
    act(() => {
      beginOperation(KEY, {
        title: "Export",
        kind: "export",
        route: "/clients",
      });
    });
    await waitFor(() => expect(result.current.operations).toHaveLength(2));
  });

  test("forbidden server history hides durable cached results", async () => {
    beginDurable();
    const fetcher = vi.fn().mockRejectedValue({ status: 403 });
    const { result } = renderHook(() => useOperationJournal(KEY, { fetcher }));
    await waitFor(() => expect(result.current.syncState).toBe("forbidden"));
    expect(result.current.operations).toEqual([]);
  });

  test("account change cancels old reads and ignores a late response", async () => {
    let resolveOld!: (value: unknown) => void;
    let oldSignal!: AbortSignal;
    const fetcher = vi.fn((_path: string, options: { signal: AbortSignal }) => {
      oldSignal = options.signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    });
    const { result, rerender } = renderHook(
      ({ key, client }) => useOperationJournal(key, client),
      {
        initialProps: {
          key: KEY as string | null,
          client: { fetcher } as { fetcher: typeof fetcher } | undefined,
        },
      },
    );
    rerender({ key: "other-account", client: undefined });
    expect(result.current.operations).toEqual([]);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      resolveOld({ operations: [serverOperation()] });
    });
    expect(result.current.operations).toEqual([]);
  });

  test("explicit verification fetches saved detail without persisting the result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ operations: [serverOperation()] })
      .mockResolvedValueOnce(
        serverOperation({
          route: RUN_ROUTE,
          result: { statusCode: 200, body: { rows: ["durable-result"] } },
        }),
      );
    const { result } = renderHook(() => useOperationJournal(KEY, { fetcher }));
    await waitFor(() => expect(result.current.syncState).toBe("synced"));
    await act(async () => {
      await result.current.recover(result.current.operations[0].id);
    });
    expect(result.current.operations[0].serverResult?.body).toEqual({
      rows: ["durable-result"],
    });
    expect(result.current.operations[0].route).toBe(RUN_ROUTE);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("unsafe detail recovery cannot overwrite the validated run link", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        operations: [serverOperation({ route: RUN_ROUTE })],
      })
      .mockResolvedValueOnce(
        serverOperation({
          route: RUN_ROUTE + "&redirect=/console",
          result: { statusCode: 200, body: {} },
        }),
      );
    const { result } = renderHook(() => useOperationJournal(KEY, { fetcher }));
    await waitFor(() => expect(result.current.syncState).toBe("synced"));
    await act(async () => {
      await expect(
        result.current.recover(result.current.operations[0].id),
      ).rejects.toThrow("Invalid operation response");
    });
    expect(result.current.operations[0].route).toBe(RUN_ROUTE);
    expect(result.current.operations[0].serverResult).toBeUndefined();
  });

  test("dismissing server records hides them without deleting server history", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ operations: [serverOperation()] });
    const { result } = renderHook(() => useOperationJournal(KEY, { fetcher }));
    await waitFor(() => expect(result.current.operations).toHaveLength(1));
    act(() => {
      result.current.dismiss(result.current.operations[0].id);
    });
    await waitFor(() => expect(result.current.operations).toEqual([]));
    expect(
      fetcher.mock.calls.every(([path]) => path.startsWith("/api/operations?")),
    ).toBe(true);
  });
});

describe("operation journal", () => {
  test("records and completes an operation", () => {
    const started = beginOperation(KEY, {
      title: "Invoice import",
      kind: "import",
      route: "/import",
      detail: "12 rows",
    });
    expect(started?.status).toBe("running");
    updateOperation(KEY, started?.id, {
      status: "succeeded",
      savedSummary: "12 drafts created.",
    });
    expect(readOperations(KEY)[0].savedSummary).toBe("12 drafts created.");
    clearCompletedOperations(KEY);
    expect(readOperations(KEY)).toEqual([]);
  });

  test("keeps failures until explicitly dismissed", () => {
    const started = beginOperation(KEY, {
      title: "Client export",
      kind: "export",
      route: "/clients/a",
    });
    updateOperation(KEY, started?.id, {
      status: "failed",
      savedSummary: "No file was saved.",
    });
    clearCompletedOperations(KEY);
    expect(readOperations(KEY)).toHaveLength(1);
    dismissOperation(KEY, started!.id);
    expect(readOperations(KEY)).toEqual([]);
  });

  test("turns an abandoned running record into a review state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    beginOperation(KEY, {
      title: "Stamp invoice",
      kind: "submission",
      route: "/invoices/a",
    });
    vi.setSystemTime(new Date("2026-08-28T11:00:00Z"));
    expect(readOperations(KEY)[0].status).toBe("partial");
  });
});
