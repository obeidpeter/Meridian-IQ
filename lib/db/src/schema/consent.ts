import {
  pgTable,
  uuid,
  text,
  integer,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { partiesTable } from "./parties.ts";
import { createdAt, id } from "./columns.ts";

// Three-layer consent architecture (Plan 7.2, C6):
//   layer 1 = compliance (required)
//   layer 2 = anonymized-aggregate (standard)
//   layer 3 = credit-readiness (opt-in, dormant until R3)
// Each grant/revoke is an append-only event; the permission query reads the
// latest event per (party, layer) (CORE-03).
export const consentActionEnum = pgEnum("consent_action", ["grant", "revoke"]);

export const consentRecordsTable = pgTable(
  "consent_records",
  {
    id: id(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => partiesTable.id),
    layer: integer("layer").notNull(),
    action: consentActionEnum("action").notNull(),
    scope: text("scope").notNull(),
    basis: text("basis").notNull(),
    channel: text("channel").notNull(),
    // One first-landing command records layers 1 and 2 atomically. Historical
    // and manual ledger entries remain valid with a null command id.
    commandId: uuid("command_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("consent_records_party_command_layer_uq").on(
      t.partyId,
      t.commandId,
      t.layer,
    ),
  ],
);

export type ConsentRecord = typeof consentRecordsTable.$inferSelect;
export type ConsentAction = (typeof consentActionEnum.enumValues)[number];
