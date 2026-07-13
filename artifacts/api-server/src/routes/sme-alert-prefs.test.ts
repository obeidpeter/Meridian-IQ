import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  firmsTable,
  engagementsTable,
  alertPreferencesTable,
} from "@workspace/db";
import smeRouter from "./sme.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";

// Alert-preference authorization (review finding): the SME owner role
// (client_user) holds no messaging.send capability but MUST be able to manage
// the preferences of its OWN client party — and only that party. Firm staff
// keep managing any engaged client via messaging.send; roles with neither
// (bank_user) are rejected.

const PREFS_BODY = JSON.stringify({ pushEnabled: false, smsEnabled: true });

// A dedicated throwaway firm + party + engagement so the test never depends on
// (or mutates) the demo seed. A real client_user principal is always bound to
// a firm (tenantFirmId throws otherwise) and assertPartyAccess requires an
// engagement between that firm and the party. Cleaned up below.
const partyId = randomUUID();
const firmId = randomUUID();
const engagementId = randomUUID();
let fixturesCreated = false;

async function ensureFixtures(): Promise<void> {
  if (fixturesCreated) return;
  await getDb()
    .insert(partiesTable)
    .values({
      id: partyId,
      type: "client_business",
      legalName: "Alert Prefs Test Party",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: "Alert Prefs Test Firm" })
    .onConflictDoNothing();
  await getDb()
    .insert(engagementsTable)
    .values({
      id: engagementId,
      firmId,
      clientPartyId: partyId,
      type: "retainer",
      title: "Alert Prefs Test Engagement",
    })
    .onConflictDoNothing();
  fixturesCreated = true;
}

after(async () => {
  await closeAllServers();
  if (fixturesCreated) {
    await getDb()
      .delete(alertPreferencesTable)
      .where(eq(alertPreferencesTable.clientPartyId, partyId));
    await getDb()
      .delete(engagementsTable)
      .where(eq(engagementsTable.id, engagementId));
    await getDb().delete(firmsTable).where(eq(firmsTable.id, firmId));
    await getDb().delete(partiesTable).where(eq(partiesTable.id, partyId));
  }
});

test("client_user can update the alert preferences of its OWN party", async () => {
  await ensureFixtures();
  const principal: Principal = {
    userId: "dev-user",
    role: "client_user",
    firmId,
    clientPartyId: partyId,
    buyerPartyId: null,
  };
  const base = await listen(appFor(principal, smeRouter));

  const res = await fetch(`${base}/clients/${partyId}/alert-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: PREFS_BODY,
  });
  assert.equal(res.status, 200, "own-party update must succeed");
  const prefs = (await res.json()) as {
    pushEnabled: boolean;
    smsEnabled: boolean;
  };
  assert.equal(prefs.pushEnabled, false);
  assert.equal(prefs.smsEnabled, true);
});

test("client_user CANNOT update another client party's alert preferences", async () => {
  await ensureFixtures();
  const principal: Principal = {
    userId: "dev-user",
    role: "client_user",
    firmId,
    // Scoped to a different party than the one being targeted.
    clientPartyId: randomUUID(),
    buyerPartyId: null,
  };
  const base = await listen(appFor(principal, smeRouter));

  const res = await fetch(`${base}/clients/${partyId}/alert-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: PREFS_BODY,
  });
  assert.equal(res.status, 403, "cross-client update must be rejected");
});

test("roles with neither client scope nor messaging.send are rejected", async () => {
  const principal: Principal = {
    userId: "dev-user",
    role: "bank_user",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
  const base = await listen(appFor(principal, smeRouter));

  const res = await fetch(`${base}/clients/${partyId}/alert-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: PREFS_BODY,
  });
  assert.equal(res.status, 403, "bank_user must be capability-gated");

  const testAlert = await fetch(`${base}/clients/${partyId}/alerts/test`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}",
  });
  assert.equal(testAlert.status, 403, "test alert must be capability-gated");
});
