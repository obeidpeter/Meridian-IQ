import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { operationPayloadHash } from "../operations/command.ts";
import {
  aggregateChunkResults,
  assertCommittedChunkResult,
  assertManifestChunk,
  ImportRunChunkBody,
  ImportRunManifestBody,
  manifestHash,
} from "./manifest.ts";

const rows = [
  { rowNumber: 1, invoiceNumber: "A" },
  { rowNumber: 2, invoiceNumber: "B" },
];
const manifest = {
  id: randomUUID(),
  clientPartyId: randomUUID(),
  totalRows: 2,
  chunkSize: 2,
  chunkHashes: [operationPayloadHash(rows)],
};

test("manifest enforces max5000, bounded chunks and exact hash count", () => {
  assert.equal(ImportRunManifestBody.safeParse(manifest).success, true);
  for (const patch of [
    { totalRows: 5001 },
    { totalRows: 0 },
    { chunkSize: 0 },
    { chunkSize: 251 },
    { chunkHashes: [] },
    { chunkHashes: ["not-a-hash"] },
    { chunkHashes: [manifest.chunkHashes[0], manifest.chunkHashes[0]] },
  ]) {
    assert.equal(
      ImportRunManifestBody.safeParse({ ...manifest, ...patch }).success,
      false,
    );
  }
  assert.equal(
    ImportRunManifestBody.safeParse({
      ...manifest,
      totalRows: 5000,
      chunkSize: 250,
      chunkHashes: Array(20).fill(manifest.chunkHashes[0]),
    }).success,
    true,
  );
});

test("manifest identity binds supplier, size and ordered chunk hashes", () => {
  assert.notEqual(
    manifestHash(manifest),
    manifestHash({ ...manifest, clientPartyId: randomUUID() }),
  );
  assert.notEqual(
    manifestHash(manifest),
    manifestHash({ ...manifest, totalRows: 1 }),
  );
  assert.notEqual(
    manifestHash(manifest),
    manifestHash({
      ...manifest,
      chunkHashes: [operationPayloadHash([...rows].reverse())],
    }),
  );
});

test("chunk validator rejects overlaps, holes, wrong order, changed content and extra rows", () => {
  assert.doesNotThrow(() => assertManifestChunk(manifest, 0, rows));
  for (const invalid of [
    rows.slice(0, 1),
    [...rows, { rowNumber: 3 }],
    [rows[0], { ...rows[1], rowNumber: 1 }],
    [...rows].reverse(),
  ]) {
    assert.throws(() => assertManifestChunk(manifest, 0, invalid), {
      code: "INVALID_CHUNK_ROWS",
    });
  }
  for (const index of [-1, 0.5, 1])
    assert.throws(() => assertManifestChunk(manifest, index, rows), {
      code: "INVALID_CHUNK",
    });
  assert.throws(
    () =>
      assertManifestChunk(manifest, 0, [
        { ...rows[0], invoiceNumber: "changed" },
        rows[1],
      ]),
    { code: "IMPORT_CHUNK_CONFLICT" },
  );
  assert.equal(
    ImportRunChunkBody.safeParse({
      rows: [{ rowNumber: 1, unknownField: true }],
    }).success,
    false,
  );
});

test("last chunk accepts exactly its remaining global row range", () => {
  const lastRows = [{ rowNumber: 5, invoiceNumber: "last" }];
  const run = {
    totalRows: 5,
    chunkSize: 2,
    chunkHashes: [
      "a".repeat(64),
      "b".repeat(64),
      operationPayloadHash(lastRows),
    ],
  };
  assert.doesNotThrow(() => assertManifestChunk(run, 2, lastRows));
  assert.throws(
    () => assertManifestChunk(run, 2, [{ ...lastRows[0], rowNumber: 1 }]),
    { code: "INVALID_CHUNK_ROWS" },
  );
});

test("checkpoint results must account for every input row exactly once", () => {
  const result = {
    total: 2,
    validCount: 1,
    invalidCount: 1,
    createdCount: 1,
    committed: true,
    rows: [
      {
        rowNumber: 1,
        status: "created" as const,
        invoiceId: randomUUID(),
        errors: [],
      },
      { rowNumber: 2, status: "invalid" as const, errors: [] },
    ],
  };
  assert.doesNotThrow(() => assertCommittedChunkResult(result, rows));
  for (const patch of [
    { committed: false },
    { createdCount: 2 },
    { rows: [result.rows[0], result.rows[0]] },
    { validCount: 2 },
    { rows: [{ ...result.rows[0], invoiceId: null }, result.rows[1]] },
  ]) {
    assert.throws(
      () => assertCommittedChunkResult({ ...result, ...patch }, rows),
      /inconsistent/,
    );
  }
  const aggregate = aggregateChunkResults([
    result,
    {
      total: 1,
      validCount: 0,
      invalidCount: 1,
      createdCount: 0,
      committed: true,
      rows: [{ rowNumber: 3, status: "invalid", errors: [] }],
    },
  ]);
  assert.equal(aggregate.total, 3);
  assert.equal(aggregate.invalidCount, 2);
  assert.deepEqual(
    aggregate.rows.map((row) => row.rowNumber),
    [1, 2, 3],
  );
});
