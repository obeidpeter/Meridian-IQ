// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  InvoiceImportResult,
  InvoiceImportRow,
} from "@workspace/api-client-react";
import { canonicalPayloadHash } from "./idempotent-command";
import {
  executeImportRun,
  newImportRun,
  readImportRun,
  saveImportRun,
} from "./invoice-import-run";
import type {
  ImportRunApi,
  ImportRunDetail,
  ImportRunManifest,
} from "./invoice-import-run-api";

const rows = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        rowNumber: index + 1,
        invoiceNumber: `INV-${index}`,
        buyerName: "Buyer",
        buyerTin: "TIN",
        issueDate: "2026-09-04",
        description: "Advisory",
        quantity: "1",
        unitPrice: "100",
        vatRate: "0",
      }) as InvoiceImportRow,
  );
function server() {
  let remote: ImportRunDetail;
  const api: ImportRunApi = {
    create: vi.fn(async (manifest: ImportRunManifest) => {
      remote ??= {
        ...manifest,
        manifestHash: await canonicalPayloadHash(manifest),
        nextChunkIndex: 0,
        status: "open",
        committedRows: 0,
        createdCount: 0,
        invalidCount: 0,
        chunks: [],
        result: null,
        createdAt: "",
        updatedAt: "",
        finalizedAt: null,
      };
      return structuredClone(remote);
    }),
    get: vi.fn(async () => structuredClone(remote)),
    commit: vi.fn(async (id, index, chunk, key) => {
      expect(key).toBe(`${id}:${index}`);
      expect(index).toBe(remote.nextChunkIndex);
      const result: InvoiceImportResult = {
        total: chunk.length,
        validCount: chunk.length,
        invalidCount: 0,
        createdCount: chunk.length,
        committed: true,
        rows: chunk.map((row) => ({
          rowNumber: row.rowNumber,
          invoiceNumber: row.invoiceNumber,
          status: "created",
          invoiceId: `invoice-${row.rowNumber}`,
          errors: [],
        })),
      };
      remote.nextChunkIndex++;
      remote.committedRows += chunk.length;
      remote.createdCount += chunk.length;
      remote.chunks.push({
        chunkIndex: index,
        operationId: `op-${index}`,
        rowCount: chunk.length,
        result,
      });
      return {
        runId: id,
        chunkIndex: index,
        nextChunkIndex: remote.nextChunkIndex,
        result,
      };
    }),
    finalize: vi.fn(async () => {
      remote.status = "completed";
      remote.result = {
        total: remote.totalRows,
        validCount: remote.totalRows,
        invalidCount: 0,
        createdCount: remote.totalRows,
        committed: true,
        rows: remote.chunks.flatMap((chunk) => chunk.result.rows),
      };
      return structuredClone(remote);
    }),
  };
  return api;
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resumable import manifests", () => {
  test.each(["create", "initial get", "commit", "checkpoint get", "finalize"])(
    "invalidation after %s stops every later import boundary",
    async (boundary) => {
      const api = server();
      const run = await newImportRun("scope", "client", rows(1));
      let current = true;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      let gets = 0;
      for (const name of ["create", "get", "commit", "finalize"] as const) {
        const original = api[name] as (...args: unknown[]) => Promise<unknown>;
        (api as unknown as Record<string, unknown>)[name] = async (
          ...args: unknown[]
        ) => {
          const step =
            name === "get"
              ? ++gets === 1
                ? "initial get"
                : "checkpoint get"
              : name;
          calls.push(step);
          const result = await original(...args);
          if (step === boundary) {
            entered();
            await barrier;
          }
          return result;
        };
      }
      const progress = vi.fn();
      const running = executeImportRun(run, api, progress, {
        check() {
          if (!current) throw new DOMException("inactive", "AbortError");
        },
      });
      const rejected = expect(running).rejects.toThrow("inactive");
      await ready;
      const priorCalls = [...calls],
        priorProgress = progress.mock.calls.length;
      current = false;
      release();
      await rejected;
      expect(calls).toEqual(priorCalls);
      expect(progress).toHaveBeenCalledTimes(priorProgress);
    },
  );

  test("invalidation while integrity hashing prevents manifest dispatch", async () => {
    const api = server(),
      run = await newImportRun("scope", "client", rows(1));
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    vi.spyOn(webcrypto.subtle, "digest").mockImplementationOnce(
      async (...args) => {
        await barrier;
        return digest(...args);
      },
    );
    const running = executeImportRun(run, api, undefined, {
      check() {
        if (!current) throw new DOMException("inactive", "AbortError");
      },
    });
    const rejected = expect(running).rejects.toThrow("inactive");
    current = false;
    release();
    await rejected;
    expect(api.create).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });
  test("canonical hash matches the server's UTF-8 sorted-key JSON algorithm", async () => {
    const payload = { z: undefined, b: [{ z: 2, a: "NGN" }], a: 1 };
    const expected = createHash("sha256")
      .update('{"a":1,"b":[{"a":"NGN","z":2}]}')
      .digest("hex");
    expect(await canonicalPayloadHash(payload)).toBe(expected);
  });
  test("two intentional identical imports get distinct run IDs and equal content hashes", async () => {
    const first = await newImportRun("scope", "client", rows(1));
    const second = await newImportRun("scope", "client", rows(1));
    expect(first.id).not.toBe(second.id);
    expect(first.manifest.chunkHashes).toEqual(second.manifest.chunkHashes);
  });
  test("persists intent and source rows before dispatch, isolated by scope", async () => {
    const run = await newImportRun("firm:user:client", "client", rows(101));
    expect(saveImportRun(run)).toBe(true);
    expect(readImportRun(run.scope)).toEqual(run);
    expect(readImportRun("firm:other:client")).toBeNull();
  });
  test("chunks 201 rows into 100,100,1 and retains original row numbers", async () => {
    const api = server(),
      run = await newImportRun("scope", "client", rows(201));
    const result = await executeImportRun(run, api);
    expect(
      vi.mocked(api.commit).mock.calls.map((call) => call[2].length),
    ).toEqual([100, 100, 1]);
    expect(result.rows.map((row) => row.rowNumber)).toEqual(
      Array.from({ length: 201 }, (_, i) => i + 1),
    );
    expect(result.createdCount).toBe(201);
    expect(api.finalize).toHaveBeenCalledOnce();
  });
  test("refresh after a lost response reads the server checkpoint and skips the committed chunk", async () => {
    const api = server(),
      run = await newImportRun("scope", "client", rows(201));
    saveImportRun({ ...run, started: true });
    const commit = api.commit;
    let lose = true;
    api.commit = vi.fn(async (...args) => {
      const result = await commit(...args);
      if (lose) {
        lose = false;
        throw new Error("response lost");
      }
      return result;
    });
    await expect(executeImportRun(run, api)).rejects.toThrow("response lost");
    const recovered = readImportRun("scope")!;
    const result = await executeImportRun(recovered, api);
    expect(vi.mocked(api.commit).mock.calls.map((call) => call[1])).toEqual([
      0, 1, 2,
    ]);
    expect(result.createdCount).toBe(201);
    await executeImportRun(recovered, api);
    expect(api.commit).toHaveBeenCalledTimes(3);
  });
  test("a modified recovery cannot reuse an existing manifest or key", async () => {
    const api = server(),
      run = await newImportRun("scope", "client", rows(1));
    run.rows[0].invoiceNumber = "changed";
    await expect(executeImportRun(run, api)).rejects.toThrow(
      "saved import changed",
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });
  test("storage failures are reported instead of claiming resumable device state", async () => {
    const run = await newImportRun("scope", "client", rows(1));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(saveImportRun(run)).toBe(false);
  });
});
