import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { createdAt, id } from "./columns.ts";

// Firm machine integrations (round 16): API keys (inbound machine
// credentials) and outbound webhooks. Both are tenant data — firm-keyed RLS
// via migration 0022.

// A firm-scoped machine credential (contract 0.41.0 /firm-api-keys). The full
// key string (`mk_<6-char prefix>_<32 random chars>`) is shown ONCE at mint;
// only its sha256 is stored (the invitations/password-reset posture — the
// platform can verify a presented key but never re-reveal one). `key_prefix`
// ("mk_" + 6 chars) is the displayable identifier the list page shows and the
// lookup key at auth time. `capabilities` is the explicit machine-safe grant
// list the resolved principal carries VERBATIM — no role matrix (see
// modules/integrations/api-keys.ts for the vetted allowlist). Revocation is a
// compare-and-set on the nullable `revoked_at`; rows are never deleted, so a
// revoked key stays visible history.
export const firmApiKeysTable = pgTable(
  "firm_api_keys",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    name: text("name").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),
    keyPrefix: text("key_prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    // Best-effort usage stamp, written on the raw pool at auth time and
    // throttled to once a minute per key (middleware must never pay a write
    // per request, and a 4xx rollback must not erase the observation).
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Auth-time lookup: every machine request resolves its key by prefix.
    // Deliberately NON-unique — the 6-char prefix is a locator, not an
    // identity; the sha256 compare decides, and a (vanishingly rare) prefix
    // collision just means comparing against two candidate hashes.
    index("firm_api_keys_prefix_idx").on(t.keyPrefix),
    index("firm_api_keys_firm_idx").on(t.firmId),
  ],
);

// An outbound webhook endpoint a firm registered (contract 0.41.0
// /firm-webhooks). `events` is the subscribed subset of the closed event
// catalog (modules/integrations/webhooks.ts). The signing secret is shown
// ONCE at creation; `secret_hash` (its sha256) doubles as the HMAC signing
// key for deliveries — deriving the key from the shown-once secret keeps the
// raw secret unrecoverable platform-side while still letting every delivery
// be signed (the receiver hashes its stored secret once and verifies with
// that). `secret_prefix` is the displayable identifier. Disable is a
// compare-and-set on `active`; history (and delivery rows) are retained.
export const firmWebhooksTable = pgTable(
  "firm_webhooks",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    active: boolean("active").notNull().default(true),
    secretHash: text("secret_hash").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("firm_webhooks_firm_idx").on(t.firmId)],
);

export const firmWebhookDeliveryStatusEnum = pgEnum(
  "firm_webhook_delivery_status",
  ["pending", "delivered", "failed", "dead"],
);

// One row per (webhook, domain event) — the outbox pattern pointed at a
// tenant's own endpoint. `payload` is POINTER-ONLY by design (SEC-12): an
// entity type + id the receiver resolves back through the authenticated API,
// never amounts, names or document content. `event_key` is the fan-out
// idempotency key (a stable derivation of the source ledger row), unique per
// webhook so two sweep instances can never double-insert the same event.
// `next_attempt_at` + `attempts` drive the dispatcher's claim/backoff cycle
// (outbox semantics: failed → retried with exponential backoff → dead after
// max attempts; `failed` means "will retry", `dead` means "gave up").
export const firmWebhookDeliveriesTable = pgTable(
  "firm_webhook_deliveries",
  {
    id: id(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => firmWebhooksTable.id),
    // Denormalized so the firm-keyed RLS policy (0022) keys on it directly,
    // without a join the RLS planner cannot see (0020's posture).
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventKey: text("event_key").notNull(),
    status: firmWebhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("firm_webhook_deliveries_dedup_idx").on(t.webhookId, t.eventKey),
    // The dispatcher's claim scan (status + due time) must not walk history.
    index("firm_webhook_deliveries_claim_idx").on(t.status, t.nextAttemptAt),
    // The per-webhook delivery list reads newest-first.
    index("firm_webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt),
  ],
);

export type FirmApiKeyRow = typeof firmApiKeysTable.$inferSelect;
export type FirmWebhookRow = typeof firmWebhooksTable.$inferSelect;
export type FirmWebhookDeliveryRow =
  typeof firmWebhookDeliveriesTable.$inferSelect;
