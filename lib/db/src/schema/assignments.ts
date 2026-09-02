import { pgTable, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { usersTable } from "./organizations.ts";
import { createdAt, id } from "./columns.ts";

// Per-staff client assignment (architecture.md D12): a firm-scoped, many-to-
// many "who looks after which client" register. It narrows the DEFAULT view
// ("My clients"), never the boundary — RLS (firm) and SEC-03 (client scope)
// remain the only isolation, and an unassigned client stays visible to the
// whole firm (default-open). Rows are added and removed, never edited, and
// every change is an audit event.
export const clientAssignmentsTable = pgTable(
  "client_assignments",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    assignedBy: uuid("assigned_by").references(() => usersTable.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("client_assignments_firm_client_user_uq").on(
      t.firmId,
      t.clientPartyId,
      t.userId,
    ),
    index("client_assignments_firm_user_idx").on(t.firmId, t.userId),
  ],
);

export type ClientAssignment = typeof clientAssignmentsTable.$inferSelect;
