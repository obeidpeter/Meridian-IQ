import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// A durable, non-secret record that a privileged production bootstrap path has
// been consumed. Guardrail migration 0055 makes rows immutable and bypass-only.
// The operator id is deliberately not a foreign key: deleting that user must not
// erase or mutate the permanent consumed state.
export const productionBootstrapClaimsTable = pgTable(
  "production_bootstrap_claims",
  {
    key: text("key").primaryKey(),
    operatorUserId: uuid("operator_user_id").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);
