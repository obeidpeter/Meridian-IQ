import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.ts";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { operationsTable } from "./operations.ts";

const ownerPredicate = sql`
  firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  AND actor_id = nullif(current_setting('app.operation_actor_id', true), '')
  AND (nullif(current_setting('app.operation_client_party_id', true), '') IS NULL
    OR client_party_id = nullif(current_setting('app.operation_client_party_id', true), '')::uuid)
`;

function ownerPolicy() {
  return pgPolicy("meridian_import_run_owner", {
    for: "all",
    to: "public",
    using: ownerPredicate,
    withCheck: ownerPredicate,
  });
}

export const importRunsTable = pgTable(
  "import_runs",
  {
    id: uuid("id").notNull(),
    firmId: uuid("firm_id").notNull(),
    actorId: text("actor_id").notNull(),
    clientPartyId: uuid("client_party_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    totalRows: integer("total_rows").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    chunkHashes: jsonb("chunk_hashes").$type<string[]>().notNull(),
    nextChunkIndex: integer("next_chunk_index").notNull().default(0),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ownerPolicy(),
    foreignKey({
      name: "import_runs_firm_id_fkey",
      columns: [t.firmId],
      foreignColumns: [firmsTable.id],
    }),
    foreignKey({
      name: "import_runs_client_party_id_fkey",
      columns: [t.clientPartyId],
      foreignColumns: [partiesTable.id],
    }),
    primaryKey({
      name: "import_runs_pkey",
      columns: [t.firmId, t.actorId, t.id],
    }),
    check(
      "import_runs_manifest_check",
      sql`${t.totalRows} >= 1 AND ${t.totalRows} <= 5000 AND ${t.chunkSize} >= 1 AND ${t.chunkSize} <= 250
    AND ${t.manifestHash} ~ '^[0-9a-f]{64}$' AND jsonb_typeof(${t.chunkHashes}) = 'array'
    AND jsonb_array_length(${t.chunkHashes}) = ((${t.totalRows} + ${t.chunkSize} - 1) / ${t.chunkSize})`,
    ),
    check(
      "import_runs_checkpoint_check",
      sql`${t.nextChunkIndex} >= 0 AND ${t.nextChunkIndex} <= jsonb_array_length(${t.chunkHashes})
    AND (${t.finalizedAt} IS NULL OR ${t.nextChunkIndex} = jsonb_array_length(${t.chunkHashes}))`,
    ),
  ],
).enableRLS();

export const importRunChunksTable = pgTable(
  "import_run_chunks",
  {
    firmId: uuid("firm_id").notNull(),
    actorId: text("actor_id").notNull(),
    runId: uuid("run_id").notNull(),
    clientPartyId: uuid("client_party_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    operationId: uuid("operation_id").notNull(),
    rowCount: integer("row_count").notNull(),
    createdCount: integer("created_count").notNull(),
    invalidCount: integer("invalid_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    ownerPolicy(),
    foreignKey({
      name: "import_run_chunks_client_party_id_fkey",
      columns: [t.clientPartyId],
      foreignColumns: [partiesTable.id],
    }),
    foreignKey({
      name: "import_run_chunks_operation_id_fkey",
      columns: [t.operationId],
      foreignColumns: [operationsTable.id],
    }),
    primaryKey({
      name: "import_run_chunks_pkey",
      columns: [t.firmId, t.actorId, t.runId, t.chunkIndex],
    }),
    foreignKey({
      name: "import_run_chunks_run_fk",
      columns: [t.firmId, t.actorId, t.runId],
      foreignColumns: [
        importRunsTable.firmId,
        importRunsTable.actorId,
        importRunsTable.id,
      ],
    }),
    uniqueIndex("import_run_chunks_operation_uidx").on(t.operationId),
    check(
      "import_run_chunks_counts_check",
      sql`${t.chunkIndex} >= 0 AND ${t.rowCount} >= 1 AND ${t.rowCount} <= 250
    AND ${t.createdCount} >= 0 AND ${t.invalidCount} >= 0 AND ${t.createdCount} + ${t.invalidCount} = ${t.rowCount}`,
    ),
  ],
).enableRLS();

export type ImportRunRow = typeof importRunsTable.$inferSelect;
export type ImportRunChunkRow = typeof importRunChunksTable.$inferSelect;
