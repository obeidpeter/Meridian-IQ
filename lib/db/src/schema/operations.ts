import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.ts";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";

const ownerPredicate = sql`
  firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  AND actor_id = nullif(current_setting('app.operation_actor_id', true), '')
  AND (nullif(current_setting('app.operation_client_party_id', true), '') IS NULL
    OR client_party_id = nullif(current_setting('app.operation_client_party_id', true), '')::uuid)
`;

export const operationsTable = pgTable(
  "operations",
  {
    id: id(),
    firmId: uuid("firm_id").notNull(),
    // Machine principals use apikey:<uuid>, not a users-table foreign key.
    actorId: text("actor_id").notNull(),
    clientPartyId: uuid("client_party_id").notNull(),
    command: text("command").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status")
      .$type<"running" | "succeeded" | "partial" | "failed">()
      .notNull()
      .default("running"),
    responseStatus: integer("response_status"),
    // Text preserves the exact JSON bytes; jsonb would reorder object keys.
    responseBody: text("response_body"),
    summary: text("summary"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    pgPolicy("meridian_operation_owner", {
      for: "all",
      to: "public",
      using: ownerPredicate,
      withCheck: ownerPredicate,
    }),
    foreignKey({
      name: "operations_firm_id_fkey",
      columns: [t.firmId],
      foreignColumns: [firmsTable.id],
    }),
    foreignKey({
      name: "operations_client_party_id_fkey",
      columns: [t.clientPartyId],
      foreignColumns: [partiesTable.id],
    }),
    uniqueIndex("operations_command_key_uidx").on(
      t.firmId,
      t.actorId,
      t.command,
      t.idempotencyKey,
    ),
    index("operations_owner_history_idx").on(
      t.firmId,
      t.actorId,
      t.createdAt,
      t.id,
    ),
    check(
      "operations_command_check",
      sql`${t.command} IN ('invoice.create', 'invoice.import')`,
    ),
    check(
      "operations_key_check",
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check("operations_hash_check", sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "operations_result_check",
      sql`(
    ${t.status} = 'running' AND ${t.responseStatus} IS NULL AND ${t.responseBody} IS NULL
  ) OR (
    ${t.status} IN ('succeeded', 'partial', 'failed')
    AND ${t.responseStatus} IS NOT NULL AND ${t.responseStatus} BETWEEN 200 AND 299 AND ${t.responseBody} IS NOT NULL
  )`,
    ),
  ],
).enableRLS();

export type OperationRow = typeof operationsTable.$inferSelect;
