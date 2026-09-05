import { sql } from "drizzle-orm";
import {
  pgTable,
  pgPolicy,
  uuid,
  bigint,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { clerkInferenceCallsTable } from "./clerk.ts";

export const clerkReservationsTable = pgTable(
  "clerk_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    reservedTokens: bigint("reserved_tokens", { mode: "number" }).notNull(),
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    inferenceCallId: uuid("inference_call_id")
      .references(() => clerkInferenceCallsTable.id)
      .unique(),
    providerCallId: uuid("provider_call_id")
      .references(() => clerkInferenceCallsTable.id)
      .unique(),
  },
  (t) => [
    pgPolicy("meridian_bypass_only", {
      for: "all",
      to: "public",
      using: sql`current_setting('app.bypass', true) = 'on'`,
      withCheck: sql`current_setting('app.bypass', true) = 'on'`,
    }),
    index("clerk_reservations_unsettled_idx")
      .on(t.firmId)
      .where(sql`${t.settledAt} IS NULL`),
    check("clerk_reservations_tokens_positive", sql`${t.reservedTokens} > 0`),
    check(
      "clerk_reservations_settlement",
      sql`(${t.settledAt} IS NULL) = (${t.inferenceCallId} IS NULL)`,
    ),
  ],
).enableRLS();
