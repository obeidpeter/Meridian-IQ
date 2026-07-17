import { test, before, after } from "node:test";
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
  chaserFacts,
  draftPaymentChaser,
  templateChaser,
} from "./draft-chaser.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Payment-chaser drafts (round-9 idea #2). Pinned invariants:
//  - eligibility is the receivables definition exactly — a settled, failed
//  or draft invoice can never be chased;
//  - tenancy mirrors GET /invoices/:id (firm + SEC-03 party), so a sibling
//  client can never draft against another client's receivable;
//  - digest posture: the template answers on kill switch, missing gateway,
//  or discarded output — never an error;
//  - every figure in the facts comes from the stored invoice.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const outstandingId = randomUUID();
const settledId = randomUUID();
const draftId = randomUUID();

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

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `CH Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `CH Client ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `CH Buyer ${SALT}` },
  ]);
  const base = {
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyerId,
    grandTotal: "250000.00",
    subtotal: "232558.14",
    vatTotal: "17441.86",
  };
  await db.insert(invoicesTable).values([
    {
      ...base,
      id: outstandingId,
      invoiceNumber: `CH-OUT-${SALT}`,
      issueDate: daysAgo(40),
      dueDate: daysAgo(10),
      status: "stamped",
    },
    {
      ...base,
      id: settledId,
      invoiceNumber: `CH-SET-${SALT}`,
      issueDate: daysAgo(40),
      status: "settled",
    },
    {
      ...base,
      id: draftId,
      invoiceNumber: `CH-DR-${SALT}`,
      issueDate: daysAgo(2),
      status: "draft",
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("chaserFacts and templateChaser phrase only stored figures", () => {
  const input = {
    invoiceNumber: "INV-9",
    buyerName: "Acme",
    currency: "NGN",
    grandTotal: "1000.00",
    issueDate: "2026-06-01",
    dueDate: "2026-06-15",
    today: "2026-06-25",
    behaviour: {
      buyerPartyId: "b",
      buyerName: "Acme",
      settledCount: 4,
      medianDaysToPay: 12,
      lastSettledDate: "2026-05-01",
    },
    stage: 1,
    lastReminderAt: null,
  };
  const facts = chaserFacts(input);
  assert.match(facts, /Invoice number: INV-9/);
  assert.match(facts, /NGN 1000\.00/);
  assert.match(facts, /10 day\(s\) past due/);
  assert.match(facts, /about 12 day\(s\) after invoicing/);
  assert.match(facts, /12 day\(s\) beyond that/); // 24 days since issue - 12 median
  assert.match(facts, /first reminder/);

  const template = templateChaser(input);
  assert.match(template.subject, /INV-9/);
  assert.match(template.body, /Dear Acme/);
  assert.match(template.body, /2026-06-15 \(10 day\(s\) ago\)/);
  assert.match(template.body, /within about 12 day\(s\)/);
  assert.match(template.body, /disregard/);

  // No due date and no behaviour: still a complete letter.
  const bare = templateChaser({ ...input, dueDate: null, behaviour: null });
  assert.match(bare.body, /issued on 2026-06-01, is still outstanding/);
  assert.doesNotMatch(bare.body, /usually reach us/);
});

test("the ladder escalates register with the stage — never into threats", () => {
  const base = {
    invoiceNumber: "INV-9",
    buyerName: "Acme",
    currency: "NGN",
    grandTotal: "1000.00",
    issueDate: "2026-06-01",
    dueDate: "2026-06-15",
    today: "2026-06-25",
    behaviour: null,
    stage: 2,
    lastReminderAt: "2026-06-18T09:00:00Z",
  };
  const second = templateChaser(base);
  assert.match(second.subject, /Second reminder/);
  assert.match(second.body, /our reminder of 2026-06-18/);
  assert.match(second.body, /disregard/);
  assert.match(
    chaserFacts(base),
    /reminder number 2.*previous reminder was sent on 2026-06-18/,
  );

  const third = templateChaser({ ...base, stage: 3 });
  assert.match(third.subject, /remains unpaid/);
  assert.match(third.body, /confirm a date/);
  // The escalation ceiling: never legal/penalty language in any template.
  for (const t of [second, third]) {
    assert.doesNotMatch(t.body, /legal|penalt|interest/i);
  }
});

test("only an outstanding receivable can be chased; tenancy is enforced", async () => {
  await assert.rejects(
    draftPaymentChaser(settledId, clientPrincipal, null),
    (err: Error & { code?: string }) => err.code === "NOT_CHASEABLE",
  );
  await assert.rejects(
    draftPaymentChaser(draftId, clientPrincipal, null),
    (err: Error & { code?: string }) => err.code === "NOT_CHASEABLE",
  );
  // A sibling client of the same firm is walled off (SEC-03).
  await assert.rejects(draftPaymentChaser(outstandingId, siblingPrincipal, null));
  await assert.rejects(
    draftPaymentChaser(randomUUID(), clientPrincipal, null),
    (err: Error & { code?: string }) => err.code === "NOT_FOUND",
  );
});

test("no gateway → the template answers, complete and sendable", async () => {
  const draft = await draftPaymentChaser(outstandingId, clientPrincipal, null);
  assert.equal(draft.source, "template");
  assert.equal(draft.invoiceNumber, `CH-OUT-${SALT}`);
  assert.match(draft.subject, new RegExp(`CH-OUT-${SALT}`));
  assert.match(draft.body, /250000\.00/);
  assert.match(draft.body, /disregard/);
});

test("Clerk phrases when available; discarded output falls back", async () => {
  const good = fakeGateway(() =>
    JSON.stringify({ subject: `S-${SALT}`, body: `B-${SALT}` }),
  );
  const clerkDraft = await draftPaymentChaser(
    outstandingId,
    clientPrincipal,
    good,
  );
  assert.equal(clerkDraft.source, "clerk");
  assert.equal(clerkDraft.subject, `S-${SALT}`);
  assert.equal(clerkDraft.body, `B-${SALT}`);

  const bad = fakeGateway(() => "not json at all");
  const fallback = await draftPaymentChaser(
    outstandingId,
    clientPrincipal,
    bad,
  );
  assert.equal(fallback.source, "template");
  assert.match(fallback.body, /250000\.00/);
});
