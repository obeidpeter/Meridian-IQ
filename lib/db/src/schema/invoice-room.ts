import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id, updatedAt } from "./columns.ts";
import { firmsTable } from "./organizations.ts";
import { invoicesTable } from "./invoices.ts";

export const invoiceRoomDeliveryChannelEnum = pgEnum(
  "invoice_room_delivery_channel",
  ["email", "whatsapp", "copy"],
);

export const invoiceRoomEventKindEnum = pgEnum("invoice_room_event_kind", [
  "created",
  "opened",
  "delivery_sent",
  "delivery_failed",
  "otp_requested",
  "identity_verified",
  "confirmed",
  "queried",
  "rejected",
  "payment_reported",
  "payment_link_created",
  "payment_confirmed",
  "claimed",
  "reminder_reserved",
  "reminder_sent",
  "reminder_failed",
  "revoked",
]);

export const invoiceRoomActorTypeEnum = pgEnum("invoice_room_actor_type", [
  "supplier",
  "buyer_guest",
  "buyer_user",
  "system",
]);

export const invoiceRoomPaymentStatusEnum = pgEnum(
  "invoice_room_payment_status",
  ["pending", "confirmed", "failed", "expired"],
);

// One revocable, expiring buyer workspace per invoice. The raw bearer token is
// shown once and travels in the browser URL fragment; only its SHA-256 digest
// is retained here. Contact data is tenant protected and never returned by a
// public API. An AES-GCM ciphertext is retained only so an idempotent retry or
// consented reminder can recover the same credential; production requires a
// separate deployment key. Replacing a room revokes this row and creates a
// fresh credential.
export const invoiceRoomSharesTable = pgTable(
  "invoice_room_shares",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    tokenHash: text("token_hash").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    deliveryChannel: invoiceRoomDeliveryChannelEnum("delivery_channel")
      .notNull()
      .default("copy"),
    remindersEnabled: boolean("reminders_enabled").notNull().default(false),
    contactConsentAt: timestamp("contact_consent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoice_room_shares_token_uq").on(t.tokenHash),
    uniqueIndex("invoice_room_shares_request_uq").on(
      t.firmId,
      t.clientRequestId,
    ),
    uniqueIndex("invoice_room_shares_one_live_invoice_uq")
      .on(t.invoiceId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("invoice_room_shares_firm_created_idx").on(t.firmId, t.createdAt),
    index("invoice_room_shares_expiry_idx").on(t.expiresAt),
  ],
);

// A short-lived browser session replaces the long-lived share token after the
// initial exchange. It is deliberately bypass-only: supplier tenant sessions
// have no reason to inspect buyer browser credentials. OTP hashes bind to the
// raw room-session token, making a leaked database digest useless offline.
export const invoiceRoomSessionsTable = pgTable(
  "invoice_room_sessions",
  {
    id: id(),
    shareId: uuid("share_id")
      .notNull()
      .references(() => invoiceRoomSharesTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    otpHash: text("otp_hash"),
    otpExpiresAt: timestamp("otp_expires_at", { withTimezone: true }),
    otpChannel: invoiceRoomDeliveryChannelEnum("otp_channel"),
    verifiedContactHash: text("verified_contact_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoice_room_sessions_token_uq").on(t.tokenHash),
    index("invoice_room_sessions_share_idx").on(t.shareId),
    index("invoice_room_sessions_expiry_idx").on(t.expiresAt),
  ],
);

// Human and system activity is append-only evidence. idempotency_key is scoped
// to a room and used by buyer actions and reminder reservations so retries,
// double-clicks and concurrent workers cannot duplicate side effects.
export const invoiceRoomEventsTable = pgTable(
  "invoice_room_events",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    shareId: uuid("share_id")
      .notNull()
      .references(() => invoiceRoomSharesTable.id),
    kind: invoiceRoomEventKindEnum("kind").notNull(),
    actorType: invoiceRoomActorTypeEnum("actor_type").notNull(),
    actorRef: text("actor_ref"),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoice_room_events_idempotency_uq")
      .on(t.shareId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("invoice_room_events_invoice_created_idx").on(
      t.invoiceId,
      t.createdAt,
    ),
    index("invoice_room_events_share_created_idx").on(t.shareId, t.createdAt),
  ],
);

// Provider payment-link reservations are separate from settlement evidence.
// A confirmed provider callback appends the canonical settlement event; this
// row only owns checkout lifecycle and provider replay protection.
export const invoiceRoomPaymentRequestsTable = pgTable(
  "invoice_room_payment_requests",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    shareId: uuid("share_id")
      .notNull()
      .references(() => invoiceRoomSharesTable.id),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference"),
    checkoutUrl: text("checkout_url"),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    status: invoiceRoomPaymentStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoice_room_payments_idempotency_uq").on(
      t.shareId,
      t.idempotencyKey,
    ),
    uniqueIndex("invoice_room_payments_provider_ref_uq")
      .on(t.provider, t.providerReference)
      .where(sql`${t.providerReference} IS NOT NULL`),
    index("invoice_room_payments_invoice_created_idx").on(
      t.invoiceId,
      t.createdAt,
    ),
  ],
);

export type InvoiceRoomShare = typeof invoiceRoomSharesTable.$inferSelect;
export type InvoiceRoomSession = typeof invoiceRoomSessionsTable.$inferSelect;
export type InvoiceRoomEvent = typeof invoiceRoomEventsTable.$inferSelect;
export type InvoiceRoomPaymentRequest =
  typeof invoiceRoomPaymentRequestsTable.$inferSelect;
