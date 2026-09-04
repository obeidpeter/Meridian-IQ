import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  firmsTable,
  engagementsTable,
  invoicesTable,
} from "@workspace/db";
import partiesRouter from "./parties.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";

// Fix-and-retry party access (review finding): buyer parties are usually NOT
// engagement subjects, so plain assertPartyAccess (engagement-only) would 403
// firm staff trying to view/fix a buyer whose bad TIN failed one of the firm's
// invoices. PATCH grants that fallback only to firm-scoped staff. GET uses the
// directory's read sphere: client users can hydrate their own invoice buyers,
// but cannot edit them or read a sibling client's customers (SEC-03).

// Throwaway fixtures: a firm engaging a supplier party, a buyer party with NO
// engagement, and one draft invoice tying them together. The invoice row is
// intentionally NOT cleaned up: the invoice-immutability trigger blocks DELETE
// (retention guard), and its FK keeps the firm/party rows too. That leaves a
// handful of inert draft rows in the dev DB per full test run, which the
// standard demo reset (TRUNCATE invoices CASCADE) clears anyway.
const firmId = randomUUID();
const otherFirmId = randomUUID();
const supplierPartyId = randomUUID();
const buyerPartyId = randomUUID();
const siblingSupplierId = randomUUID();
const siblingBuyerId = randomUUID();
const engagementId = randomUUID();
const invoiceId = randomUUID();
const userId = randomUUID();
let fixturesCreated = false;

async function ensureFixtures(): Promise<void> {
  if (fixturesCreated) return;
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: supplierPartyId,
        type: "client_business",
        legalName: "Party Access Test Supplier",
      },
      {
        id: buyerPartyId,
        type: "buyer",
        legalName: "Party Access Test Buyer",
      },
      {
        id: siblingSupplierId,
        type: "client_business",
        legalName: "Party Access Sibling Supplier",
      },
      {
        id: siblingBuyerId,
        type: "buyer",
        legalName: "Party Access Sibling Buyer",
      },
    ])
    .onConflictDoNothing();
  await getDb()
    .insert(firmsTable)
    .values([
      { id: firmId, name: "Party Access Test Firm" },
      { id: otherFirmId, name: "Party Access Other Firm" },
    ])
    .onConflictDoNothing();
  await getDb()
    .insert(engagementsTable)
    .values({
      id: engagementId,
      firmId,
      clientPartyId: supplierPartyId,
      type: "retainer",
      title: "Party Access Test Engagement",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(invoicesTable)
    .values({
      id: invoiceId,
      firmId,
      supplierPartyId,
      buyerPartyId,
      invoiceNumber: `PAT-${invoiceId.slice(0, 8)}`,
      issueDate: "2026-07-01",
      status: "draft",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(invoicesTable)
    .values({
      firmId,
      supplierPartyId: siblingSupplierId,
      buyerPartyId: siblingBuyerId,
      invoiceNumber: `PAT-SIB-${invoiceId.slice(0, 8)}`,
      issueDate: "2026-07-01",
      status: "draft",
    });
  fixturesCreated = true;
}

after(async () => {
  await closeAllServers();
  if (fixturesCreated) {
    // The invoice row cannot be deleted (immutability/retention trigger) and
    // FK-pins the firm and both parties; only the engagement is removable.
    await getDb()
      .delete(engagementsTable)
      .where(eq(engagementsTable.id, engagementId));
    await getDb().delete(firmsTable).where(eq(firmsTable.id, otherFirmId));
  }
});

function staffOf(firm: string): Principal {
  return {
    userId,
    role: "firm_staff",
    firmId: firm,
    clientPartyId: null,
    buyerPartyId: null,
  };
}

function clientUser(): Principal {
  return {
    userId,
    role: "client_user",
    firmId,
    clientPartyId: supplierPartyId,
    buyerPartyId: null,
  };
}

test("firm_staff can GET an unengaged buyer party referenced by a firm invoice", async () => {
  await ensureFixtures();
  const base = await listen(appFor(staffOf(firmId), partiesRouter));

  const res = await fetch(`${base}/parties/${buyerPartyId}`);
  assert.equal(res.status, 200, "invoice-reference fallback must grant read");
  const body = (await res.json()) as { id: string; legalName: string };
  assert.equal(body.id, buyerPartyId);
});

test("firm_staff can PATCH an unengaged buyer party referenced by a firm invoice", async () => {
  await ensureFixtures();
  const base = await listen(appFor(staffOf(firmId), partiesRouter));

  const res = await fetch(`${base}/parties/${buyerPartyId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ tin: "98765432-0009", city: "Test City" }),
  });
  assert.equal(res.status, 200, "invoice-reference fallback must grant write");
  const body = (await res.json()) as { tin: string; city: string };
  assert.equal(body.tin, "98765432-0009");
  assert.equal(body.city, "Test City");
});

test("an unrelated firm cannot discover or update another firm's buyer", async () => {
  await ensureFixtures();
  const base = await listen(appFor(staffOf(otherFirmId), partiesRouter));

  const getRes = await fetch(`${base}/parties/${buyerPartyId}`);
  assert.equal(
    getRes.status,
    404,
    "out-of-sphere reads hide the party's existence",
  );
  assert.deepEqual(await getRes.json(), { error: "Party not found" });
  const missingRes = await fetch(`${base}/parties/${randomUUID()}`);
  assert.equal(missingRes.status, 404);
  assert.deepEqual(await missingRes.json(), { error: "Party not found" });
  const patchRes = await fetch(`${base}/parties/${buyerPartyId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ city: "Nope" }),
  });
  assert.equal(patchRes.status, 403, "no invoice reference -> write denied");
});

test("client_user can hydrate an own-invoice buyer but cannot edit it", async () => {
  await ensureFixtures();
  const base = await listen(appFor(clientUser(), partiesRouter));

  const getRes = await fetch(`${base}/parties/${buyerPartyId}`);
  assert.equal(getRes.status, 200, "a directory-visible buyer can be hydrated");
  assert.equal(((await getRes.json()) as { id: string }).id, buyerPartyId);
  const directory = await fetch(`${base}/parties?type=buyer&limit=100`);
  assert.equal(directory.status, 200);
  const buyers = (await directory.json()) as { id: string }[];
  assert.ok(buyers.some((party) => party.id === buyerPartyId));
  assert.ok(!buyers.some((party) => party.id === siblingBuyerId));
  const patchRes = await fetch(`${base}/parties/${buyerPartyId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ city: "Nope" }),
  });
  assert.equal(patchRes.status, 403, "buyer write must stay confined (SEC-03)");

  const ownRes = await fetch(`${base}/parties/${supplierPartyId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ tin: "12345678-0009" }),
  });
  assert.equal(ownRes.status, 200, "own-party self-service must keep working");
  const own = (await ownRes.json()) as { tin: string };
  assert.equal(own.tin, "12345678-0009");
});

test("client_user cannot hydrate or update a sibling client's invoice buyer", async () => {
  await ensureFixtures();
  const staffBase = await listen(appFor(staffOf(firmId), partiesRouter));
  assert.equal(
    (await fetch(`${staffBase}/parties/${siblingBuyerId}`)).status,
    200,
  );
  const clientBase = await listen(appFor(clientUser(), partiesRouter));
  const denied = await fetch(`${clientBase}/parties/${siblingBuyerId}`);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "Party not found" });
  const patch = await fetch(`${clientBase}/parties/${siblingBuyerId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ city: "Nope" }),
  });
  assert.equal(patch.status, 403);
});
