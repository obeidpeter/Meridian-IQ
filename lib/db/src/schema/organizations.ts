import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partiesTable } from "./parties";

// The accounting firm is the tenant root (CON-01). White-label theming (CON-05).
export const firmsTable = pgTable("firms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subdomain: text("subdomain").unique(),
  // Clerk organization id, wired by the frontend auth layer.
  clerkOrgId: text("clerk_org_id").unique(),
  // The firm's own Party record (professional firms are inside the compliance net).
  partyId: uuid("party_id").references(() => partiesTable.id),
  theme: jsonb("theme").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").unique(),
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Role-permission matrix (Appendix C). bank_user is dormant until R4.
export const roleEnum = pgEnum("role", [
  "firm_admin",
  "firm_staff",
  "client_user",
  "operator",
  "bank_user",
  "auditor",
]);

// A user's role binding. firm-scoped roles carry a firmId; MeridianIQ staff
// (operator, auditor) and bank users are cross-tenant and may have a null firmId.
// client_user additionally scopes to a single client Party.
export const membershipsTable = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    firmId: uuid("firm_id").references(() => firmsTable.id),
    role: roleEnum("role").notNull(),
    clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.userId, t.firmId, t.role, t.clientPartyId)],
);

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
