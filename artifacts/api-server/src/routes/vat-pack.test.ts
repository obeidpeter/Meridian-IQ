import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable } from "@workspace/db";
import invoicesRouter from "./invoices.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { closedLagosMonths } from "../modules/clerk/vat-pack.ts";

// Route-level authz for the VAT filing pack (idea #2). The SEC-critical
// guarantee — a client_user must never see sibling clients' VAT figures, and
// tenant-less principals have no pack at all — lives in the ROUTE's
// capability + firm-scope gates, which no module test can reach. Pin it here
// so quietly broadening the capability breaks CI, not tenancy.

const SALT = makeRunSalt();
const firmId = randomUUID();

const firmAdmin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUser: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId,
  clientPartyId: randomUUID(),
  buyerPartyId: null,
};
const operator: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

before(async () => {
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: `VP Route Firm ${SALT}` });
});

after(async () => {
  await closeAllServers();
});

test("firm principals get the pack; the month gate fails closed", async () => {
  const base = await listen(appFor(firmAdmin, invoicesRouter));

  const ok = await fetch(`${base}/vat-pack`);
  assert.equal(ok.status, 200);
  const pack = (await ok.json()) as { monthStart: string; months: string[] };
  assert.equal(pack.monthStart, closedLagosMonths()[0]);

  // The CURRENT (unclosed) month is refused, as is garbage.
  const open = new Date().toISOString().slice(0, 7) + "-01";
  const refused = await fetch(`${base}/vat-pack?month=${open}`);
  // (If the UTC and Lagos months ever disagree for an hour at the boundary,
  // the refusal still holds: the open month is never in the closed list.)
  assert.equal(refused.status, 400);
  const garbage = await fetch(`${base}/vat-pack?month=2020-13-99`);
  assert.equal(garbage.status, 400);

  const csv = await fetch(`${base}/vat-pack/export`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const body = await csv.text();
  assert.ok(body.includes("netOutputVat"), "the CSV carries the net column");
  assert.ok(body.includes("not a return"), "the disclosure travels in the file");
});

test("a client_user is refused — sibling clients' VAT figures never leak", async () => {
  const base = await listen(appFor(clientUser, invoicesRouter));
  assert.equal((await fetch(`${base}/vat-pack`)).status, 403);
  assert.equal((await fetch(`${base}/vat-pack/export`)).status, 403);
});

test("a tenant-less principal (operator) is refused", async () => {
  const base = await listen(appFor(operator, invoicesRouter));
  assert.equal((await fetch(`${base}/vat-pack`)).status, 403);
});
