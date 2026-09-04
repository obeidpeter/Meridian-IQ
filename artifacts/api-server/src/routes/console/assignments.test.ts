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
  auditEventsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import portfolioRouter from "./portfolio.ts";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Per-staff client assignment (D12): a firm-admin write that narrows default
// views — assignees must be members of THIS firm, the client must be one the
// firm engages, every change is audited, and the portfolio list carries the
// assignee ids so the console can partition without a second call.
const SALT = makeRunSalt();
const firmId = randomUUID();
const otherFirmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const outsiderId = randomUUID();
const admin = firmPrincipal(firmId, { role: "firm_admin", userId: adminId });
const staff = firmPrincipal(firmId, { role: "firm_staff", userId: staffId });

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Assign Firm ${SALT}` },
    { id: otherFirmId, name: `Other Firm ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: adminId, email: `admin-${SALT}@test.local`, fullName: "Ada Admin" },
    { id: staffId, email: `staff-${SALT}@test.local`, fullName: "Sam Staff" },
    { id: outsiderId, email: `out-${SALT}@test.local`, fullName: "Olu Other" },
  ]);
  await db.insert(membershipsTable).values([
    { userId: adminId, firmId, role: "firm_admin", clientPartyId: null },
    { userId: staffId, firmId, role: "firm_staff", clientPartyId: null },
    {
      userId: outsiderId,
      firmId: otherFirmId,
      role: "firm_staff",
      clientPartyId: null,
    },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business",
      legalName: `Client A ${SALT}`,
      countryCode: "NG",
    },
    {
      id: clientB,
      type: "client_business",
      legalName: `Client B ${SALT}`,
      countryCode: "NG",
    },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId,
      clientPartyId: clientA,
      type: "retainer",
      status: "in_progress",
      title: "A",
    },
    {
      firmId: otherFirmId,
      clientPartyId: clientB,
      type: "retainer",
      status: "in_progress",
      title: "B",
    },
  ]);
});

after(async () => {
  await closeAllServers();
});

test("a firm admin replaces the assignee set; adds and removals land on the audit chain", async () => {
  const base = await listen(appFor(admin, portfolioRouter));
  let version = (
    (await (
      await fetch(`${base}/console/clients/${clientA}/assignments`)
    ).json()) as { version: string }
  ).version;
  const put = async (userIds: string[]) => {
    const response = await fetch(
      `${base}/console/clients/${clientA}/assignments`,
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ userIds, expectedVersion: version }),
      },
    );
    if (response.ok) {
      version = ((await response.clone().json()) as { version: string })
        .version;
    }
    return response;
  };
  const first = await put([staffId, adminId]);
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    assignees: { userId: string; role: string }[];
  };
  assert.deepEqual(
    firstBody.assignees.map((a) => a.userId).sort(),
    [adminId, staffId].sort(),
  );
  const second = await put([staffId]);
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as {
    assignees: { userId: string }[];
  };
  assert.deepEqual(
    secondBody.assignees.map((a) => a.userId),
    [staffId],
  );

  const events = await getDb()
    .select({
      action: auditEventsTable.action,
      entityId: auditEventsTable.entityId,
    })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.entityId, clientA))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(5);
  const actions = events.map((e) => e.action).sort();
  assert.deepEqual(actions, [
    "client.assign",
    "client.assign",
    "client.unassign",
  ]);

  const list = await fetch(`${base}/console/clients/${clientA}/assignments`);
  assert.equal(list.status, 200);
  const portfolio = await fetch(`${base}/console/portfolio`);
  const summary = (await portfolio.json()) as {
    clients: { clientPartyId: string; assignedUserIds?: string[] }[];
  };
  const row = summary.clients.find((c) => c.clientPartyId === clientA);
  assert.deepEqual(row?.assignedUserIds, [staffId]);
});

test("assignees must belong to the firm; staff may read but not write; foreign clients are 404", async () => {
  const adminBase = await listen(appFor(admin, portfolioRouter));
  const current = (await (
    await fetch(`${adminBase}/console/clients/${clientA}/assignments`)
  ).json()) as { version: string };
  const stranger = await fetch(
    `${adminBase}/console/clients/${clientA}/assignments`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        userIds: [outsiderId],
        expectedVersion: current.version,
      }),
    },
  );
  assert.equal(stranger.status, 400);
  const foreign = await fetch(
    `${adminBase}/console/clients/${clientB}/assignments`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        userIds: [staffId],
        expectedVersion: "0".repeat(64),
      }),
    },
  );
  assert.equal(foreign.status, 404);

  const staffBase = await listen(appFor(staff, portfolioRouter));
  const read = await fetch(
    `${staffBase}/console/clients/${clientA}/assignments`,
  );
  assert.equal(read.status, 200);
  const write = await fetch(
    `${staffBase}/console/clients/${clientA}/assignments`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        userIds: [staffId],
        expectedVersion: current.version,
      }),
    },
  );
  assert.equal(write.status, 403);
});

test("a stale replacement is rejected instead of erasing a concurrent admin change", async () => {
  const base = await listen(appFor(admin, portfolioRouter));
  const initial = (await (
    await fetch(`${base}/console/clients/${clientA}/assignments`)
  ).json()) as { version: string; assignees: { userId: string }[] };

  const winner = await fetch(`${base}/console/clients/${clientA}/assignments`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      userIds: [adminId, staffId],
      expectedVersion: initial.version,
    }),
  });
  assert.equal(winner.status, 200);

  const stale = await fetch(`${base}/console/clients/${clientA}/assignments`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ userIds: [], expectedVersion: initial.version }),
  });
  assert.equal(stale.status, 409);
  assert.match(
    ((await stale.json()) as { error: string }).error,
    /team changed since you opened it/i,
  );

  const latest = (await (
    await fetch(`${base}/console/clients/${clientA}/assignments`)
  ).json()) as { assignees: { userId: string }[] };
  assert.deepEqual(
    latest.assignees.map((row) => row.userId).sort(),
    [adminId, staffId].sort(),
  );
});
