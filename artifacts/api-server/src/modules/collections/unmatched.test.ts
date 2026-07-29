import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  collectionAccountsTable,
  firmsTable,
  partiesTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit.ts";
import {
  UNMATCHED_COLLECTION_ACTION,
  countFirmUnmatchedCollections,
  listUnmatchedCollections,
} from "./unmatched.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Unmatched inbound collections (round-17 idea #3). Pinned here:
//  - the report groups the webhook's pointer-only audit events per account
//    and resolves the account's reference and client name;
//  - counts and windows are firm-scoped — another firm's unmatched payments
//    never appear;
//  - the short-window count (the digest/brief fact) reads the same events.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const accountA = randomUUID();
const accountB = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Unmatched Firm A ${SALT}` },
    { id: firmB, name: `Unmatched Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `Unmatched Client A ${SALT}` },
    { id: clientB, type: "client_business", legalName: `Unmatched Client B ${SALT}` },
  ]);
  await db.insert(collectionAccountsTable).values([
    {
      id: accountA,
      firmId: firmA,
      clientPartyId: clientA,
      provider: "simulator",
      accountReference: `UM-A-${SALT}`,
      label: "Main",
      createdByUserId: randomUUID(),
    },
    {
      id: accountB,
      firmId: firmB,
      clientPartyId: clientB,
      provider: "simulator",
      accountReference: `UM-B-${SALT}`,
      label: null,
      createdByUserId: randomUUID(),
    },
  ]);
  // The webhook's own event shape (collections/service.ts): pointer-only.
  for (const [firmId, accountId] of [
    [firmA, accountA],
    [firmA, accountA],
    [firmB, accountB],
  ] as const) {
    await appendAudit({
      firmId,
      action: UNMATCHED_COLLECTION_ACTION,
      entityType: "collection_account",
      entityId: accountId,
      after: { hasInvoiceNumber: true },
    });
  }
});

test("the report groups per account with resolved names, firm-scoped", async () => {
  const report = await listUnmatchedCollections(firmA);
  assert.equal(report.total, 2);
  assert.equal(report.accounts.length, 1);
  const row = report.accounts[0];
  assert.equal(row.accountId, accountA);
  assert.equal(row.accountReference, `UM-A-${SALT}`);
  assert.equal(row.clientName, `Unmatched Client A ${SALT}`);
  assert.equal(row.count, 2);
  assert.ok(row.firstSeen <= row.lastSeen);
  assert.match(report.note, /never recorded/);

  const other = await listUnmatchedCollections(firmB);
  assert.equal(other.total, 1);
  assert.equal(other.accounts[0].accountId, accountB);
});

test("the short-window count reads the same events", async () => {
  assert.equal(await countFirmUnmatchedCollections(firmA, 7), 2);
  assert.equal(await countFirmUnmatchedCollections(firmB, 7), 1);
});
