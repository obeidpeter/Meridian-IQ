import {
  pgTable,
  uuid,
  timestamp,
  integer,
  numeric,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";

// B2C reporting module (SME-08, C5): B2C transactions above NGN 50,000 must be
// reported within 24 hours, with daily penalties for late reporting. Qualifying
// invoices are collected into per-client batches carrying a compliance clock;
// the pipeline sweep fires pre-breach alerts at least four hours before the
// deadline and marks breaches.

export const b2cBatchStatusEnum = pgEnum("b2c_batch_status", [
  "open", // collecting qualifying transactions; clock running
  "reported", // submitted inside the window
  "breached", // deadline passed without a report
]);

export const b2cReportBatchesTable = pgTable("b2c_report_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  status: b2cBatchStatusEnum("status").notNull().default("open"),
  // Clock anchor: the earliest qualifying transaction in the batch.
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  // windowStart + 24h. Alerts fire when deadlineAt - now <= 4h (SME-08).
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  itemCount: integer("item_count").notNull().default(0),
  totalAmount: numeric("total_amount", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  reportedByUserId: uuid("reported_by_user_id"),
  preBreachAlertAt: timestamp("pre_breach_alert_at", { withTimezone: true }),
  breachedAt: timestamp("breached_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const b2cReportItemsTable = pgTable(
  "b2c_report_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => b2cReportBatchesTable.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // A qualifying invoice belongs to exactly one batch (sweep idempotency).
  (t) => [unique().on(t.invoiceId)],
);

export const insertB2cReportBatchSchema = createInsertSchema(
  b2cReportBatchesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertB2cReportItemSchema = createInsertSchema(
  b2cReportItemsTable,
).omit({ id: true, createdAt: true });

export type B2cReportBatch = typeof b2cReportBatchesTable.$inferSelect;
export type B2cReportItem = typeof b2cReportItemsTable.$inferSelect;
export type B2cBatchStatus = (typeof b2cBatchStatusEnum.enumValues)[number];
export type InsertB2cReportBatch = z.infer<typeof insertB2cReportBatchSchema>;
