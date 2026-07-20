import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  usersTable,
  staffNotificationPreferencesTable,
} from "@workspace/db";
import staffRouter from "./staff.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Staff notification preferences: self-service on the caller's OWN row for
// the CURRENT firm — the key is (userId, firmId), both from the principal —
// opt-in defaults (everything off), firm members only. The role gate is
// explicit — firm_admin/firm_staff — because this is not a capability-matrix
// surface: nothing here touches anyone else's data.

const SALT = makeRunSalt();
const firmId = randomUUID();
const firm2Id = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();

type PrefsBody = {
  digestEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  email: string | null;
};

function principalFor(
  role: Principal["role"],
  userId: string,
  firm: string = firmId,
): Principal {
  return {
    userId,
    role,
    firmId: firm,
    clientPartyId: role === "client_user" ? randomUUID() : null,
    buyerPartyId: null,
  };
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Staff Prefs Firm ${SALT}` },
    { id: firm2Id, name: `Staff Prefs Firm B ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: adminId, email: `staff-prefs-admin-${SALT}@test.example` },
    { id: staffId, email: `staff-prefs-staff-${SALT}@test.example` },
  ]);
});

after(async () => {
  await closeAllServers();
  const db = getDb();
  await db
    .delete(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.firmId, firmId));
  await db
    .delete(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.firmId, firm2Id));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  await db.delete(firmsTable).where(eq(firmsTable.id, firmId));
  await db.delete(firmsTable).where(eq(firmsTable.id, firm2Id));
});

test("GET returns the all-off defaults for a member who never saved", async () => {
  const base = await listen(appFor(principalFor("firm_admin", adminId), staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`);
  assert.equal(res.status, 200);
  const prefs = (await res.json()) as PrefsBody;
  assert.deepEqual(prefs, {
    digestEnabled: false,
    emailEnabled: false,
    pushEnabled: false,
    email: null,
  });
});

test("PUT upserts the caller's own row and partial input merges", async () => {
  const base = await listen(appFor(principalFor("firm_staff", staffId), staffRouter));

  // First save: opt in to the digest by email.
  const first = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: true,
      email: `me-${SALT}@test.example`,
    }),
  });
  assert.equal(first.status, 200);
  const saved = (await first.json()) as PrefsBody;
  assert.deepEqual(saved, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: false, // untouched switch keeps its default
    email: `me-${SALT}@test.example`,
  });

  // Partial update: only pushEnabled — everything else must survive.
  const second = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ pushEnabled: true }),
  });
  assert.equal(second.status, 200);
  const merged = (await second.json()) as PrefsBody;
  assert.deepEqual(merged, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: true,
    email: `me-${SALT}@test.example`,
  });

  // GET reads the saved state back.
  const read = await fetch(`${base}/staff/notification-preferences`);
  assert.deepEqual((await read.json()) as PrefsBody, merged);

  // Explicit null clears the address; omitted email would have kept it.
  const cleared = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as PrefsBody).email, null);

  // One row, pinned to the principal (userId never comes from input).
  const rows = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.userId, staffId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firmId, firmId);
});

test("a malformed email is rejected with 400", async () => {
  const base = await listen(appFor(principalFor("firm_admin", adminId), staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: "not-an-address" }),
  });
  assert.equal(res.status, 400);
});

test("client_user (and other non-staff roles) are rejected with 403", async () => {
  for (const role of ["client_user", "operator", "buyer_user"] as const) {
    const base = await listen(appFor(principalFor(role, randomUUID()), staffRouter));
    const get = await fetch(`${base}/staff/notification-preferences`);
    assert.equal(get.status, 403, `${role} GET must be rejected`);
    const put = await fetch(`${base}/staff/notification-preferences`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ digestEnabled: true }),
    });
    assert.equal(put.status, 403, `${role} PUT must be rejected`);
  }
});

test("a firm member without a tenant firm is rejected", async () => {
  const principal: Principal = {
    userId: adminId,
    role: "firm_admin",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
  const base = await listen(appFor(principal, staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`);
  assert.equal(res.status, 403);
});

test("a multi-firm member saves preferences per firm independently (composite key)", async () => {
  // Same user, two tenants: the row key is (userId, firmId), so firm B's
  // save must neither collide with nor clobber the firm-A row, and each
  // firm's GET reads its own state.
  const baseA = await listen(appFor(principalFor("firm_staff", staffId), staffRouter));
  const baseB = await listen(
    appFor(principalFor("firm_staff", staffId, firm2Id), staffRouter),
  );

  // Full payload (not a partial merge): the earlier test already saved a
  // firm-A row for this user, so pin every field to a known state.
  const savedA = await fetch(`${baseA}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: false,
      pushEnabled: true,
      email: null,
    }),
  });
  assert.equal(savedA.status, 200);

  const savedB = await fetch(`${baseB}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: true,
      email: `firm-b-${SALT}@test.example`,
    }),
  });
  assert.equal(savedB.status, 200, "firm B's save must not 500 on firm A's row");
  const bodyB = (await savedB.json()) as PrefsBody;
  assert.deepEqual(bodyB, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: false, // firm A's pushEnabled must not bleed into firm B
    email: `firm-b-${SALT}@test.example`,
  });

  // Each firm context reads back ITS OWN row.
  const readA = (await (
    await fetch(`${baseA}/staff/notification-preferences`)
  ).json()) as PrefsBody;
  assert.deepEqual(readA, {
    digestEnabled: true,
    emailEnabled: false,
    pushEnabled: true,
    email: null,
  });

  // Two independent rows, one per firm, both pinned to the principal.
  const rows = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.userId, staffId));
  const byFirm = new Map(rows.map((r) => [r.firmId, r]));
  assert.ok(byFirm.get(firmId), "firm A row exists");
  assert.ok(byFirm.get(firm2Id), "firm B row exists");
  assert.equal(byFirm.get(firmId)!.pushEnabled, true);
  assert.equal(byFirm.get(firm2Id)!.pushEnabled, false);
  assert.equal(byFirm.get(firm2Id)!.email, `firm-b-${SALT}@test.example`);
});
