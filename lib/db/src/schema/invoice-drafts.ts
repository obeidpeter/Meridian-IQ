import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";

export const invoiceDraftsTable = pgTable(
  "invoice_drafts",
  {
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    userId: text("user_id").notNull(),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    id: uuid("id").notNull(),
    revision: integer("revision").notNull().default(1),
    writeId: uuid("write_id").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.firmId, t.userId, t.clientPartyId, t.id] }),
    check("invoice_drafts_revision_check", sql`${t.revision} > 0`),
    index("invoice_drafts_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.content} <> '{}'::jsonb`),
    pgPolicy("meridian_tenant_isolation", {
      using: sql`current_setting('app.bypass', true) = 'on' OR (
        ${t.firmId} = nullif(current_setting('app.firm_id', true), '')::uuid
        AND ${t.userId} = current_setting('app.invoice_draft_user_id', true)
        AND ${t.clientPartyId} = nullif(current_setting('app.invoice_draft_client_id', true), '')::uuid)`,
      withCheck: sql`current_setting('app.bypass', true) = 'on' OR (
        ${t.firmId} = nullif(current_setting('app.firm_id', true), '')::uuid
        AND ${t.userId} = current_setting('app.invoice_draft_user_id', true)
        AND ${t.clientPartyId} = nullif(current_setting('app.invoice_draft_client_id', true), '')::uuid)`,
    }),
    index("invoice_drafts_owner_idx").on(
      t.firmId,
      t.userId,
      t.clientPartyId,
      t.updatedAt,
    ),
  ],
).enableRLS();
