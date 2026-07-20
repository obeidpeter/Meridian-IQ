import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";
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
  // Session-invalidation epoch (SEC-02). Signed into every issued session token;
  // bumped on password change so previously-issued tokens (which carry the old
  // epoch) stop resolving to a principal — the compromise-remediation path that
  // a stateless HMAC token would otherwise leave open until its 7-day expiry.
  sessionEpoch: integer("session_epoch").notNull().default(0),
  // TOTP two-factor (opt-in, modules/auth/totp.ts). The base32 secret is
  // stored at setup time with totpEnabledAt NULL (pending enrolment — not yet
  // enforced at login); activation with a valid code stamps totpEnabledAt.
  // These are user-keyed columns on a table with no tenant key, so no RLS
  // policy is involved — the login/challenge paths read them pre-tenant.
  totpSecret: text("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  // sha256 hex hashes of the one-time recovery codes (shown once at setup);
  // a redeemed code is removed, so length = codes remaining.
  totpRecoveryCodes: jsonb("totp_recovery_codes").$type<string[]>(),
  // The last 30s step a TOTP code was accepted for (challenge/activate), so a
  // sniffed code cannot be replayed within its own validity window (RFC 6238
  // §5.2: a verified code must be accepted at most once).
  totpLastUsedStep: integer("totp_last_used_step"),
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

// Self-serve onboarding (IDN-01). A firm_admin invites a new teammate or
// client into their OWN firm without operator provisioning. The raw token is
// shown once at creation and shared out-of-band; only its sha256 is stored, so
// the DB never holds a usable credential. Accepting creates the user +
// membership and consumes the invite (compare-and-set on status).
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
]);

export const passwordResetStatusEnum = pgEnum("password_reset_status", [
  "pending",
  "used",
  "revoked",
]);

// Operator-issued password recovery (IDN-02): the same single-use-secret
// posture as invitations — 32 random bytes shown once to the issuing
// operator, only the sha256 stored, redeemed at the public
// /auth/reset-password endpoint (the token IS the credential) via a
// compare-and-set on status. Bypass-only RLS (migration 0012): rows are
// touched only by the operator issue path and the public redeem context,
// never by firm principals.
export const passwordResetsTable = pgTable(
  "password_resets",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: passwordResetStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

export const invitationsTable = pgTable(
  "invitations",
  {
    id: id(),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    // Set only for client_user invitations (the client Party the invitee scopes to).
    clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_firm_idx").on(t.firmId)],
);

export type Invitation = typeof invitationsTable.$inferSelect;

// Per-staff-member notification preferences (self-service; one row per
// (user, firm) membership, written only by the /staff/notification-preferences
// routes with the userId taken from the principal and the firmId from the
// principal's current tenant). The composite key matters: RLS on this table
// is FIRM-keyed (migration 0019), so a multi-firm staff member must hold an
// independent row per firm — a userId-only key would make firm B's upsert
// collide with the firm-A row that firm B's RLS context cannot even see.
// OPT-IN: every switch defaults OFF — a firm member receives nothing until
// they turn a digest and at least one channel on themselves, which is why
// digest delivery needs no party consent gate (this is not the CORE-03
// client-alert model).
// WARNING: `email` is a free-text, UNVERIFIED address the member typed in.
// Today it is inert — digest delivery is pointer-only (SEC-12) and sends to
// the membership identity, never to this column — and it must NEVER become a
// send destination without an ownership-verification step first (an attacker
// with a staff session could otherwise route a firm's digest pointers to an
// arbitrary inbox).
export const staffNotificationPreferencesTable = pgTable(
  "staff_notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    digestEnabled: boolean("digest_enabled").notNull().default(false),
    emailEnabled: boolean("email_enabled").notNull().default(false),
    pushEnabled: boolean("push_enabled").notNull().default(false),
    email: text("email"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.firmId] }),
    // The digest delivery pass resolves a firm's opted-in staff in one scan.
    index("staff_notification_prefs_firm_idx").on(t.firmId),
  ],
);
export type StaffNotificationPreferencesRow =
  typeof staffNotificationPreferencesTable.$inferSelect;

export type Role = (typeof roleEnum.enumValues)[number];
