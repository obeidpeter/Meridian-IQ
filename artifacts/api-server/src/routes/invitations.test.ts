import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  membershipsTable,
  engagementsTable,
  invitationsTable,
} from "@workspace/db";
import invitationsRouter from "./invitations.ts";
import authRouter from "./auth.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { verifyPassword } from "../modules/auth/session.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Self-serve invite flow (IDN-01). The route harness runs getDb() on the raw
// pool (no RLS), so these pin the module's app-layer behaviour: firmId is forced
// to the inviter's firm, the raw token is returned once and only its sha256 is
// stored, client invites must name an engaged party, an existing email is
// refused, and redeeming is a single-use compare-and-set that provisions the
// user + membership. The firm-keyed RLS policy itself is covered by the
// migration rollback test.

const SALT = makeRunSalt();

const adminUserId = randomUUID();
const firmId = randomUUID();
const engagedClientId = randomUUID();
const strayClientId = randomUUID();
const takenEmail = `taken-${SALT}@test.local`;

const admin: Principal = {
  userId: adminUserId,
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};

after(async () => {
  await closeAllServers();
});

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: adminUserId, email: `admin-${SALT}@test.local` })
    .onConflictDoNothing();
  // An unrelated account that already owns `takenEmail` (email-in-use path).
  await db
    .insert(usersTable)
    .values({ email: takenEmail })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Invite Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: engagedClientId,
      type: "client_business",
      legalName: `Engaged Client ${SALT}`,
      tin: "30000000-0071",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: strayClientId,
      type: "client_business",
      legalName: `Stray Client ${SALT}`,
      tin: "30000000-0072",
      street: "2 Marina Rd",
      city: "Lagos",
    },
  ]);
  // Only engagedClientId is actually engaged by the firm.
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: engagedClientId,
    type: "retainer",
    title: `Engagement ${SALT}`,
  });
});

async function createInvite(
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/invitations`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("creates a firm_staff invitation, returns a one-time token, stores only its hash", async () => {
  const base = await listen(appFor(admin, invitationsRouter));
  const email = `Staff-${SALT}@Test.Local`;
  const { status, json } = await createInvite(base, { email, role: "firm_staff" });
  assert.equal(status, 201);

  const token = json.token as string;
  assert.match(token, /^[0-9a-f]{64}$/, "raw token is 32 bytes of hex");
  const invitation = json.invitation as Record<string, unknown>;
  assert.equal(invitation.email, email.toLowerCase(), "email is normalised");
  assert.equal(invitation.role, "firm_staff");
  assert.equal(invitation.firmId, firmId, "firmId forced to the inviter's firm");
  assert.equal(invitation.status, "pending");
  assert.equal(invitation.clientPartyId, null);
  assert.equal(
    (invitation as Record<string, unknown>).tokenHash,
    undefined,
    "the stored hash never leaves the service",
  );

  const [row] = await getDb()
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.id, invitation.id as string))
    .limit(1);
  assert.equal(
    row.tokenHash,
    createHash("sha256").update(token).digest("hex"),
    "DB holds sha256(token), not the token",
  );
  assert.equal(row.invitedByUserId, adminUserId);
});

test("a client invitation requires an engaged client party", async () => {
  const base = await listen(appFor(admin, invitationsRouter));

  // Missing party.
  const missing = await createInvite(base, {
    email: `c1-${SALT}@test.local`,
    role: "client_user",
  });
  assert.equal(missing.status, 400);

  // A party the firm does not engage.
  const stray = await createInvite(base, {
    email: `c2-${SALT}@test.local`,
    role: "client_user",
    clientPartyId: strayClientId,
  });
  assert.equal(stray.status, 400);

  // The engaged party succeeds and is recorded on the invite.
  const ok = await createInvite(base, {
    email: `c3-${SALT}@test.local`,
    role: "client_user",
    clientPartyId: engagedClientId,
  });
  assert.equal(ok.status, 201);
  assert.equal(
    (ok.json.invitation as Record<string, unknown>).clientPartyId,
    engagedClientId,
  );
});

test("a non-client role may not name a client party", async () => {
  const base = await listen(appFor(admin, invitationsRouter));
  const { status } = await createInvite(base, {
    email: `staff2-${SALT}@test.local`,
    role: "firm_staff",
    clientPartyId: engagedClientId,
  });
  assert.equal(status, 400);
});

test("inviting an email that already has an account is refused", async () => {
  const base = await listen(appFor(admin, invitationsRouter));
  const { status } = await createInvite(base, {
    email: takenEmail,
    role: "firm_staff",
  });
  assert.equal(status, 409);
});

test("lists the firm's invitations and revokes a pending one (404 on repeat)", async () => {
  const base = await listen(appFor(admin, invitationsRouter));
  const created = await createInvite(base, {
    email: `revoke-${SALT}@test.local`,
    role: "firm_staff",
  });
  const id = (created.json.invitation as Record<string, unknown>).id as string;

  const list = (await (await fetch(`${base}/invitations`)).json()) as Array<
    Record<string, unknown>
  >;
  assert.ok(
    list.some((i) => i.id === id),
    "created invite appears in the firm list",
  );
  assert.ok(
    list.every((i) => i.firmId === firmId),
    "list is scoped to the firm",
  );

  const revoked = await fetch(`${base}/invitations/${id}/revoke`, {
    method: "POST",
  });
  assert.equal(revoked.status, 200);
  assert.equal(
    ((await revoked.json()) as Record<string, unknown>).status,
    "revoked",
  );

  // Already-revoked: nothing pending to revoke -> 404.
  const again = await fetch(`${base}/invitations/${id}/revoke`, {
    method: "POST",
  });
  assert.equal(again.status, 404);
});

test("redeeming a token provisions the user + membership and is single-use", async () => {
  const inviteBase = await listen(appFor(admin, invitationsRouter));
  const authBase = await listen(appFor(admin, authRouter));

  const email = `accept-${SALT}@test.local`;
  const created = await createInvite(inviteBase, {
    email,
    role: "client_user",
    clientPartyId: engagedClientId,
  });
  const token = created.json.token as string;
  const inviteId = (created.json.invitation as Record<string, unknown>).id as string;

  const accept = await fetch(`${authBase}/auth/accept-invite`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password: "sup3r-secret-pw", fullName: "  Ada Lovelace  " }),
  });
  assert.equal(accept.status, 204);

  const [user] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  assert.ok(user, "user was created");
  assert.equal(user.fullName, "Ada Lovelace", "full name trimmed");
  assert.ok(
    user.passwordHash && verifyPassword("sup3r-secret-pw", user.passwordHash),
    "password is set and verifiable",
  );

  const [membership] = await getDb()
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id))
    .limit(1);
  assert.ok(membership, "membership was created");
  assert.equal(membership.firmId, firmId);
  assert.equal(membership.role, "client_user");
  assert.equal(membership.clientPartyId, engagedClientId);

  const [inv] = await getDb()
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.id, inviteId))
    .limit(1);
  assert.equal(inv.status, "accepted", "invite consumed");
  assert.ok(inv.acceptedAt, "acceptedAt stamped");

  // Single-use: the same token cannot be redeemed twice.
  const replay = await fetch(`${authBase}/auth/accept-invite`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password: "another-pw-123" }),
  });
  assert.equal(replay.status, 400);
});

test("redeeming an unknown token is a generic 400", async () => {
  const authBase = await listen(appFor(admin, authRouter));
  const res = await fetch(`${authBase}/auth/accept-invite`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: "deadbeef".repeat(8), password: "whatever-123" }),
  });
  assert.equal(res.status, 400);
});

// ---- Operator-issued invitations (new-firm bootstrap) -----------------------
// An operator carries no firm, so it names the target firm explicitly; the
// invited firm_admin then self-serves the rest of the firm through the
// ordinary IDN-01 flow.

const operatorUserId = randomUUID();
const operator: Principal = {
  userId: operatorUserId,
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

test("an operator bootstraps a new firm's first admin via a targeted invite", async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: operatorUserId, email: `operator-${SALT}@test.local` })
    .onConflictDoNothing();
  const newFirmId = randomUUID();
  await db
    .insert(firmsTable)
    .values({ id: newFirmId, name: `Bootstrap Firm ${SALT}` });

  const inviteBase = await listen(appFor(operator, invitationsRouter));
  const authBase = await listen(appFor(operator, authRouter));

  const email = `first-admin-${SALT}@test.local`;
  const { status, json } = await createInvite(inviteBase, {
    email,
    role: "firm_admin",
    firmId: newFirmId,
  });
  assert.equal(status, 201);
  const invitation = json.invitation as Record<string, unknown>;
  assert.equal(invitation.firmId, newFirmId, "invite targets the named firm");
  assert.equal(invitation.role, "firm_admin");

  const accept = await fetch(`${authBase}/auth/accept-invite`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: json.token, password: "first-admin-pw-1" }),
  });
  assert.equal(accept.status, 204);

  const [user] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  assert.ok(user, "first admin user was created");
  const [membership] = await getDb()
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id))
    .limit(1);
  assert.equal(membership.firmId, newFirmId, "membership lands in the new firm");
  assert.equal(membership.role, "firm_admin");
});

test("an operator invitation must name an existing firm", async () => {
  const base = await listen(appFor(operator, invitationsRouter));

  const missing = await createInvite(base, {
    email: `no-firm-${SALT}@test.local`,
    role: "firm_staff",
  });
  assert.equal(missing.status, 400, "firmId is required for an operator");

  const unknown = await createInvite(base, {
    email: `ghost-firm-${SALT}@test.local`,
    role: "firm_staff",
    firmId: randomUUID(),
  });
  assert.equal(unknown.status, 404, "the named firm must exist");
});

test("a firm principal may not target another firm (own firm is fine)", async () => {
  const db = getDb();
  const otherFirmId = randomUUID();
  await db
    .insert(firmsTable)
    .values({ id: otherFirmId, name: `Other Firm ${SALT}` });

  const base = await listen(appFor(admin, invitationsRouter));

  const foreign = await createInvite(base, {
    email: `poacher-${SALT}@test.local`,
    role: "firm_staff",
    firmId: otherFirmId,
  });
  assert.equal(foreign.status, 403, "a foreign firmId is rejected, not rewritten");

  const own = await createInvite(base, {
    email: `own-firm-${SALT}@test.local`,
    role: "firm_staff",
    firmId,
  });
  assert.equal(own.status, 201, "naming the caller's own firm is a no-op");
  assert.equal(
    (own.json.invitation as Record<string, unknown>).firmId,
    firmId,
  );
});
