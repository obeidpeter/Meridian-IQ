import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Client Compliance Profile: the per-client statutory facts a HUMAN at the
// firm asserts — whether the client is VAT-registered, whether it employs
// staff (PAYE), its financial year end, its incorporation date. Parties are
// shared spine entities, so these firm-asserted facts live here, keyed
// (firm, client) — the clerk_action_policies key pattern. Evidence-only:
// the platform never infers registration status from documents or models.
//
// ABSENCE SEMANTICS (load-bearing): a client with NO profile row keeps the
// original Filing Desk behavior — monthly VAT and PAYE rows are both
// minted. A profile row is the firm SAYING what applies; only then do the
// mint gates narrow. Adoption is per-client and nothing changes until a
// human speaks.

export const clientComplianceProfilesTable = pgTable(
  "client_compliance_profiles",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    // Monthly mint gates: VAT rows only when registered, PAYE rows only
    // when the client actually employs.
    vatRegistered: boolean("vat_registered").notNull().default(false),
    payeEmployer: boolean("paye_employer").notNull().default(false),
    // Financial year end MONTH (1-12). Null = not captured; the CIT annual
    // return cannot be minted without it.
    fyeMonth: integer("fye_month"),
    // Null = not captured; the CAC annual return cannot be minted without
    // it (a company incorporated this year owes no annual return yet).
    incorporationDate: date("incorporation_date", { mode: "string" }),
    notes: text("notes"),
    updatedBy: uuid("updated_by").references(() => usersTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One profile per firm × client — the upsert key.
    uniqueIndex("client_compliance_profiles_uq").on(t.firmId, t.clientPartyId),
    index("client_compliance_profiles_firm_idx").on(t.firmId),
  ],
);

export type ClientComplianceProfile =
  typeof clientComplianceProfilesTable.$inferSelect;
