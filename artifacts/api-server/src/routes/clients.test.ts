import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  engagementsTable,
  firmsTable,
  partiesTable,
} from "@workspace/db";
import clientsRouter from "./clients.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { clientPrincipal, crossTenantPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// POST /clients — single engaged-client creation: party (shared spine, with
// provenance + party.create audit via createParty) plus the retainer
// engagement that places the client in the firm's tenant boundary, in one
// request. The duplicate guard is scoped to THIS firm's engaged clients only
// — the same TIN under another firm must create a fresh party, never confirm
// or reveal the other tenant's roster (oracle avoidance, the clients-import
// posture).

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const adminAId = randomUUID();

const adminA: Principal = firmPrincipal(firmA, { userId: adminAId });
const adminB: Principal = {
  ...adminA,
  userId: randomUUID(),
  firmId: firmB,
};
const clientUser: Principal = clientPrincipal(firmA, randomUUID());
const operator: Principal = crossTenantPrincipal("operator");

const TIN = "12345678-0001";
const LEGAL_NAME = `Create Client Alpha ${SALT}`;

before(async () => {
  await getDb().insert(firmsTable).values([
    { id: firmA, name: `Create Client Firm A ${SALT}` },
    { id: firmB, name: `Create Client Firm B ${SALT}` },
  ]);
});

after(async () => {
  await closeAllServers();
});

test("firm_admin creates party + retainer engagement in one call, audited", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await fetch(`${base}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      legalName: LEGAL_NAME,
      tin: ` ${TIN} `, // whitespace must normalize away
      cacNumber: "rc123456",
      street: "1 Broad Street",
      city: "Lagos",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    partyId: string;
    engagementId: string;
    legalName: string;
  };
  assert.equal(body.legalName, LEGAL_NAME);

  const [party] = await getDb()
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, body.partyId));
  assert.equal(party.type, "client_business");
  assert.equal(party.tin, TIN, "TIN stored normalized");
  assert.equal(party.tinValidated, true);
  assert.equal(party.cacNumber, "RC123456", "CAC stored normalized");
  assert.equal(party.createdByFirmId, firmA, "provenance from the principal");
  assert.equal(party.createdByUserId, adminAId);

  const [engagement] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, body.engagementId));
  assert.equal(engagement.firmId, firmA);
  assert.equal(engagement.clientPartyId, body.partyId);
  assert.equal(engagement.type, "retainer");
  assert.equal(engagement.status, "in_progress");
  assert.equal(engagement.title, `${LEGAL_NAME} — compliance retainer`);

  // Both creation audits ride: party.create (from createParty) and
  // engagement.create (the routes/engagements.ts mirror).
  const partyEvents = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "party.create"),
        eq(auditEventsTable.entityId, body.partyId),
      ),
    );
  assert.equal(partyEvents.length, 1);
  const engagementEvents = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "engagement.create"),
        eq(auditEventsTable.entityId, body.engagementId),
      ),
    );
  assert.equal(engagementEvents.length, 1);
  assert.equal(engagementEvents[0].firmId, firmA);
});

test("duplicate guard: same normalized TIN under the same firm is 409", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await fetch(`${base}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      legalName: `Different Name ${SALT}`,
      tin: "1234 5678-0001", // normalizes to the existing client's TIN
    }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /already engages/i);
});

test("duplicate guard: exact legal name (no TIN) under the same firm is 409", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await fetch(`${base}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ legalName: LEGAL_NAME }),
  });
  assert.equal(res.status, 409);
});

test("the check is firm-scoped: another firm may create the same TIN (no cross-tenant oracle)", async () => {
  const base = await listen(appFor(adminB, clientsRouter));
  const res = await fetch(`${base}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      legalName: `Create Client Beta ${SALT}`,
      tin: TIN,
    }),
  });
  assert.equal(res.status, 201, "a TIN engaged elsewhere creates a NEW party here");
  const body = (await res.json()) as { partyId: string };
  const rows = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(eq(partiesTable.tin, TIN));
  assert.ok(rows.length >= 2, "two independent parties share the TIN across firms");
  assert.ok(rows.some((r) => r.id === body.partyId));
});

test("invalid TIN fails 400 via createParty and creates nothing", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const badName = `Invalid Tin Client ${SALT}`;
  const res = await fetch(`${base}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ legalName: badName, tin: "not-a-tin" }),
  });
  assert.equal(res.status, 400);
  const rows = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(eq(partiesTable.legalName, badName));
  assert.equal(rows.length, 0, "no party row on validation failure");
});

test("role refusals: client_user lacks engagement.write; operator has no firm scope", async () => {
  const asClient = await listen(appFor(clientUser, clientsRouter));
  const clientRes = await fetch(`${asClient}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ legalName: `Nope ${SALT}` }),
  });
  assert.equal(clientRes.status, 403);

  const asOperator = await listen(appFor(operator, clientsRouter));
  const operatorRes = await fetch(`${asOperator}/clients`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ legalName: `Nope Either ${SALT}` }),
  });
  assert.equal(operatorRes.status, 403);
});
