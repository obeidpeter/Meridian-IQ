import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  invitationsTable,
  usersTable,
  membershipsTable,
  engagementsTable,
  type Invitation,
  type Role,
} from "@workspace/db";
import { DomainError } from "../errors";
import { hashPassword } from "./session";
import { appendAudit } from "../audit/audit";
import type { Principal } from "./rbac";

// Self-serve onboarding (IDN-01).
//
// A firm_admin invites a teammate or client into its OWN firm without operator
// provisioning. The invite carries a single-use secret: 32 random bytes, shown
// once at creation and shared out-of-band. Only its sha256 is stored, so a DB
// read never yields a usable credential. Accepting is a public endpoint — the
// token IS the authentication — that creates the user + membership and consumes
// the invite via a compare-and-set on status, so a token cannot be redeemed
// twice even under a race.

// Roles a firm_admin may hand out. Cross-tenant/platform roles (operator,
// auditor, bank_user) and the buyer-rails role are never issued through the
// firm-scoped invite flow; the contract enum already narrows the input, and
// this is the defense-in-depth backstop.
const INVITABLE_ROLES = new Set<Role>(["firm_admin", "firm_staff", "client_user"]);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInvitationInput {
  email: string;
  role: Role;
  clientPartyId?: string | null;
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  fullName?: string | null;
}

// sha256 of the raw token; what we persist and look up by. Constant-length hex,
// so the unique index on token_hash never leaks token length.
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Drop the secret/bookkeeping columns (token_hash, invited_by_user_id) before a
// row leaves the service — the API Invitation shape is metadata only.
function invitationView(row: Invitation) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    firmId: row.firmId,
    clientPartyId: row.clientPartyId,
    status: row.status,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

export type InvitationView = ReturnType<typeof invitationView>;

// The firm a firm-scoped principal invites into. Cross-tenant staff (operator,
// auditor) carry no firm, so they cannot originate an invite through this
// self-serve path — they provision directly via identity.write instead.
function requireFirm(principal: Principal): string {
  if (!principal.firmId) {
    throw new DomainError(
      "NO_TENANT",
      "An invitation must be created within a firm",
      403,
    );
  }
  return principal.firmId;
}

export async function createInvitation(
  principal: Principal,
  input: CreateInvitationInput,
): Promise<{ invitation: InvitationView; token: string }> {
  const firmId = requireFirm(principal);
  const role = input.role;
  if (!INVITABLE_ROLES.has(role)) {
    throw new DomainError(
      "INVALID_ROLE",
      "That role cannot be assigned through an invitation",
      400,
    );
  }
  const email = input.email.trim().toLowerCase();

  // A client_user is scoped to one client Party, which must be a client the
  // firm actually engages (mirrors assertPartyAccess). Non-client roles carry
  // no party — reject a stray clientPartyId rather than silently dropping it.
  let clientPartyId: string | null = null;
  if (role === "client_user") {
    if (!input.clientPartyId) {
      throw new DomainError(
        "CLIENT_PARTY_REQUIRED",
        "A client invitation requires the client party it is scoped to",
        400,
      );
    }
    const [engagement] = await getDb()
      .select({ id: engagementsTable.id })
      .from(engagementsTable)
      .where(
        and(
          eq(engagementsTable.firmId, firmId),
          eq(engagementsTable.clientPartyId, input.clientPartyId),
        ),
      )
      .limit(1);
    if (!engagement) {
      throw new DomainError(
        "CLIENT_PARTY_NOT_ENGAGED",
        "That client party is not engaged by your firm",
        400,
      );
    }
    clientPartyId = input.clientPartyId;
  } else if (input.clientPartyId) {
    throw new DomainError(
      "CLIENT_PARTY_NOT_ALLOWED",
      "Only a client invitation may name a client party",
      400,
    );
  }

  // Inviting an email that already has an account is a dead invite — the
  // accept path refuses to overwrite an existing user (409) — so fail fast.
  const [existing] = await getDb()
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) {
    throw new DomainError(
      "EMAIL_IN_USE",
      "An account with this email already exists",
      409,
    );
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await getDb()
    .insert(invitationsTable)
    .values({
      email,
      role,
      firmId,
      clientPartyId,
      tokenHash: hashInviteToken(token),
      expiresAt,
      invitedByUserId: principal.userId,
    })
    .returning();
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "invitation.create",
    entityType: "invitation",
    entityId: row.id,
    after: { email, role, clientPartyId },
  });
  return { invitation: invitationView(row), token };
}

export async function listInvitations(
  principal: Principal,
): Promise<InvitationView[]> {
  // Firm-scoped principals are already narrowed to their firm by RLS; the
  // explicit filter is defense in depth and also scopes an operator (RLS-bypass)
  // to a chosen firm when one is bound. A firmless operator sees all.
  const base = getDb().select().from(invitationsTable);
  const rows = principal.firmId
    ? await base
        .where(eq(invitationsTable.firmId, principal.firmId))
        .orderBy(desc(invitationsTable.createdAt))
    : await base.orderBy(desc(invitationsTable.createdAt));
  return rows.map(invitationView);
}

// Revoke a still-pending invitation (compare-and-set on status). Returns null
// when there is no matching pending invite in scope — the route maps that to
// 404. An already-accepted or already-revoked invite is left untouched.
export async function revokeInvitation(
  principal: Principal,
  id: string,
): Promise<InvitationView | null> {
  const scope = principal.firmId
    ? and(
        eq(invitationsTable.id, id),
        eq(invitationsTable.firmId, principal.firmId),
        eq(invitationsTable.status, "pending"),
      )
    : and(eq(invitationsTable.id, id), eq(invitationsTable.status, "pending"));
  const [row] = await getDb()
    .update(invitationsTable)
    .set({ status: "revoked" })
    .where(scope)
    .returning();
  if (!row) return null;
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId: row.firmId,
    action: "invitation.revoke",
    entityType: "invitation",
    entityId: row.id,
  });
  return invitationView(row);
}

// Redeem a token: create the user + membership and consume the invite. Public
// (the token is the credential), so it runs in the RLS-bypass context that the
// invitations policy grants. The whole handler is one request transaction, so a
// failure at any step rolls the account creation back with the invite intact.
export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<void> {
  const tokenHash = hashInviteToken(input.token);
  const [invite] = await getDb()
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, tokenHash))
    .limit(1);
  // Uniform message for not-found / used / revoked / expired: never disclose
  // which invites exist or why a token is unusable.
  const invalid = () =>
    new DomainError("INVALID_INVITE", "Invalid or expired invitation", 400);
  if (!invite || invite.status !== "pending") throw invalid();
  if (invite.expiresAt.getTime() <= Date.now()) throw invalid();

  const email = invite.email.trim().toLowerCase();
  const [existing] = await getDb()
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) {
    // The email was claimed after the invite was issued. Refuse rather than
    // attach a new password/membership to an existing account (takeover guard).
    throw new DomainError(
      "EMAIL_IN_USE",
      "An account with this email already exists",
      409,
    );
  }

  // Claim the invite first (compare-and-set): if a concurrent accept already
  // flipped it out of "pending", we get zero rows and bail before creating a
  // duplicate account. The row lock the UPDATE takes serialises racing redeems.
  const claimed = await getDb()
    .update(invitationsTable)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(
      and(
        eq(invitationsTable.id, invite.id),
        eq(invitationsTable.status, "pending"),
      ),
    )
    .returning({ id: invitationsTable.id });
  if (claimed.length === 0) throw invalid();

  const [user] = await getDb()
    .insert(usersTable)
    .values({
      email,
      fullName: input.fullName?.trim() || null,
      passwordHash: hashPassword(input.password),
    })
    .returning({ id: usersTable.id });
  await getDb()
    .insert(membershipsTable)
    .values({
      userId: user.id,
      firmId: invite.firmId,
      role: invite.role,
      clientPartyId: invite.clientPartyId,
    });
  await appendAudit({
    actorId: user.id,
    firmId: invite.firmId,
    action: "invitation.accept",
    entityType: "invitation",
    entityId: invite.id,
    after: { userId: user.id, role: invite.role },
  });
}
