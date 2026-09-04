import { sql } from "drizzle-orm";
import { ImportInvoicesResponse } from "@workspace/api-zod";
import { type Database } from "@workspace/db";
import { assertClientPartyScope, type Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { importInvoices } from "../invoice/import";
import { importOperationOutcome } from "../operations/command";
import {
  activeOperationDb,
  authorizedOperationOwner,
  executeOperation,
  operationOwnerTransaction,
} from "../operations/service";
import {
  aggregateChunkResults,
  assertCommittedChunkResult,
  assertManifestChunk,
  ImportRunChunkBody,
  ImportRunChunkResponse,
  ImportRunManifestBody,
  manifestHash,
  type ImportChunkRows,
  type ImportRunManifest,
} from "./manifest";
import { parseOrThrow } from "../../lib/parse";

interface Run extends Record<string, unknown> {
  id: string;
  firm_id: string;
  actor_id: string;
  client_party_id: string;
  manifest_hash: string;
  total_rows: number;
  chunk_size: number;
  chunk_hashes: string[];
  next_chunk_index: number;
  finalized_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function loadRun(
  tx: Database,
  principal: Principal,
  firmId: string,
  id: string,
  write: boolean,
): Promise<Run> {
  const result = await activeOperationDb(tx)
    .execute<Run>(sql`SELECT o.* FROM import_runs o
    WHERE ${authorizedOperationOwner(principal, firmId)} AND o.id = ${id}::uuid
    ${write ? sql`FOR UPDATE OF o` : sql`FOR SHARE OF o`}`);
  const row = result.rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Import run not found", 404);
  return row;
}

async function describeRun(tx: Database, row: Run) {
  const committed = await activeOperationDb(tx).execute<{
    chunk_index: number;
    operation_id: string;
    row_count: number;
    response_body: string;
  }>(sql`
    SELECT c.chunk_index, c.operation_id, c.row_count, op.response_body
    FROM import_run_chunks c JOIN operations op ON op.id = c.operation_id
    WHERE c.firm_id = ${row.firm_id}::uuid AND c.actor_id = ${row.actor_id} AND c.run_id = ${row.id}::uuid
    ORDER BY c.chunk_index ASC
  `);
  const chunks = committed.rows.map((chunk) => {
    const saved = ImportRunChunkResponse.parse(JSON.parse(chunk.response_body));
    if (saved.runId !== row.id || saved.chunkIndex !== chunk.chunk_index)
      throw new Error("Import chunk reference mismatch");
    return {
      chunkIndex: chunk.chunk_index,
      operationId: chunk.operation_id,
      rowCount: chunk.row_count,
      result: saved.result,
    };
  });
  if (chunks.length !== row.next_chunk_index)
    throw new Error("Import checkpoint is inconsistent with saved results");
  const aggregate = aggregateChunkResults(chunks.map((chunk) => chunk.result));
  return {
    id: row.id,
    clientPartyId: row.client_party_id,
    manifestHash: row.manifest_hash,
    totalRows: row.total_rows,
    chunkSize: row.chunk_size,
    chunkHashes: row.chunk_hashes,
    nextChunkIndex: row.next_chunk_index,
    status: row.finalized_at
      ? ("completed" as const)
      : row.next_chunk_index === row.chunk_hashes.length
        ? ("ready" as const)
        : ("open" as const),
    committedRows: aggregate.total,
    createdCount: aggregate.createdCount,
    invalidCount: aggregate.invalidCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finalizedAt: row.finalized_at?.toISOString() ?? null,
    chunks,
    result: row.finalized_at ? aggregate : null,
  };
}

export async function createImportRun(
  principal: Principal,
  body: ImportRunManifest,
) {
  const manifest = parseOrThrow(ImportRunManifestBody, body);
  const hash = manifestHash(manifest);
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.write",
  );
  assertClientPartyScope(principal, manifest.clientPartyId);
  const access = await activeOperationDb(tx)
    .execute(sql`SELECT 1 FROM engagements WHERE firm_id = ${firmId}::uuid
    AND client_party_id = ${manifest.clientPartyId}::uuid AND status <> 'archived' LIMIT 1`);
  if (!access.rows.length)
    throw new DomainError(
      "FORBIDDEN",
      "Client is not authorized for this import",
      403,
    );
  const inserted = await activeOperationDb(tx)
    .execute(sql`INSERT INTO import_runs
    (id, firm_id, actor_id, client_party_id, manifest_hash, total_rows, chunk_size, chunk_hashes)
    VALUES (${manifest.id}::uuid, ${firmId}::uuid, ${principal.userId}, ${manifest.clientPartyId}::uuid,
      ${hash}, ${manifest.totalRows}, ${manifest.chunkSize}, ${JSON.stringify(manifest.chunkHashes)}::jsonb)
    ON CONFLICT (firm_id, actor_id, id) DO NOTHING RETURNING id`);
  const row = await loadRun(tx, principal, firmId, manifest.id, false);
  if (row.manifest_hash !== hash)
    throw new DomainError(
      "IMPORT_MANIFEST_CONFLICT",
      "Import run ID was already used with a different manifest",
      409,
    );
  return {
    created: inserted.rows.length === 1,
    run: await describeRun(tx, row),
  };
}

export async function getImportRun(principal: Principal, id: string) {
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.read",
  );
  // A shared run lock keeps the checkpoint and chunk reads on one version.
  return describeRun(tx, await loadRun(tx, principal, firmId, id, false));
}

export async function executeImportRunChunk(
  principal: Principal,
  id: string,
  chunkIndex: number,
  inputRows: ImportChunkRows,
  importer: typeof importInvoices = importInvoices,
) {
  const { rows } = parseOrThrow(ImportRunChunkBody, { rows: inputRows });
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.write",
  );
  const run = await loadRun(tx, principal, firmId, id, true);
  assertManifestChunk(
    {
      totalRows: run.total_rows,
      chunkSize: run.chunk_size,
      chunkHashes: run.chunk_hashes,
    },
    chunkIndex,
    rows,
  );
  if (chunkIndex > run.next_chunk_index)
    throw new DomainError(
      "IMPORT_CHECKPOINT_CONFLICT",
      "An earlier import chunk must be committed first",
      409,
    );
  const operation = await executeOperation({
    principal,
    command: "invoice.import",
    idempotencyKey: `${run.id}:${chunkIndex}`,
    clientPartyId: run.client_party_id,
    payload: {
      runId: run.id,
      manifestHash: run.manifest_hash,
      chunkIndex,
      rows,
      commit: true,
    },
    execute: async (commandTx) => {
      if (commandTx !== tx)
        throw new Error("Import command left its caller transaction");
      if (run.finalized_at || chunkIndex !== run.next_chunk_index) {
        throw new DomainError(
          "IMPORT_CHECKPOINT_CONFLICT",
          "The import checkpoint cannot be executed again",
          409,
        );
      }
      const result = ImportInvoicesResponse.parse(
        await importer(
          firmId,
          run.client_party_id,
          rows,
          true,
          principal.userId,
        ),
      );
      assertCommittedChunkResult(result, rows);
      return {
        statusCode: 200,
        body: {
          runId: run.id,
          chunkIndex,
          nextChunkIndex: chunkIndex + 1,
          result,
        },
        ...importOperationOutcome(result),
      };
    },
  });
  if (!operation.replayed) {
    const { result } = ImportRunChunkResponse.parse(JSON.parse(operation.body));
    await activeOperationDb(tx).execute(sql`INSERT INTO import_run_chunks
      (firm_id, actor_id, run_id, client_party_id, chunk_index, operation_id, row_count, created_count, invalid_count)
      VALUES (${firmId}::uuid, ${principal.userId}, ${run.id}::uuid, ${run.client_party_id}::uuid,
        ${chunkIndex}, ${operation.operationId}::uuid, ${rows.length}, ${result.createdCount}, ${result.invalidCount})`);
    await activeOperationDb(tx)
      .execute(sql`UPDATE import_runs SET next_chunk_index = ${chunkIndex + 1}, updated_at = clock_timestamp()
      WHERE firm_id = ${firmId}::uuid AND actor_id = ${principal.userId} AND id = ${run.id}::uuid`);
  } else {
    const saved = await activeOperationDb(tx)
      .execute(sql`SELECT 1 FROM import_run_chunks WHERE firm_id = ${firmId}::uuid
      AND actor_id = ${principal.userId} AND run_id = ${run.id}::uuid AND chunk_index = ${chunkIndex}
      AND operation_id = ${operation.operationId}::uuid`);
    if (saved.rows.length !== 1)
      throw new Error("Replayed import operation has no committed checkpoint");
  }
  return operation;
}

export async function finalizeImportRun(principal: Principal, id: string) {
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.write",
  );
  let run = await loadRun(tx, principal, firmId, id, true);
  if (run.next_chunk_index !== run.chunk_hashes.length)
    throw new DomainError(
      "IMPORT_INCOMPLETE",
      "All manifest chunks must be committed before finalization",
      409,
    );
  if (!run.finalized_at) {
    const updated = await activeOperationDb(tx)
      .execute<Run>(sql`UPDATE import_runs SET finalized_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE firm_id = ${firmId}::uuid AND actor_id = ${principal.userId} AND id = ${run.id}::uuid RETURNING *`);
    run = updated.rows[0];
  }
  return describeRun(tx, run);
}
