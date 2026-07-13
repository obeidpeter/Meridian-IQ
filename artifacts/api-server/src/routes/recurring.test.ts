import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import recurringRouter from "./recurring.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Access model for recurring templates: firm staff manage the firm's book;
// a client_user (SEC-03) creates, sees and toggles only templates drafting
// for its OWN party.

const SALT = makeRunSalt();

const firmId = randomUUID();
const userStaff = randomUUID();
const userClientA = randomUUID();
const userClientB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

const staff: Principal = {
  userId: userStaff,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUserA: Principal = {
  userId: userClientA,
  role: "client_user",
  firmId,
  clientPartyId: clientA,
  buyerPartyId: null,
};
const clientUserB: Principal = {
  userId: userClientB,
  role: "client_user",
  firmId,
  clientPartyId: clientB,
  buyerPartyId: null,
};

function body(supplierPartyId: string, name: string) {
  return JSON.stringify({
    supplierPartyId,
    buyerPartyId: buyer,
    name,
    cadence: "monthly",
    startDate: "2026-07-01",
    lines: [
      { description: "Retainer", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
    ],
  });
}

after(async () => {
  await closeAllServers();
});

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values(
      [userStaff, userClientA, userClientB].map((id, i) => ({
        id,
        email: `recroute-${i}-${SALT}@test.local`,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `RecRoute Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business",
      legalName: `RecRoute Client A ${SALT}`,
      tin: "10000000-0021",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: clientB,
      type: "client_business",
      legalName: `RecRoute Client B ${SALT}`,
      tin: "10000000-0022",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `RecRoute Buyer ${SALT}`,
      tin: "20000000-0021",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
});

test("client_user creates for its own party; sibling party is a 403", async () => {
  const base = await listen(appFor(clientUserA, recurringRouter));

  const own = await fetch(`${base}/recurring-invoices`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(clientA, `A own ${SALT}`),
  });
  assert.equal(own.status, 201);

  const sibling = await fetch(`${base}/recurring-invoices`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(clientB, `A poaching B ${SALT}`),
  });
  assert.equal(sibling.status, 403);
});

test("list is SEC-03 scoped: a client sees only its own templates", async () => {
  const staffBase = await listen(appFor(staff, recurringRouter));
  const created = await fetch(`${staffBase}/recurring-invoices`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(clientB, `B retainer ${SALT}`),
  });
  assert.equal(created.status, 201);

  const aBase = await listen(appFor(clientUserA, recurringRouter));
  const aList = (await (await fetch(`${aBase}/recurring-invoices`)).json()) as {
    supplierPartyId: string;
  }[];
  assert.ok(aList.length > 0);
  assert.ok(aList.every((t) => t.supplierPartyId === clientA));

  // Staff sees the whole firm: both clients' templates.
  const staffList = (await (
    await fetch(`${staffBase}/recurring-invoices`)
  ).json()) as { supplierPartyId: string }[];
  assert.ok(staffList.some((t) => t.supplierPartyId === clientA));
  assert.ok(staffList.some((t) => t.supplierPartyId === clientB));
});

test("pause: owner and staff may; a sibling client_user may not", async () => {
  const staffBase = await listen(appFor(staff, recurringRouter));
  const created = (await (
    await fetch(`${staffBase}/recurring-invoices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: body(clientA, `A pausable ${SALT}`),
    })
  ).json()) as { id: string };

  const bBase = await listen(appFor(clientUserB, recurringRouter));
  const denied = await fetch(`${bBase}/recurring-invoices/${created.id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ active: false }),
  });
  assert.equal(denied.status, 403);

  const paused = await fetch(`${staffBase}/recurring-invoices/${created.id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ active: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as { active: boolean }).active, false);
});
