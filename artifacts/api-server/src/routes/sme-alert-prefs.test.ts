import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  firmsTable,
  engagementsTable,
  alertPreferencesTable,
} from "@workspace/db";
import smeRouter from "./sme.ts";
import { errorHandler } from "../middleware/error.ts";
import type { Principal } from "../modules/auth/rbac.ts";

// Alert-preference authorization (review finding): the SME owner role
// (client_user) holds no messaging.send capability but MUST be able to manage
// the preferences of its OWN client party — and only that party. Firm staff
// keep managing any engaged client via messaging.send; roles with neither
// (bank_user) are rejected.

function appFor(principal: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = principal;
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use(smeRouter);
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const closers: Array<() => Promise<void>> = [];
const PREFS_BODY = JSON.stringify({ pushEnabled: false, smsEnabled: true });
const JSON_HEADERS = { "content-type": "application/json" };

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
  await Promise.all(closers.map((c) => c()));
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
  const { base, close } = await listen(appFor(principal));
  closers.push(close);

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
  const { base, close } = await listen(appFor(principal));
  closers.push(close);

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
  const { base, close } = await listen(appFor(principal));
  closers.push(close);

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
