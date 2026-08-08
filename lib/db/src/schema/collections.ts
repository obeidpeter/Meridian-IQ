import {
  pgTable,
  uuid,
  text,
  boolean,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Collection accounts (compliance round): virtual account references
// provisioned per client through the collections provider seam. An inbound
// payment webhook resolves its accountReference here (bypass context — the
// webhook has no tenant), binds the payment to one of the client's
// receivables by invoice number, and records a `collection_account`
// settlement event. Deactivated accounts stop being resolved; the rows stay
// as provenance. Firm-keyed RLS via migration 0024.
export const collectionAccountsTable = pgTable(
  "collection_accounts",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    provider: text("provider").notNull(),
    // The provider's virtual account reference — globally unique so the
    // inbound webhook can resolve a payment without any tenant hint.
    accountReference: text("account_reference").notNull(),
    label: text("label"),
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.accountReference),
    index("collection_accounts_firm_idx").on(t.firmId),
    index("collection_accounts_client_idx").on(t.clientPartyId),
    uniqueIndex("collection_accounts_one_active_per_client")
      .on(t.firmId, t.clientPartyId)
      .where(sql`${t.active} = true`),
  ],
);

export type CollectionAccountRow = typeof collectionAccountsTable.$inferSelect;
