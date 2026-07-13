import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
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
  deadlineAlerts: boolean("deadline_alerts").notNull().default(true),
  failureAlerts: boolean("failure_alerts").notNull().default(true),
  penaltyAlerts: boolean("penalty_alerts").notNull().default(true),
  updatedAt: updatedAt(),
});

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
  createdAt: createdAt(),
});

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

export const insertAlertPreferencesSchema = createInsertSchema(
  alertPreferencesTable,
).omit({ updatedAt: true });
export const insertEscalationSchema = createInsertSchema(escalationsTable).omit({
  id: true,
  createdAt: true,
});

export type AlertPreferences = typeof alertPreferencesTable.$inferSelect;
export type Escalation = typeof escalationsTable.$inferSelect;
export type EscalationStatus = (typeof escalationStatusEnum.enumValues)[number];
