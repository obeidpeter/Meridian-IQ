import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  usersTable,
  membershipsTable,
  partiesTable,
  engagementsTable,
  clientAssignmentsTable,
} from "@workspace/db";
import accessRegisterRouter from "./access-register.ts";
import { appendAudit } from "../../modules/audit/audit.ts";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Lightweight access review (D14): the register is computed from what
// exists (memberships, auth.login audit events, TOTP state, assignments);
// attesting it records the register's hash on the audit chain, and a hash
// the register has moved away from is refused.
const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const admin = firmPrincipal(firmId, { role: "firm_admin", userId: adminId });
const staff = firmPrincipal(firmId, { role: "firm_staff", userId: staffId });

before(async () => {
  const db = getDb();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Review Firm ${SALT}` });
  await db.insert(usersTable).values([
    {
      id: adminId,
      email: `admin-${SALT}@test.local`,
      fullName: "Ada Admin",
      totpEnabledAt: new Date(),
    },
    { id: staffId, email: `staff-${SALT}@test.local`, fullName: "Sam Staff" },
  ]);
  await db.insert(membershipsTable).values([
    { userId: adminId, firmId, role: "firm_admin", clientPartyId: null },
    { userId: staffId, firmId, role: "firm_staff", clientPartyId: null },
  ]);
  await db.insert(partiesTable).values({
    id: clientId,
    type: "client_business",
    legalName: `Reviewed Client ${SALT}`,
    countryCode: "NG",
  });
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientId,
    type: "retainer",
    status: "in_progress",
    title: "R",
  });
  await db.insert(clientAssignmentsTable).values({
    firmId,
    clientPartyId: clientId,
    userId: staffId,
    assignedBy: adminId,
  });
  await appendAudit({
    actorId: adminId,
    actorRole: "firm_admin",
    firmId,
    action: "auth.login",
    entityType: "user",
    entityId: adminId,
    after: { role: "firm_admin" },
  });
});

after(async () => {
  await closeAllServers();
});

test("the register reports role, MFA, last sign-in and assignments; attesting lands on the chain; a stale hash is refused", async () => {
  const base = await listen(appFor(admin, accessRegisterRouter));
  const first = await fetch(`${base}/console/access-register`);
  assert.equal(first.status, 200);
  const register = (await first.json()) as {
    hash: string;
    members: {
      userId: string;
      role: string;
      mfaEnabled: boolean;
      lastSignInAt: string | null;
      assignedClients: string[];
    }[];
    lastAttestation: null | {
      hash: string;
      byUserId: string;
      memberCount: number;
    };
  };
  assert.equal(register.lastAttestation, null);
  const adminRow = register.members.find((m) => m.userId === adminId);
  const staffRow = register.members.find((m) => m.userId === staffId);
  assert.ok(adminRow && staffRow);
  assert.equal(adminRow.mfaEnabled, true);
  assert.ok(adminRow.lastSignInAt, "the login audit event is the last sign-in");
  assert.equal(staffRow.mfaEnabled, false);
  assert.equal(staffRow.lastSignInAt, null);
  assert.deepEqual(staffRow.assignedClients, [`Reviewed Client ${SALT}`]);

  // The hash is stable across reads when nothing moved.
  const again = (await (
    await fetch(`${base}/console/access-register`)
  ).json()) as { hash: string };
  assert.equal(again.hash, register.hash);

  const stale = await fetch(`${base}/console/access-register/attest`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ hash: "deadbeef" }),
  });
  assert.equal(stale.status, 409);

  const ok = await fetch(`${base}/console/access-register/attest`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ hash: register.hash }),
  });
  assert.equal(ok.status, 201);
  const attestation = (await ok.json()) as {
    hash: string;
    byUserId: string;
    memberCount: number;
    byName: string | null;
  };
  assert.equal(attestation.hash, register.hash);
  assert.equal(attestation.byUserId, adminId);
  assert.equal(attestation.memberCount, 2);
  assert.equal(attestation.byName, "Ada Admin");

  const after = (await (
    await fetch(`${base}/console/access-register`)
  ).json()) as {
    lastAttestation: {
      hash: string;
      byUserId: string;
      memberCount: number;
    } | null;
  };
  assert.equal(after.lastAttestation?.hash, register.hash);
  assert.equal(after.lastAttestation?.byUserId, adminId);

  // Moving the register (an assignment change) invalidates the attested hash.
  await getDb()
    .delete(clientAssignmentsTable)
    .where(
      (await import("drizzle-orm")).eq(clientAssignmentsTable.userId, staffId),
    );
  const moved = (await (
    await fetch(`${base}/console/access-register`)
  ).json()) as { hash: string };
  assert.notEqual(moved.hash, register.hash);

  const csv = await fetch(`${base}/console/access-register/csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const text = await csv.text();
  assert.match(text, /user_id,full_name,email,role/);
  assert.match(text, new RegExp(`admin-${SALT}@test.local`));
});

test("firm staff cannot read or attest the register", async () => {
  const base = await listen(appFor(staff, accessRegisterRouter));
  assert.equal((await fetch(`${base}/console/access-register`)).status, 403);
  const attempt = await fetch(`${base}/console/access-register/attest`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ hash: "x" }),
  });
  assert.equal(attempt.status, 403);
});
