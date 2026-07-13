import {
  pgTable,
  uuid,
  text,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// The accounting firm is the tenant root (CON-01). White-label theming (CON-05).
export const firmsTable = pgTable("firms", {
  id: id(),
  name: text("name").notNull(),
  subdomain: text("subdomain").unique(),
  // Clerk organization id, wired by the frontend auth layer.
  clerkOrgId: text("clerk_org_id").unique(),
  // The firm's own Party record (professional firms are inside the compliance net).
  partyId: uuid("party_id").references(() => partiesTable.id),
  theme: jsonb("theme").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const usersTable = pgTable("users", {
  id: id(),
  clerkUserId: text("clerk_user_id").unique(),
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  // scrypt hash (salt:hash, hex) for cookie-session login. Null for users who
  // authenticate through Clerk only.
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Role-permission matrix (Appendix C). bank_user is dormant until R4.
// buyer_user is the Buyer Rails role (BR-01..BR-05): a buyer-organization
// principal scoped to a buyer Party rather than a tenant firm.
export const roleEnum = pgEnum("role", [
  "firm_admin",
  "firm_staff",
  "client_user",
  "operator",
  "bank_user",
  "buyer_user",
  "auditor",
]);

// A user's role binding. firm-scoped roles carry a firmId; MeridianIQ staff
// (operator, auditor) and bank users are cross-tenant and may have a null firmId.
// client_user additionally scopes to a single client Party; buyer_user scopes to
// a single buyer Party (Buyer Rails) and carries no firm.
// The 5-column `nullsNotDistinct` unique index (memberships_binding_unique) is
// deliberately NOT declared here. drizzle-kit push (0.31.x) cannot introspect
// NULLS NOT DISTINCT, so it re-proposed the constraint on every run and — on a
// non-empty table — hit an interactive "truncate?" prompt that hangs the
// non-TTY post-merge push. The index is instead created idempotently in the
// boot migration (see lib/db/src/migrations/0002_r2_guardrails.ts), out of
// push's purview. See .agents/memory/db-migrations-drizzle-push.md.
export const membershipsTable = pgTable("memberships", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id),
  firmId: uuid("firm_id").references(() => firmsTable.id),
  role: roleEnum("role").notNull(),
  clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
  buyerPartyId: uuid("buyer_party_id").references(() => partiesTable.id),
  createdAt: createdAt(),
});

export const insertFirmSchema = createInsertSchema(firmsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertMembershipSchema = createInsertSchema(membershipsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertFirm = z.infer<typeof insertFirmSchema>;
export type Firm = typeof firmsTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof membershipsTable.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
