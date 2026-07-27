import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  alertPreferencesTable,
  auditEventsTable,
  engagementsTable,
  firmsTable,
  invitationsTable,
  membershipsTable,
  partiesTable,
  partyNameAliasesTable,
  pushDevicesTable,
  usersTable,
} from "@workspace/db";
import clientsRouter from "../../routes/clients.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// POST /clients/{id}/offboard — firm-scoped teardown of a SHARED-SPINE party.
// The critical property under test is the two-firm shape: while another firm
// still holds a live engagement, offboarding must archive/remove only the
// calling firm's relationship surface and leave the party's shared contact
// rails untouched; the LAST offboarding firm additionally clears the
// party-keyed contact PII. Statutory identity on the party row survives both.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const firmC = randomUUID(); // never engages the party
const partyId = randomUUID();
const LEGAL_NAME = `Offboard Subject ${SALT}`;
const TIN = "20000002-0002";
const userA = randomUUID(); // client_user under firm A
const userB = randomUUID(); // client_user under firm B
const engagementA = randomUUID();
const engagementB = randomUUID();

const adminA: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const adminB: Principal = { ...adminA, userId: randomUUID(), firmId: firmB };
const adminC: Principal = { ...adminA, userId: randomUUID(), firmId: firmC };
const staffA: Principal = {
  userId: randomUUID(),
  role: "firm_staff",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};

function offboard(base: string, id: string, confirmLegalName: string) {
  return fetch(`${base}/clients/${id}/offboard`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmLegalName }),
  });
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Off Firm A ${SALT}` },
    { id: firmB, name: `Off Firm B ${SALT}` },
    { id: firmC, name: `Off Firm C ${SALT}` },
  ]);
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: LEGAL_NAME,
    tin: TIN,
    cacNumber: "RC777777",
  });
  await db.insert(engagementsTable).values([
    {
      id: engagementA,
      firmId: firmA,
      clientPartyId: partyId,
      type: "retainer",
      status: "in_progress",
      title: `Off A ${SALT}`,
    },
    {
      id: engagementB,
      firmId: firmB,
      clientPartyId: partyId,
      type: "readiness_assessment",
      status: "open",
      title: `Off B ${SALT}`,
    },
  ]);
  await db.insert(usersTable).values([
    {
      id: userA,
      email: `off-a-${SALT}@test.local`,
      fullName: `Off A ${SALT}`,
      passwordHash: `hash-${SALT}`,
    },
    {
      id: userB,
      email: `off-b-${SALT}@test.local`,
      fullName: `Off B ${SALT}`,
      passwordHash: `hash-${SALT}`,
    },
  ]);
  await db.insert(membershipsTable).values([
    { userId: userA, firmId: firmA, role: "client_user", clientPartyId: partyId },
    { userId: userB, firmId: firmB, role: "client_user", clientPartyId: partyId },
  ]);
  await db.insert(partyNameAliasesTable).values([
    { firmId: firmA, partyId, alias: `OFF ALIAS A ${SALT}` },
    { firmId: firmB, partyId, alias: `OFF ALIAS B ${SALT}` },
  ]);
  await db.insert(invitationsTable).values({
    email: `off-invite-${SALT}@test.local`,
    role: "client_user",
    firmId: firmA,
    clientPartyId: partyId,
    tokenHash: `off-token-${SALT}`,
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    invitedByUserId: adminA.userId,
  });
  await db.insert(alertPreferencesTable).values({
    clientPartyId: partyId,
    whatsappTo: "+2348099990001",
    phone: "+2348099990002",
    email: `off-alerts-${SALT}@test.local`,
    contactSetByRole: "client_user",
    whatsappEnabled: true,
    smsEnabled: true,
    emailEnabled: true,
    pushEnabled: true,
  });
  await db.insert(pushDevicesTable).values([
    {
      userId: userA,
      firmId: firmA,
      clientPartyId: partyId,
      expoPushToken: `ExponentPushToken[offA-${SALT}]`,
      platform: "ios",
    },
    {
      userId: userB,
      firmId: firmB,
      clientPartyId: partyId,
      expoPushToken: `ExponentPushToken[offB-${SALT}]`,
      platform: "android",
    },
  ]);
});

after(async () => {
  await closeAllServers();
});

test("firm_staff is refused: offboarding is a firm-admin surface", async () => {
  const base = await listen(appFor(staffA, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME);
  assert.equal(res.status, 403);
});

test("a non-engaged firm's admin is behind the engagement wall", async () => {
  const base = await listen(appFor(adminC, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME);
  assert.equal(res.status, 403, "CROSS_TENANT before any teardown");
});

test("confirmLegalName must match exactly — the destructive-action guard", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME.toUpperCase());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /does not match/i);
  const [engagement] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, engagementA));
  assert.equal(engagement.status, "in_progress", "nothing was archived");
});

test("first firm offboards: firm-scoped teardown, shared contact rails untouched", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME);
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as {
    engagementsArchived: number;
    membershipsRemoved: number;
    aliasesDeleted: number;
    contactCleared: boolean;
    lastEngagement: boolean;
  };
  assert.deepEqual(outcome, {
    engagementsArchived: 1,
    membershipsRemoved: 1,
    aliasesDeleted: 1,
    contactCleared: false,
    lastEngagement: false,
  });

  const [engA] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, engagementA));
  assert.equal(engA.status, "archived");
  const [engB] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, engagementB));
  assert.equal(engB.status, "open", "the other firm's engagement is untouched");

  const memberships = await getDb()
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.clientPartyId, partyId));
  assert.equal(memberships.length, 1, "only firm A's client access removed");
  assert.equal(memberships[0].firmId, firmB);

  const aliases = await getDb()
    .select()
    .from(partyNameAliasesTable)
    .where(eq(partyNameAliasesTable.partyId, partyId));
  assert.equal(aliases.length, 1, "firm B's alias vocabulary survives");
  assert.equal(aliases[0].firmId, firmB);

  const [invite] = await getDb()
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, `off-token-${SALT}`));
  assert.equal(invite.status, "revoked", "the pending invite cannot re-open access");

  // The critical shared-spine property: firm B still serves this client, so
  // the party-keyed contact rails must be fully intact.
  const [prefs] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, partyId));
  assert.equal(prefs.whatsappTo, "+2348099990001", "contact PII NOT cleared");
  assert.equal(prefs.contactSetByRole, "client_user");
  assert.equal(prefs.whatsappEnabled, true);
  const devices = await getDb()
    .select()
    .from(pushDevicesTable)
    .where(eq(pushDevicesTable.clientPartyId, partyId));
  assert.equal(devices.length, 2, "push devices NOT deleted");

  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "party.offboard"),
        eq(auditEventsTable.entityId, partyId),
        eq(auditEventsTable.firmId, firmA),
      ),
    );
  assert.equal(events.length, 1, "one pointer-only ledger event");
  const afterPayload = events[0].after as Record<string, unknown>;
  assert.equal(afterPayload.engagementsArchived, 1);
  assert.equal(afterPayload.lastEngagement, false);
  assert.ok(
    !JSON.stringify(events).includes("+2348099990001"),
    "the ledger never carries contact values",
  );
});

test("last firm offboards: contact PII cleared, devices removed, statutory identity retained", async () => {
  const base = await listen(appFor(adminB, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME);
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(outcome, {
    engagementsArchived: 1,
    membershipsRemoved: 1,
    aliasesDeleted: 1,
    contactCleared: true,
    lastEngagement: true,
  });

  const [prefs] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, partyId));
  assert.equal(prefs.whatsappTo, null);
  assert.equal(prefs.phone, null);
  assert.equal(prefs.email, null);
  assert.equal(prefs.contactSetByRole, null, "the WhatsApp routing gate is closed");
  assert.equal(prefs.whatsappEnabled, false);
  assert.equal(prefs.smsEnabled, false);
  assert.equal(prefs.emailEnabled, false);
  assert.equal(prefs.pushEnabled, false);

  const devices = await getDb()
    .select()
    .from(pushDevicesTable)
    .where(eq(pushDevicesTable.clientPartyId, partyId));
  assert.equal(devices.length, 0, "all push registrations for the party removed");

  const memberships = await getDb()
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.clientPartyId, partyId));
  assert.equal(memberships.length, 0);

  // Legal-obligation retention: the shared-spine row keeps its statutory
  // identity — stamped invoices reference it.
  const [party] = await getDb()
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, partyId));
  assert.equal(party.legalName, LEGAL_NAME);
  assert.equal(party.tin, TIN);
  assert.equal(party.cacNumber, "RC777777");
});

test("a repeat offboard is a clean 409 NOT_ENGAGED", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await offboard(base, partyId, LEGAL_NAME);
  assert.equal(res.status, 409, "everything already archived");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /no active engagement/i);
});
