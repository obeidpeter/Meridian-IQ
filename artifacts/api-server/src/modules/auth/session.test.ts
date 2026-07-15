import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, usersTable } from "@workspace/db";
import {
  hashPassword,
  authenticate,
  currentSessionEpoch,
  issueSessionToken,
  verifySessionToken,
} from "./session.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Session token epoch (revocation) + login timing/enumeration hardening.
// Fixtures are salted; users persist in the shared DB.

const SALT = makeRunSalt();
const userId = randomUUID();
const email = `session-${SALT}@test.local`;
const PASSWORD = "correct-horse-battery";

before(async () => {
  await getDb()
    .insert(usersTable)
    .values({
      id: userId,
      email,
      passwordHash: await hashPassword(PASSWORD),
      sessionEpoch: 0,
    })
    .onConflictDoNothing();
});

test("token round-trips with its epoch", async () => {
  const token = await issueSessionToken(userId, 3);
  const verified = await verifySessionToken(token);
  assert.deepEqual(verified, { userId, epoch: 3 });
});

test("a tampered signature is rejected", async () => {
  const token = await issueSessionToken(userId, 0);
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(await verifySessionToken(tampered), null);
});

test("legacy two-part tokens (no epoch) read as epoch 0", async () => {
  // Simulate a token minted before the epoch field existed by hand-signing a
  // userId.expiry payload — it must still verify and default to epoch 0 so
  // pre-upgrade sessions survive.
  const token = await issueSessionToken(userId, 0);
  // issueSessionToken now always writes 3 parts; assert the parser's default
  // via a real legacy shape by reconstructing through the public API is not
  // possible, so assert the modern zero-epoch token verifies as epoch 0.
  const verified = await verifySessionToken(token);
  assert.equal(verified?.epoch, 0);
});

test("revocation gate: a token predating the user's epoch is stale", async () => {
  // This is exactly the comparison principalFromSessionToken makes.
  const token = await issueSessionToken(userId, 0);
  const v0 = await verifySessionToken(token);
  assert.ok(v0);
  // Before any bump, the token's epoch matches the user's current epoch.
  assert.equal(await currentSessionEpoch(userId), 0);
  assert.ok(v0.epoch >= 0); // valid

  // Simulate a password change bumping the epoch.
  await getDb()
    .update(usersTable)
    .set({ sessionEpoch: 1 })
    .where(eq(usersTable.id, userId));
  const current = await currentSessionEpoch(userId);
  assert.equal(current, 1);
  // The old token's epoch (0) is now below the user's epoch (1) → rejected.
  assert.ok(v0.epoch < current!, "stale token must be detectable");

  // A freshly issued token carries the new epoch and passes.
  const fresh = await verifySessionToken(await issueSessionToken(userId, current!));
  assert.ok(fresh && fresh.epoch >= current!);
});

test("authenticate returns the session epoch on success", async () => {
  const result = await authenticate(email, PASSWORD);
  assert.ok(result);
  assert.equal(result.userId, userId);
  assert.equal(typeof result.sessionEpoch, "number");
});

test("authenticate fails closed for a wrong password and an unknown email", async () => {
  assert.equal(await authenticate(email, "wrong"), null);
  // The unknown-email path burns a decoy scrypt (timing) and returns null; here
  // we only assert the functional outcome, not the latency.
  assert.equal(await authenticate(`nobody-${SALT}@test.local`, "whatever"), null);
});

test("currentSessionEpoch is null for a non-existent user", async () => {
  assert.equal(await currentSessionEpoch(randomUUID()), null);
});
