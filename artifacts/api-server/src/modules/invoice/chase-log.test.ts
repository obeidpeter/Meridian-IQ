import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
} from "@workspace/db";
import type { Principal } from "../auth/rbac.ts";
import {
  chaseHistory,
  countFirmChasedTwice,
  recordChase,
} from "./chase-log.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Chase ladder memory (round-14 idea #3). Pinned invariants:
//  - stages number 1, 2, 3… in logging order;
//  - only an outstanding receivable can log (settled/draft/credit refuse);
//  - tenancy mirrors the chaser draft (firm + SEC-03 party);
//  - the firm digest counts invoices with 2+ reminders still outstanding.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const outstandingId = randomUUID();
const onceChasedId = randomUUID();
const settledId = randomUUID();

const clientPrincipal: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId,
  clientPartyId: clientId,
  buyerPartyId: null,
};
const siblingPrincipal: Principal = {
  ...clientPrincipal,
  userId: randomUUID(),
  clientPartyId: randomUUID(),
};

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `CL Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `CL Client ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `CL Buyer ${SALT}` },
  ]);
  const base = {
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyerId,
    issueDate: "2026-06-01",
    grandTotal: "1000.00",
  };
  await db.insert(invoicesTable).values([
    {
      ...base,
      id: outstandingId,
      invoiceNumber: `CL-OUT-${SALT}`,
      status: "stamped" as never,
    },
    {
      ...base,
      id: onceChasedId,
      invoiceNumber: `CL-ONE-${SALT}`,
      status: "confirmed" as never,
    },
    {
      ...base,
      id: settledId,
      invoiceNumber: `CL-SET-${SALT}`,
      status: "settled" as never,
    },
  ]);
});

test("stages number in order; only outstanding receivables log; tenancy holds", async () => {
  assert.equal((await chaseHistory(outstandingId)).count, 0);

  const first = await recordChase(outstandingId, clientPrincipal);
  assert.equal(first.stage, 1);
  const second = await recordChase(outstandingId, clientPrincipal);
  assert.equal(second.stage, 2);
  assert.equal(second.count, 2);
  assert.ok(second.lastAt, "the log timestamps the reminder");

  const history = await chaseHistory(outstandingId);
  assert.equal(history.count, 2);

  // One reminder on the second invoice — below the digest threshold.
  await recordChase(onceChasedId, clientPrincipal);

  await assert.rejects(
    recordChase(settledId, clientPrincipal),
    (err: Error & { code?: string }) => err.code === "NOT_CHASEABLE",
  );
  await assert.rejects(recordChase(outstandingId, siblingPrincipal));
  await assert.rejects(
    recordChase(randomUUID(), clientPrincipal),
    (err: Error & { code?: string }) => err.code === "NOT_FOUND",
  );
});

test("the digest counts invoices with 2+ reminders still outstanding", async () => {
  assert.equal(
    await countFirmChasedTwice(firmId),
    1,
    "two reminders on one invoice; one on the other",
  );
  assert.equal(await countFirmChasedTwice(randomUUID()), 0);
});
