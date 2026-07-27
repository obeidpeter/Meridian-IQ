import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  alertPreferencesTable,
  auditEventsTable,
  clerkCasesTable,
  clerkEvalFixturesTable,
  engagementsTable,
  firmsTable,
  invitationsTable,
  invoicesTable,
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
// Round 7 adds the Clerk lifecycle leg: grown eval fixtures traced to the
// offboarded party (case -> created invoice -> supplier party) are retired
// with their content emptied on the FIRST offboard (party-scoped, not
// last-engagement-gated), while another client's fixture stays untouched.

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

// Clerk lifecycle fixtures: one grown eval fixture traced to the offboarded
// party through its approved invoice, and one traced to an UNRELATED client
// (the sibling-firm fixture that must survive).
const buyerPartyId = randomUUID();
const otherPartyId = randomUUID(); // another firm's client, never offboarded
// The sibling case's creator: NOT a member of the offboarded party (userB is
// — a case created by a member of the party is correctly traced to it).
const userC = randomUUID();
const invoiceOff = randomUUID();
const invoiceOther = randomUUID();
const caseOff = randomUUID();
const caseOther = randomUUID();
const FIXTURE_TEXT = `INVOICE OFFBOARD-${randomUUID().slice(0, 8)} from Offboard Subject`;

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

  // Grown eval fixtures: caseOff traces to the offboarded party via its
  // approved invoice's supplier (the eval-growth join); caseOther traces to
  // an unrelated client under firm C and must survive untouched.
  await db.insert(partiesTable).values([
    { id: buyerPartyId, type: "buyer", legalName: `Off Buyer ${SALT}` },
    {
      id: otherPartyId,
      type: "client_business",
      legalName: `Off Sibling Client ${SALT}`,
      tin: "30000003-0003",
    },
  ]);
  await db.insert(usersTable).values({
    id: userC,
    email: `off-c-${SALT}@test.local`,
    fullName: `Off C ${SALT}`,
    passwordHash: `hash-${SALT}`,
  });
  await db.insert(invoicesTable).values([
    {
      id: invoiceOff,
      firmId: firmA,
      supplierPartyId: partyId,
      buyerPartyId,
      invoiceNumber: `OFF-INV-${SALT}`,
      issueDate: "2026-06-01",
    },
    {
      id: invoiceOther,
      firmId: firmC,
      supplierPartyId: otherPartyId,
      buyerPartyId,
      invoiceNumber: `OFF-OTHER-${SALT}`,
      issueDate: "2026-06-01",
    },
  ]);
  await db.insert(clerkCasesTable).values([
    {
      id: caseOff,
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceText: FIXTURE_TEXT,
      createdBy: userA,
      createdInvoiceId: invoiceOff,
    },
    {
      id: caseOther,
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceText: `sibling ${FIXTURE_TEXT}`,
      createdBy: userC,
      createdInvoiceId: invoiceOther,
    },
  ]);
  await db.insert(clerkEvalFixturesTable).values([
    {
      caseId: caseOff,
      label: `offboard fixture ${SALT}`,
      sourceText: FIXTURE_TEXT,
      expected: { grandTotal: "1000.00" },
      supplierName: LEGAL_NAME,
      supplierTin: TIN,
    },
    {
      caseId: caseOther,
      label: `offboard sibling fixture ${SALT}`,
      sourceText: `sibling ${FIXTURE_TEXT}`,
      expected: { grandTotal: "2000.00" },
      supplierName: `Off Sibling Client ${SALT}`,
      supplierTin: "30000003-0003",
    },
  ]);
});

after(async () => {
  // Keep the grown corpus clean for other suites (the invoices stay — the
  // retention guard blocks deleting them, same posture as the clerk suites).
  const db = getDb();
  await db
    .delete(clerkEvalFixturesTable)
    .where(inArray(clerkEvalFixturesTable.caseId, [caseOff, caseOther]));
  await db
    .delete(clerkCasesTable)
    .where(inArray(clerkCasesTable.id, [caseOff, caseOther]));
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
    fixturesRetired: number;
  };
  assert.deepEqual(outcome, {
    engagementsArchived: 1,
    membershipsRemoved: 1,
    aliasesDeleted: 1,
    contactCleared: false,
    lastEngagement: false,
    // Party-scoped, NOT last-engagement-gated: the client's grown eval
    // fixture retires on the FIRST offboard.
    fixturesRetired: 1,
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

  // Clerk lifecycle: the party's grown fixture is retired AND emptied —
  // retiredAt frees the corpus slot, sourceText goes to '' (NOT NULL kept),
  // the supplier-memory identity columns go NULL. The sibling client's
  // fixture is untouched in full.
  const [retiredFixture] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, caseOff));
  assert.ok(retiredFixture.retiredAt, "fixture retired on first offboard");
  assert.equal(retiredFixture.sourceText, "", "document content emptied");
  assert.equal(retiredFixture.supplierName, null);
  assert.equal(retiredFixture.supplierTin, null);
  const [siblingFixture] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, caseOther));
  assert.equal(siblingFixture.retiredAt, null, "sibling fixture untouched");
  assert.equal(siblingFixture.sourceText, `sibling ${FIXTURE_TEXT}`);
  assert.equal(siblingFixture.supplierName, `Off Sibling Client ${SALT}`);
  assert.equal(siblingFixture.supplierTin, "30000003-0003");

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
  assert.equal(afterPayload.fixturesRetired, 1);
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
    // Already retired by firm A's offboard — retirement is idempotent.
    fixturesRetired: 0,
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
