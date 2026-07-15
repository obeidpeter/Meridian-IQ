import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// ERP connector contract (PL-03, INT-06). A connection is configuration plus
// field mapping against one Connector interface — never a core fork. Incremental
// pulls run as outbox jobs; each run is recorded for observability.

export const erpConnectionStatusEnum = pgEnum("erp_connection_status", [
  "active",
  "paused",
  "error",
]);

export const erpConnectionsTable = pgTable("erp_connections", {
  id: id(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  // Which Connector implementation serves this connection (e.g. "sagepro",
  // "quicklite"). Resolved through the connector registry, never branched on.
  connectorKey: text("connector_key").notNull(),
  // Connector-specific auth configuration (kept opaque to the core).
  authConfig: jsonb("auth_config").$type<Record<string, unknown>>(),
  // Optional field-mapping overrides applied over the connector's default map.
  fieldMap: jsonb("field_map").$type<Record<string, string>>(),
  // Incremental pull cursor, opaque to the core (INT-06).
  cursor: text("cursor"),
  status: erpConnectionStatusEnum("status").notNull().default("active"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const erpSyncRunStatusEnum = pgEnum("erp_sync_run_status", [
  "running",
  "succeeded",
  "failed",
]);

export const erpSyncRunsTable = pgTable("erp_sync_runs", {
  id: id(),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => erpConnectionsTable.id, { onDelete: "cascade" }),
  status: erpSyncRunStatusEnum("status").notNull().default("running"),
  fromCursor: text("from_cursor"),
  toCursor: text("to_cursor"),
  pulledCount: integer("pulled_count").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  // Per-row outcomes for diagnosis (bounded by the pull batch size).
  rowResults: jsonb("row_results").$type<Record<string, unknown>[]>(),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

