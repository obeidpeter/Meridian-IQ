import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
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
// (SEC-12, PL-04). recipientRef and entity pointers are opaque references
// used for display and provider-side correlation ONLY: the ref is a lossy
// letters-only derivation (~15.5 bits for staff refs), so it can collide at
// scale and must never be the feed's isolation wall. The nullable
// recipient_user_id / recipient_party_id columns are the REAL recipient
// identity — exactly one is set by each send rail (party alerts vs staff
// notifications) — and the notification inbox reads strictly by them. Plain
// uuids, deliberately no FK: this is a platform-wide pointer ledger, not a
// tenant table, and rows must outlive party merges/user offboarding.
export const messagesTable = pgTable("messages", {
  id: id(),
  channel: messageChannelEnum("channel").notNull(),
  recipientRef: text("recipient_ref").notNull(),
  recipientUserId: uuid("recipient_user_id"),
  recipientPartyId: uuid("recipient_party_id"),
  templateKey: text("template_key").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  status: messageStatusEnum("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  failoverFrom: messageChannelEnum("failover_from"),
  error: text("error"),
  // Recipient read-state for the notification feed: null = unread. Set only
  // by the feed's mark-read path, always under the same recipient-identity
  // predicate that scopes reads (SEC-03 — identity columns are the wall).
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Kept for provider-side correlation lookups (delivery webhooks, ops).
  index("messages_recipient_created_idx").on(t.recipientRef, t.createdAt),
  // The notification feeds scan by recipient identity, newest first. Partial:
  // each send sets exactly one identity column, so each index holds only its
  // own rail's rows. The unread count and the mark-read UPDATE ride the SAME
  // identity indexes: a per-recipient feed is tens-to-hundreds of rows, so
  // filtering `read_at IS NULL` inside an already identity-narrowed scan is
  // trivial — an additional partial index WHERE read_at IS NULL would buy
  // nothing at these sizes and is deliberately not added.
  index("messages_recipient_user_created_idx")
    .on(t.recipientUserId, t.createdAt)
    .where(sql`recipient_user_id IS NOT NULL`),
  index("messages_recipient_party_created_idx")
    .on(t.recipientPartyId, t.createdAt)
    .where(sql`recipient_party_id IS NOT NULL`),
]);

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
}, (t) => [
  // Exactly the drain poll's shape (status='pending' AND next_attempt_at <=
  // now() ORDER BY created_at): partial so the index holds only the live
  // queue, not the ever-growing done/dead tail.
  index("outbox_events_pending_idx")
    .on(t.nextAttemptAt, t.createdAt)
    .where(sql`status = 'pending'`),
  // The stuck-submission reconcile sweep probes by aggregate.
  index("outbox_events_aggregate_idx").on(t.aggregateId),
]);

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
// The public verify endpoint looks up by (irn, csid) on every call.
}, (t) => [index("stamp_verifications_irn_csid_idx").on(t.irn, t.csid)]);

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
