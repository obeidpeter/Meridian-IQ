import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  pgEnum,
  index,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Per-client alert channel + alert-type preferences (SME-05). One row per client
// business Party. Channel toggles drive WhatsApp/SMS/email fan-out with failover;
// alert-type toggles gate which events (deadline/failure/penalty) notify.
export const alertPreferencesTable = pgTable("alert_preferences", {
  clientPartyId: uuid("client_party_id")
    .primaryKey()
    .references(() => partiesTable.id),
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(true),
  whatsappTo: text("whatsapp_to"),
  phone: text("phone"),
  email: text("email"),
  // Provenance of the stored contact numbers: the principal ROLE that last
  // wrote whatsappTo/phone (recorded by the prefs PUT whenever either field
  // is named in the payload). The inbound WhatsApp rail only treats a number
  // as a routing key when the client set it themselves
  // (contact_set_by_role = 'client_user') — a firm-staff-typed free-text
  // number must not be able to route documents into a client's book. Null on
  // rows that predate the column (fail closed: they do not route).
  contactSetByRole: text("contact_set_by_role"),
  deadlineAlerts: boolean("deadline_alerts").notNull().default(true),
  failureAlerts: boolean("failure_alerts").notNull().default(true),
  penaltyAlerts: boolean("penalty_alerts").notNull().default(true),
  updatedAt: updatedAt(),
});

// The deadline-reminder sweep's idempotency ledger: one row per (invoice,
// threshold). A client is reminded once when an unsubmitted invoice enters
// the due-soon window and once more if it goes overdue — never again on
// subsequent sweep ticks. Rows are written even while messaging is dark so
// enabling the flag later does not blast reminders for old invoices.
export const deadlineReminderKindEnum = pgEnum("deadline_reminder_kind", [
  "due_soon",
  "overdue",
]);

export const deadlineReminderSendsTable = pgTable(
  "deadline_reminder_sends",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    kind: deadlineReminderKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("deadline_reminder_invoice_kind_uq").on(t.invoiceId, t.kind),
  ],
);

// Guided failure resolution can hand off to a human operator (SME-06). An
// escalation records why an invoice needs attention and tracks its handling.
export const escalationStatusEnum = pgEnum("escalation_status", [
  "open",
  "acknowledged",
  "resolved",
]);

export const escalationsTable = pgTable("escalations", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  reason: text("reason").notNull(),
  errorCode: text("error_code"),
  status: escalationStatusEnum("status").notNull().default("open"),
  context: jsonb("context").$type<Record<string, unknown>>(),
  // Operator reply (idea #5): the operator's answer to the client, shown on
  // the SME escalation card. Written through the reply route only — a Clerk
  // DRAFT never lands here without an operator pressing send.
  operatorReply: text("operator_reply"),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  // The operator case view and the SME escalation list both look up by
  // invoice; the firm index backs tenant-scoped scans.
  index("escalations_invoice_idx").on(t.invoiceId),
  index("escalations_firm_idx").on(t.firmId),
]);
export type Escalation = typeof escalationsTable.$inferSelect;

// Expo push-notification device registrations (mobile companion app). One row
// per device token; a token is globally unique and re-registering it moves it
// to the current user (a device belongs to whoever signed in last). Tenant
// scoping mirrors memberships: firmId/clientPartyId snapshot the principal that
// registered the device so alert fan-out can resolve devices per client Party.
export const pushDevicesTable = pgTable("push_devices", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id),
  firmId: uuid("firm_id").references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
  expoPushToken: text("expo_push_token").notNull().unique(),
  platform: text("platform").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Pending Expo push-receipt checks (SME-05/08 hygiene). Expo materialises push
// receipts asynchronously (often ~15 minutes after the send), so a token whose
// death is only visible in a late receipt survives the immediate post-send
// check. Each successful send ticket is persisted here with its token; a
// periodic sweep re-checks receipts for tickets older than the receipt delay,
// prunes push_devices rows whose receipts report DeviceNotRegistered, and
// deletes processed/expired rows so the table never grows unbounded. Internal
// ops table: only written by the push module and read by the bypass-context
// sweep — never exposed to tenant request paths.
export const pushTicketsTable = pgTable("push_tickets", {
  id: id(),
  ticketId: text("ticket_id").notNull().unique(),
  expoPushToken: text("expo_push_token").notNull(),
  createdAt: createdAt(),
});

export type AlertPreferences = typeof alertPreferencesTable.$inferSelect;
