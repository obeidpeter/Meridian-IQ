import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  usersTable,
  passwordResetsTable,
} from "@workspace/db";
import identityRouter from "./identity.ts";
import authRouter from "./auth.ts";
import { sweepExpiredPasswordResets } from "../modules/auth/password-reset.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { verifyPassword, hashPassword } from "../modules/auth/session.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Operator-assisted password recovery (IDN-02), on the invitation rail's
// posture: the raw token is returned once and only its sha256 stored;
// redeeming is public, single-use (compare-and-set), sets the password and
// bumps the session epoch so outstanding sessions die. The bypass-only RLS
// policy itself is covered by the migration rollback test.

const SALT = makeRunSalt();

const operatorUserId = randomUUID();
const subjectUserId = randomUUID();
const subjectEmail = `lost-access-${SALT}@test.local`;

const operator: Principal = {
  userId: operatorUserId,
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

const firmAdmin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: randomUUID(),
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
    .values({ id: operatorUserId, email: `reset-op-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(usersTable).values({
    id: subjectUserId,
    email: subjectEmail,
    passwordHash: hashPassword("original-pw-123"),
  });
});

async function issueReset(
  base: string,
  email: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/password-resets`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test("an operator issues a reset link; only the token's hash is stored", async () => {
  const base = await listen(appFor(operator, identityRouter));
  const { status, json } = await issueReset(base, subjectEmail.toUpperCase());
  assert.equal(status, 201);

  const token = json.token as string;
  assert.match(token, /^[0-9a-f]{64}$/, "raw token is 32 bytes of hex");
  const reset = json.reset as Record<string, unknown>;
  assert.equal(reset.email, subjectEmail, "email is normalised");
  assert.equal(reset.status, "pending");

  const [row] = await getDb()
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.id, reset.id as string))
    .limit(1);
  assert.equal(
    row.tokenHash,
    createHash("sha256").update(token).digest("hex"),
    "DB holds sha256(token), not the token",
  );
  assert.equal(row.issuedByUserId, operatorUserId);

  // Issuing again revokes the earlier pending link (one live link per user).
  const second = await issueReset(base, subjectEmail);
  assert.equal(second.status, 201);
  const [first] = await getDb()
    .select({ status: passwordResetsTable.status })
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.id, reset.id as string))
    .limit(1);
  assert.equal(first.status, "revoked", "superseded link is revoked");
});

test("issuing requires identity.write and an existing account", async () => {
  const asAdmin = await listen(appFor(firmAdmin, identityRouter));
  const forbidden = await issueReset(asAdmin, subjectEmail);
  assert.equal(forbidden.status, 403, "firm admins stay on the invite flow");

  const asOperator = await listen(appFor(operator, identityRouter));
  const unknown = await issueReset(asOperator, `nobody-${SALT}@test.local`);
  assert.equal(unknown.status, 404);
});

test("redeeming sets the password, revokes sessions, and is single-use", async () => {
  const identityBase = await listen(appFor(operator, identityRouter));
  const authBase = await listen(appFor(operator, authRouter));

  const [beforeUser] = await getDb()
    .select({ sessionEpoch: usersTable.sessionEpoch })
    .from(usersTable)
    .where(eq(usersTable.id, subjectUserId))
    .limit(1);

  const issued = await issueReset(identityBase, subjectEmail);
  const token = issued.json.token as string;

  const redeem = await fetch(`${authBase}/auth/reset-password`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password: "brand-new-pw-456" }),
  });
  assert.equal(redeem.status, 204);

  const [user] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, subjectUserId))
    .limit(1);
  assert.ok(
    user.passwordHash && verifyPassword("brand-new-pw-456", user.passwordHash),
    "new password is set and verifiable",
  );
  assert.ok(
    !verifyPassword("original-pw-123", user.passwordHash!),
    "old password no longer verifies",
  );
  assert.equal(
    user.sessionEpoch,
    beforeUser.sessionEpoch + 1,
    "session epoch bumped: outstanding tokens die (SEC-02)",
  );

  const resetId = (issued.json.reset as Record<string, unknown>).id as string;
  const [row] = await getDb()
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.id, resetId))
    .limit(1);
  assert.equal(row.status, "used");
  assert.ok(row.usedAt, "usedAt stamped");

  // Single-use: replaying the same token is a uniform 400.
  const replay = await fetch(`${authBase}/auth/reset-password`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password: "yet-another-pw-789" }),
  });
  assert.equal(replay.status, 400);
});

test("expired and unknown tokens are a uniform 400", async () => {
  const authBase = await listen(appFor(operator, authRouter));

  // Insert an already-expired pending reset directly (salted token so reruns
  // against the same scratch DB never collide on the unique hash).
  const expiredToken = createHash("sha256")
    .update(`expired-${SALT}`)
    .digest("hex");
  await getDb().insert(passwordResetsTable).values({
    userId: subjectUserId,
    tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
    expiresAt: new Date(Date.now() - 60_000),
    issuedByUserId: operatorUserId,
  });
  const expired = await fetch(`${authBase}/auth/reset-password`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: expiredToken, password: "irrelevant-pw-1" }),
  });
  assert.equal(expired.status, 400);

  const unknown = await fetch(`${authBase}/auth/reset-password`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: "f".repeat(64), password: "irrelevant-pw-2" }),
  });
  assert.equal(unknown.status, 400);
});

test("the retention sweep prunes only dead resets past the 30-day window", async () => {
  const db = getDb();
  const monthAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const hashOf = (label: string) =>
    createHash("sha256").update(`retention-${label}-${SALT}`).digest("hex");

  const inserted = await db
    .insert(passwordResetsTable)
    .values([
      {
        // Consumed a month ago: past retention, prunable.
        userId: subjectUserId,
        tokenHash: hashOf("used"),
        status: "used",
        expiresAt: new Date(monthAgo.getTime() + 60_000),
        usedAt: monthAgo,
        createdAt: monthAgo,
        issuedByUserId: operatorUserId,
      },
      {
        // Never redeemed, expired a month ago: prunable.
        userId: subjectUserId,
        tokenHash: hashOf("expired"),
        expiresAt: new Date(monthAgo.getTime() + 60_000),
        createdAt: monthAgo,
        issuedByUserId: operatorUserId,
      },
      {
        // Freshly issued and still live: must survive.
        userId: subjectUserId,
        tokenHash: hashOf("fresh"),
        expiresAt: new Date(Date.now() + 60_000),
        issuedByUserId: operatorUserId,
      },
    ])
    .returning({ id: passwordResetsTable.id, tokenHash: passwordResetsTable.tokenHash });
  assert.equal(inserted.length, 3);

  await sweepExpiredPasswordResets();

  const survivors = new Set(
    (
      await db
        .select({ tokenHash: passwordResetsTable.tokenHash })
        .from(passwordResetsTable)
        .where(eq(passwordResetsTable.userId, subjectUserId))
    ).map((r) => r.tokenHash),
  );
  assert.ok(!survivors.has(hashOf("used")), "old used reset is pruned");
  assert.ok(!survivors.has(hashOf("expired")), "old expired reset is pruned");
  assert.ok(survivors.has(hashOf("fresh")), "live pending reset survives");
});
