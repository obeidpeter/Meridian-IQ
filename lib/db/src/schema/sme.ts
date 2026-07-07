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
import { firmsTable } from "./organizations.ts";
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
