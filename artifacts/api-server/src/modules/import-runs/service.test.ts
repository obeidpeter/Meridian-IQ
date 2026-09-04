import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { getDb, pool, runRequestContext } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migration0051 } from "../../../../../lib/db/src/migrations/0051_operation_recovery.ts";
import { migration0054 } from "../../../../../lib/db/src/migrations/0054_import_runs.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  importInvoices,
  type ImportRow,
  type ImportResult,
} from "../invoice/import.ts";
import { operationPayloadHash } from "../operations/command.ts";
import {
  executeOperation,
  listOperations,
  recoverOperation,
} from "../operations/service.ts";
import {
  createImportRun,
  executeImportRunChunk,
  finalizeImportRun,
  getImportRun,
} from "./service.ts";

const principal: Principal = {
  userId: randomUUID(),
  firmId: randomUUID(),
  clientPartyId: randomUUID(),
  buyerPartyId: null,
  role: "client_user",
};
const inTenant = <T>(fn: () => Promise<T>, owner = principal) =>
  runRequestContext({ bypass: false, firmId: owner.firmId }, fn);
const rejected = (rows: ImportRow[]): ImportResult => ({
  total: rows.length,
  validCount: 0,
  createdCount: 0,
  invalidCount: rows.length,
  committed: true,
  rows: rows.map((row) => ({
    rowNumber: row.rowNumber,
    status: "invalid",
    invoiceId: null,
    invoiceNumber: row.invoiceNumber ?? null,
    errors: [{ field: "row", message: "Fixture rejection" }],
  })),
});
const rejectImporter: typeof importInvoices = async (_firm, _client, rows) =>
  rejected(rows);

async function makeRun(total = 3, chunkSize = 2) {
  const id = randomUUID();
  const rows: ImportRow[] = Array.from({ length: total }, (_, i) => ({
    rowNumber: i + 1,
    invoiceNumber: `${id}-${i + 1}`,
    buyerName: "Import run buyer",
    buyerTin: `TIN-${id}`,
    issueDate: "2026-09-04",
    description: "Run test",
    quantity: "1",
    unitPrice: "100",
    vatRate: "0",
  }));
  const chunks = Array.from(
    { length: Math.ceil(total / chunkSize) },
    (_, index) => rows.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const manifest = {
    id,
    clientPartyId: principal.clientPartyId!,
    totalRows: total,
    chunkSize,
    chunkHashes: chunks.map(operationPayloadHash),
  };
  await inTenant(() => createImportRun(principal, manifest));
  return { id, rows, chunks, manifest };
}

describe(
  "resumable import PostgreSQL checkpoints",
  { skip: !process.env.DATABASE_URL, timeout: 60_000 },
  () => {
    before(async () => {
      await pool.query(migration0051.up);
      await pool.query(migration0054.up);
      await pool.query(migration0054.up);
      await pool.query(
        "INSERT INTO firms (id, name) VALUES ($1, 'Import run tests')",
        [principal.firmId],
      );
      await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
        principal.userId,
        `${principal.userId}@test.example`,
      ]);
      await pool.query(
        "INSERT INTO parties (id, type, legal_name) VALUES ($1, 'client_business', 'Run supplier')",
        [principal.clientPartyId],
      );
      await pool.query(
        "INSERT INTO engagements (firm_id, client_party_id, type, title) VALUES ($1, $2, 'retainer', 'Run engagement')",
        [principal.firmId, principal.clientPartyId],
      );
    });
    after(async () => {
      await pool.end();
    });

    test("run creation retries preserve the manifest and reject edits", async () => {
      const run = await makeRun();
      const replay = await inTenant(() =>
        createImportRun(principal, run.manifest),
      );
      assert.equal(replay.created, false);
      assert.equal(replay.run.id, run.id);
      await assert.rejects(
        inTenant(() =>
          createImportRun(principal, {
            ...run.manifest,
            chunkHashes: [...run.manifest.chunkHashes].reverse(),
          }),
        ),
        { code: "IMPORT_MANIFEST_CONFLICT" },
      );
    });

    test("response-loss replay and resume preserve one invoice per row", async () => {
      const run = await makeRun();
      const first = await inTenant(() =>
        executeImportRunChunk(principal, run.id, 0, run.chunks[0]),
      );
      const replay = await inTenant(() =>
        executeImportRunChunk(principal, run.id, 0, run.chunks[0]),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.body, first.body);
      const saved = await inTenant(() => getImportRun(principal, run.id));
      assert.equal(saved.nextChunkIndex, 1);
      assert.equal(saved.committedRows, 2);
      await inTenant(() =>
        executeImportRunChunk(
          principal,
          run.id,
          saved.nextChunkIndex,
          run.chunks[1],
        ),
      );
      const ready = await inTenant(() => getImportRun(principal, run.id));
      assert.equal(ready.status, "ready");
      assert.equal(ready.createdCount, 3);
      const done = await inTenant(() => finalizeImportRun(principal, run.id));
      assert.equal(done.status, "completed");
      assert.equal(done.result?.total, 3);
      assert.deepEqual(
        done.result?.rows.map((row) => row.rowNumber),
        [1, 2, 3],
      );
      const finalizedAgain = await inTenant(() =>
        finalizeImportRun(principal, run.id),
      );
      assert.deepEqual(finalizedAgain, done);
      const afterFinalize = await inTenant(() =>
        executeImportRunChunk(principal, run.id, 0, run.chunks[0]),
      );
      assert.equal(afterFinalize.body, first.body);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM invoices WHERE firm_id = $1 AND invoice_number LIKE $2",
            [principal.firmId, `${run.id}-%`],
          )
        ).rows[0].n,
        3,
      );
    });

    test("concurrent duplicate chunks call the importer once and advance once", async () => {
      const run = await makeRun(2);
      let calls = 0;
      const importer: typeof importInvoices = async (_firm, _client, rows) => {
        calls++;
        return rejected(rows);
      };
      const [a, b] = await Promise.all(
        [1, 2].map(() =>
          inTenant(() =>
            executeImportRunChunk(
              principal,
              run.id,
              0,
              run.chunks[0],
              importer,
            ),
          ),
        ),
      );
      assert.equal(calls, 1);
      assert.equal(a.body, b.body);
      assert.equal(Number(a.replayed) + Number(b.replayed), 1);
      const checkpoint = await inTenant(() => getImportRun(principal, run.id));
      assert.equal(checkpoint.nextChunkIndex, 1);
      assert.equal(checkpoint.chunks.length, 1);
    });

    test("a fresh device discovers the authoritative run route from committed chunk references", async () => {
      const run = await makeRun(1, 1);
      const chunk = await inTenant(() =>
        executeImportRunChunk(
          principal,
          run.id,
          0,
          run.chunks[0],
          rejectImporter,
        ),
      );
      // A new caller has no local journal, so the list alone must recover the run.
      const device = { ...principal };
      const listed = await inTenant(() => listOperations(device));
      assert.equal(
        listed.operations.find(
          (operation) => operation.id === chunk.operationId,
        )?.route,
        `/import?run=${run.id}`,
      );
      for (const selector of [
        { id: chunk.operationId },
        { command: "invoice.import" as const, idempotencyKey: `${run.id}:0` },
      ]) {
        const recovered = await inTenant(() =>
          recoverOperation(device, selector),
        );
        assert.equal(recovered.route, `/import?run=${run.id}`);
      }
      await inTenant(() => finalizeImportRun(principal, run.id));
      assert.equal(
        (
          await inTenant(() =>
            recoverOperation(device, { id: chunk.operationId }),
          )
        ).route,
        `/import?run=${run.id}`,
      );
    });

    test("legacy import keys and run-shaped saved results cannot manufacture a run route", async () => {
      const run = await makeRun(1, 1);
      const key = `${run.id}:99`;
      const legacy = await inTenant(() =>
        executeOperation({
          principal,
          command: "invoice.import",
          idempotencyKey: key,
          clientPartyId: principal.clientPartyId!,
          payload: { rows: [], commit: true },
          execute: async () => ({
            statusCode: 200,
            body: { runId: run.id, chunkIndex: 99, result: rejected([]) },
          }),
        }),
      );
      assert.equal(
        (await inTenant(() => listOperations(principal))).operations.find(
          (operation) => operation.id === legacy.operationId,
        )?.route,
        "/import",
      );
      assert.equal(
        (
          await inTenant(() =>
            recoverOperation(principal, { id: legacy.operationId }),
          )
        ).route,
        "/import",
      );
      assert.equal(
        (
          await inTenant(() =>
            recoverOperation(principal, {
              command: "invoice.import",
              idempotencyKey: key,
            }),
          )
        ).route,
        "/import",
      );
    });

    test("run-history URLs never disclose another actor, client or tenant's run", async () => {
      const run = await makeRun(1, 1);
      const chunk = await inTenant(() =>
        executeImportRunChunk(
          principal,
          run.id,
          0,
          run.chunks[0],
          rejectImporter,
        ),
      );
      for (const owner of [
        { ...principal, userId: randomUUID() },
        { ...principal, clientPartyId: randomUUID() },
        { ...principal, firmId: randomUUID() },
      ]) {
        const history = await inTenant(() => listOperations(owner), owner);
        assert.ok(
          history.operations.every(
            (operation) =>
              operation.id !== chunk.operationId &&
              operation.route !== `/import?run=${run.id}`,
          ),
        );
        await assert.rejects(
          inTenant(
            () => recoverOperation(owner, { id: chunk.operationId }),
            owner,
          ),
          { status: 404 },
        );
        await assert.rejects(
          inTenant(
            () =>
              recoverOperation(owner, {
                command: "invoice.import",
                idempotencyKey: `${run.id}:0`,
              }),
            owner,
          ),
          { status: 404 },
        );
      }
    });

    test("outer rollback leaves the last committed checkpoint intact", async () => {
      const run = await makeRun();
      await inTenant(() =>
        executeImportRunChunk(
          principal,
          run.id,
          0,
          run.chunks[0],
          rejectImporter,
        ),
      );
      await assert.rejects(
        inTenant(async () => {
          await executeImportRunChunk(
            principal,
            run.id,
            1,
            run.chunks[1],
            rejectImporter,
          );
          throw new Error("lost transaction");
        }),
        /lost transaction/,
      );
      const checkpoint = await inTenant(() => getImportRun(principal, run.id));
      assert.equal(checkpoint.nextChunkIndex, 1);
      assert.equal(checkpoint.chunks.length, 1);
      const retried = await inTenant(() =>
        executeImportRunChunk(
          principal,
          run.id,
          1,
          run.chunks[1],
          rejectImporter,
        ),
      );
      assert.equal(retried.replayed, false);
      const done = await inTenant(() => finalizeImportRun(principal, run.id));
      assert.equal(done.result?.invalidCount, 3);
    });

    test("SQL failure rolls back its chunk and allows safe retry", async () => {
      const run = await makeRun(1, 1);
      const fail: typeof importInvoices = async () => {
        await getDb().execute(sql`SELECT 1 / 0`);
        throw new Error("unreachable");
      };
      await assert.rejects(
        inTenant(() =>
          executeImportRunChunk(principal, run.id, 0, run.chunks[0], fail),
        ),
      );
      assert.equal(
        (await inTenant(() => getImportRun(principal, run.id))).nextChunkIndex,
        0,
      );
      assert.equal(
        (
          await inTenant(() =>
            executeImportRunChunk(
              principal,
              run.id,
              0,
              run.chunks[0],
              rejectImporter,
            ),
          )
        ).replayed,
        false,
      );
    });

    test("future, changed, overlapping, and incomplete chunks cannot advance", async () => {
      const run = await makeRun();
      await assert.rejects(
        inTenant(() =>
          executeImportRunChunk(
            principal,
            run.id,
            1,
            run.chunks[1],
            rejectImporter,
          ),
        ),
        { code: "IMPORT_CHECKPOINT_CONFLICT" },
      );
      await assert.rejects(
        inTenant(() =>
          executeImportRunChunk(
            principal,
            run.id,
            0,
            [
              { ...run.chunks[0][0], invoiceNumber: "changed" },
              run.chunks[0][1],
            ],
            rejectImporter,
          ),
        ),
        { code: "IMPORT_CHUNK_CONFLICT" },
      );
      await assert.rejects(
        inTenant(() =>
          executeImportRunChunk(
            principal,
            run.id,
            0,
            [run.chunks[0][0], run.chunks[0][0]],
            rejectImporter,
          ),
        ),
        { code: "INVALID_CHUNK_ROWS" },
      );
      await assert.rejects(
        inTenant(() => finalizeImportRun(principal, run.id)),
        { code: "IMPORT_INCOMPLETE" },
      );
      assert.equal(
        (await inTenant(() => getImportRun(principal, run.id))).nextChunkIndex,
        0,
      );
    });

    test("own-authorized run results never disclose other clients, actors or tenants", async () => {
      const run = await makeRun();
      for (const owner of [
        { ...principal, userId: randomUUID() },
        { ...principal, firmId: randomUUID() },
        { ...principal, clientPartyId: randomUUID() },
      ]) {
        await assert.rejects(
          inTenant(() => getImportRun(owner, run.id), owner),
          { status: 404 },
        );
        await assert.rejects(
          inTenant(
            () =>
              executeImportRunChunk(
                owner,
                run.id,
                0,
                run.chunks[0],
                rejectImporter,
              ),
            owner,
          ),
          { status: 404 },
        );
      }
    });

    test("the database rejects a checkpoint without its committed chunk", async () => {
      const run = await makeRun();
      await assert.rejects(
        inTenant(async () => {
          await getImportRun(principal, run.id);
          await getDb().execute(
            sql`UPDATE import_runs SET next_chunk_index = 1 WHERE id = ${run.id}::uuid`,
          );
        }),
      );
      assert.equal(
        (await inTenant(() => getImportRun(principal, run.id))).nextChunkIndex,
        0,
      );
      await assert.rejects(
        pool.query(
          "UPDATE import_runs SET chunk_size = 1 WHERE firm_id = $1 AND actor_id = $2 AND id = $3",
          [principal.firmId, principal.userId, run.id],
        ),
      );
    });
  },
);
