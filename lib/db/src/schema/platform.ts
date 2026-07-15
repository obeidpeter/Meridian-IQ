import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Login throttle counters (SEC-02, SEC-M4). Fixed-window failure counts keyed
// by "email|ip" (per-source) and "email" (per-account, IP-independent — caps
// distributed credential stuffing). Persisted rather than in-memory so the
// cap holds across a multi-instance deployment. Written on the raw pool
// connection, NOT the RLS-scoped request transaction, so a failed login's 4xx
// rollback does not discard the recorded attempt; the login role bypasses RLS,
// and expired rows are pruned by a registered cleanup sweep.
export const loginAttemptsTable = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Feature flags gate every release-tagged capability (PL-02). A dark feature is
// unreachable. Per-firm overrides allow layer-three surfaces to activate per
// client on recorded consent.
export const featureFlagsTable = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  releaseTag: text("release_tag").notNull().default("R0"),
  description: text("description"),
  updatedAt: updatedAt(),
});

export const featureFlagOverridesTable = pgTable(
  "feature_flag_overrides",
  {
    id: id(),
    flagKey: text("flag_key")
      .notNull()
      .references(() => featureFlagsTable.key),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    enabled: boolean("enabled").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.flagKey, t.firmId)],
);

export const messageChannelEnum = pgEnum("message_channel", [
  "whatsapp",
  "sms",
  "email",
  "push",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
]);

// Messaging carries pointers only — never amounts, names, TINs or documents
// (SEC-12, PL-04). recipientRef and entity pointers are opaque references.
export const messagesTable = pgTable("messages", {
  id: id(),
  channel: messageChannelEnum("channel").notNull(),
  recipientRef: text("recipient_ref").notNull(),
  templateKey: text("template_key").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  status: messageStatusEnum("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  failoverFrom: messageChannelEnum("failover_from"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Transactional outbox: written in the same transaction as the domain change,
// drained by the worker (INT-09). status=dead is the dead-letter queue.
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "processing",
  "done",
  "dead",
]);

export const outboxTable = pgTable("outbox_events", {
  id: id(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: outboxStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(6),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Circuit-breaker state per rail, persisted so it survives restarts and can be
// reconciled by the scheduled rail-state job (INT-09).
export const circuitStateEnum = pgEnum("circuit_state", [
  "closed",
  "open",
  "half_open",
]);

export const railStatesTable = pgTable("rail_states", {
  rail: text("rail").primaryKey(),
  state: circuitStateEnum("state").notNull().default("closed"),
  failureCount: integer("failure_count").notNull().default(0),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

// Stamp-verification cache with a configurable freshness window (CORE-04).
export const stampVerificationsTable = pgTable("stamp_verifications", {
  id: id(),
  irn: text("irn").notNull(),
  csid: text("csid").notNull(),
  valid: boolean("valid").notNull(),
  rail: text("rail").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  checkedAt: timestamp("checked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  freshUntil: timestamp("fresh_until", { withTimezone: true }).notNull(),
});

// Server-generated secrets that must survive restarts (e.g. the session-cookie
// signing key). Generated once at boot when absent; never exposed via any API.
export const appSecretsTable = pgTable("app_secrets", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: createdAt(),
});

// CORE-06: every migration/schema version recorded; records declare their
// writing version via per-entity schemaVersion columns.
export const schemaVersionsTable = pgTable("schema_versions", {
  version: integer("version").primaryKey(),
  description: text("description").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type FeatureFlag = typeof featureFlagsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type OutboxEvent = typeof outboxTable.$inferSelect;
export type MessageChannel = (typeof messageChannelEnum.enumValues)[number];
