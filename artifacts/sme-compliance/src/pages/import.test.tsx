/// <reference types="node" />
// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderWithClient } from "../test-utils";
import type {
  ImportRunDetail,
  ImportRunManifest,
  InvoiceImportRow,
  InvoiceImportResult,
} from "@workspace/api-client-react";
import { canonicalPayloadHash } from "@/lib/idempotent-command";

const harness = vi.hoisted(() => ({
  runs: new Map<string, ImportRunDetail>(),
  commits: [] as number[],
  loseFirst: false,
  firstChunkCommitted: undefined as (() => void) | undefined,
  releaseLostResponse: undefined as Promise<void> | undefined,
  finalized: undefined as (() => void) | undefined,
  generation: 0,
  ending: false,
  userId: "00000000-0000-4000-8000-000000000001",
  listeners: new Set<() => void>(),
  toast: vi.fn(),
  requests: [] as string[],
  signals: [] as AbortSignal[],
  hashCount: 0,
  stopOnHash: 0,
  hashGate: undefined as Promise<void> | undefined,
  hashEntered: undefined as (() => void) | undefined,
  chunkGate: undefined as Promise<void> | undefined,
  chunkEntered: undefined as (() => void) | undefined,
}));
const resultFor = (
  rows: InvoiceImportRow[],
  committed: boolean,
): InvoiceImportResult => ({
  total: rows.length,
  validCount: rows.length,
  invalidCount: 0,
  createdCount: committed ? rows.length : 0,
  committed,
  rows: rows.map((row) => ({
    rowNumber: row.rowNumber,
    invoiceNumber: row.invoiceNumber,
    status: committed ? "created" : "valid",
    invoiceId: committed ? `invoice-${row.rowNumber}` : undefined,
    errors: [],
  })),
});
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({
    data: {
      userId: harness.userId,
      firmId: "00000000-0000-4000-8000-000000000002",
      clientPartyId: "00000000-0000-4000-8000-000000000003",
      role: "client_user",
      features: [],
    },
  }),
  importInvoices: async (data: { rows: InvoiceImportRow[] }) => {
    harness.requests.push("validate");
    return resultFor(data.rows, false);
  },
}));
vi.mock("@workspace/web-ui", async (original) => {
  const actual = await original<typeof import("@workspace/web-ui")>();
  return {
    ...actual,
    beginOperation: vi.fn(actual.beginOperation),
    updateOperation: vi.fn(actual.updateOperation),
    webSession: {
      getGeneration: () => harness.generation,
      isEnding: () => harness.ending,
      subscribe: (listener: () => void) => {
        harness.listeners.add(listener);
        return () => harness.listeners.delete(listener);
      },
    },
  };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));
vi.mock("@/lib/idempotent-command", async (original) => {
  const actual = await original<typeof import("@/lib/idempotent-command")>();
  return {
    ...actual,
    stableCommandKey: async (
      ...args: Parameters<typeof actual.stableCommandKey>
    ) => {
      const hash = await actual.stableCommandKey(...args);
      if (++harness.hashCount === harness.stopOnHash) {
        harness.hashEntered?.();
        await harness.hashGate;
      }
      return hash;
    },
  };
});
vi.mock("@/lib/invoice-import-run-api", () => ({
  invoiceImportRunApi: (signal?: AbortSignal) => {
    if (signal) harness.signals.push(signal);
    return {
      create: async (manifest: ImportRunManifest) => {
        harness.requests.push("create");
        if (!harness.runs.has(manifest.id))
          harness.runs.set(manifest.id, {
            ...manifest,
            manifestHash: await canonicalPayloadHash(manifest),
            nextChunkIndex: 0,
            status: "open",
            committedRows: 0,
            createdCount: 0,
            invalidCount: 0,
            createdAt: "",
            updatedAt: "",
            finalizedAt: null,
            chunks: [],
            result: null,
          });
        return structuredClone(harness.runs.get(manifest.id)!);
      },
      get: async (id: string) => {
        harness.requests.push("get");
        const run = harness.runs.get(id);
        if (!run)
          throw Object.assign(new Error("Import run not found"), {
            status: 404,
          });
        return structuredClone(run);
      },
      commit: async (
        id: string,
        index: number,
        rows: InvoiceImportRow[],
        key: string,
      ) => {
        expect(key).toBe(`${id}:${index}`);
        harness.commits.push(index);
        harness.requests.push(`commit:${index}`);
        const run = harness.runs.get(id)!;
        const result = resultFor(rows, true);
        run.nextChunkIndex = index + 1;
        run.committedRows += rows.length;
        run.createdCount += rows.length;
        run.chunks.push({
          chunkIndex: index,
          rowCount: rows.length,
          result,
          operationId: `operation-${index}`,
        });
        if (harness.loseFirst) {
          harness.loseFirst = false;
          harness.firstChunkCommitted?.();
          await harness.releaseLostResponse;
          throw new Error("response lost");
        }
        harness.chunkEntered?.();
        await harness.chunkGate;
        return {
          runId: id,
          chunkIndex: index,
          nextChunkIndex: index + 1,
          result,
        };
      },
      finalize: async (id: string) => {
        harness.requests.push("finalize");
        const run = harness.runs.get(id)!;
        run.status = "completed";
        run.result = {
          total: run.totalRows,
          validCount: run.totalRows,
          invalidCount: 0,
          createdCount: run.createdCount,
          committed: true,
          rows: run.chunks.flatMap((chunk) => chunk.result.rows),
        };
        harness.finalized?.();
        return structuredClone(run);
      },
    };
  },
}));
import { Import } from "./import";
import { beginOperation, updateOperation } from "@workspace/web-ui";

const csv = (count: number) =>
  "invoiceNumber,buyerName,buyerTin,issueDate,description,quantity,unitPrice,vatRate\n" +
  Array.from(
    { length: count },
    (_, index) =>
      `INV-${index},Buyer,12345678-0001,2026-09-04,Advisory,1,100,0`,
  ).join("\n");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  harness.runs.clear();
  harness.commits = [];
  harness.loseFirst = false;
  harness.firstChunkCommitted = undefined;
  harness.releaseLostResponse = undefined;
  harness.finalized = undefined;
  harness.generation = 0;
  harness.ending = false;
  harness.userId = "00000000-0000-4000-8000-000000000001";
  harness.listeners.clear();
  harness.toast.mockClear();
  harness.requests = [];
  harness.signals = [];
  harness.hashCount = 0;
  harness.stopOnHash = 0;
  harness.hashGate = undefined;
  harness.hashEntered = undefined;
  harness.chunkGate = undefined;
  harness.chunkEntered = undefined;
  vi.mocked(beginOperation).mockClear();
  vi.mocked(updateOperation).mockClear();
  window.history.replaceState(null, "", "/import");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function validate(count: number) {
  await waitFor(() =>
    expect(
      (screen.getByTestId("input-csv") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByTestId("input-csv"), {
    target: { value: csv(count) },
  });
  fireEvent.click(screen.getByTestId("button-validate"));
  await waitFor(() =>
    expect(
      (screen.getByTestId("button-commit") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
test("New import creates a new intentional run for identical rows", async () => {
  renderWithClient(<Import />);
  await validate(1);
  fireEvent.click(screen.getByTestId("button-commit"));
  await screen.findByText("Created: 1");
  const first = [...harness.runs.keys()][0];
  fireEvent.click(screen.getByRole("button", { name: "New import" }));
  await validate(1);
  fireEvent.click(screen.getByTestId("button-commit"));
  await waitFor(() => expect(harness.runs.size).toBe(2));
  await screen.findByText("Created: 1");
  expect([...harness.runs.keys()][1]).not.toBe(first);
});
test("refresh restores the active run and resumes after an already committed lost response", async () => {
  harness.loseFirst = true;
  const committed = new Promise<void>((resolve) => {
    harness.firstChunkCommitted = resolve;
  });
  let loseResponse!: () => void;
  harness.releaseLostResponse = new Promise<void>((resolve) => {
    loseResponse = resolve;
  });
  const finalized = new Promise<void>((resolve) => {
    harness.finalized = resolve;
  });
  const firstRender = renderWithClient(<Import />);
  await validate(201);
  // Wait for the durable checkpoint, not for hashing to beat a one-second DOM timeout.
  await act(async () => {
    fireEvent.click(screen.getByTestId("button-commit"));
    await committed;
  });
  expect(harness.commits).toEqual([0]);
  expect(
    (screen.getByTestId("button-commit") as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => loseResponse());
  await screen.findByRole("button", { name: "Resume this import" });
  expect(harness.commits).toEqual([0]);
  firstRender.unmount();
  renderWithClient(<Import />);
  const resume = await screen.findByRole("button", {
    name: "Resume this import",
  });
  await act(async () => {
    fireEvent.click(resume);
    await finalized;
  });
  expect(screen.getByText("Created: 201")).toBeTruthy();
  expect(harness.commits).toEqual([0, 1, 2]);
  const journal = Object.keys(localStorage).find((key) =>
    key.startsWith("meridianiq:operations:"),
  )!;
  const entries = JSON.parse(localStorage.getItem(journal)!) as {
    command?: string;
    idempotencyKey?: string;
  }[];
  expect(
    entries
      .filter((entry) => entry.command === "invoice.import")
      .every((entry) =>
        entry.idempotencyKey?.startsWith([...harness.runs.keys()][0]),
      ),
  ).toBe(true);
});

test("a validated local preview remains editable after refresh without a server manifest", async () => {
  const firstRender = renderWithClient(<Import />);
  await validate(1);
  const id = new URLSearchParams(window.location.search).get("run");
  expect(id).toBeTruthy();
  expect(harness.runs.size).toBe(0);
  firstRender.unmount();
  renderWithClient(<Import />);
  await validate(2);
  expect(new URLSearchParams(window.location.search).get("run")).toBe(id);
  expect(harness.runs.size).toBe(0);
  fireEvent.click(screen.getByTestId("button-commit"));
  await screen.findByText("Created: 2");
  expect([...harness.runs.keys()]).toEqual([id]);
});

test.each([
  ["hash", "logout"],
  ["hash", "switch"],
  ["hash", "unmount"],
  ["startup", "logout"],
  ["startup", "switch"],
  ["startup", "unmount"],
  ["chunk", "logout"],
  ["chunk", "switch"],
  ["chunk", "unmount"],
] as const)(
  "%s suspended then %s cannot continue the old import",
  async (stage, boundary) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let suspendStartup = false;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      mutationCache: new MutationCache({
        onMutate: async () => {
          if (suspendStartup) {
            entered();
            await gate;
          }
        },
      }),
    });
    if (stage === "hash") {
      // A second device has the run link and file, but no local manifest.
      window.history.replaceState(
        null,
        "",
        "/import?run=00000000-0000-4000-8000-000000000009",
      );
      harness.stopOnHash = 2;
      harness.hashEntered = entered;
      harness.hashGate = gate;
    }
    const view = render(<Import />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    if (stage === "hash") {
      await waitFor(() =>
        expect(
          (screen.getByTestId("input-csv") as HTMLTextAreaElement).disabled,
        ).toBe(false),
      );
      fireEvent.change(screen.getByTestId("input-csv"), {
        target: { value: csv(201) },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("button-validate"));
        await started;
      });
      expect(harness.requests).toEqual([]);
    } else {
      await validate(201);
      suspendStartup = stage === "startup";
      if (stage === "chunk") {
        harness.chunkEntered = entered;
        harness.chunkGate = gate;
      }
      await act(async () => {
        fireEvent.click(screen.getByTestId("button-commit"));
        await started;
      });
    }
    const oldSignals = [...harness.signals];
    act(() => {
      if (boundary === "unmount") view.unmount();
      else if (boundary === "switch") {
        harness.userId = "00000000-0000-4000-8000-000000000004";
        view.rerender(<Import />);
      } else {
        harness.ending = true;
        harness.generation++;
        harness.listeners.forEach((listener) => listener());
      }
    });
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    const requests = [...harness.requests];
    const url = window.location.href;
    localStorage.clear();
    harness.toast.mockClear();
    vi.mocked(beginOperation).mockClear();
    vi.mocked(updateOperation).mockClear();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    try {
      await act(async () => release());
      expect(harness.requests).toEqual(requests);
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
      expect(updateOperation).not.toHaveBeenCalled();
      expect(harness.toast).not.toHaveBeenCalled();
      expect(window.location.href).toBe(url);
    } finally {
      writes.mockRestore();
      removals.mockRestore();
    }
  },
);
