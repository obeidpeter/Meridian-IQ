import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";

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
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Guided failure resolution can hand off to a human operator (SME-06). An
// escalation records why an invoice needs attention and tracks its handling.
export const escalationStatusEnum = pgEnum("escalation_status", [
  "open",
  "acknowledged",
  "resolved",
]);

export const escalationsTable = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Expo push-notification device registrations (mobile companion app). One row
// per device token; a token is globally unique and re-registering it moves it
// to the current user (a device belongs to whoever signed in last). Tenant
// scoping mirrors memberships: firmId/clientPartyId snapshot the principal that
// registered the device so alert fan-out can resolve devices per client Party.
export const pushDevicesTable = pgTable("push_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id),
  firmId: uuid("firm_id").references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
  expoPushToken: text("expo_push_token").notNull().unique(),
  platform: text("platform").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
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
