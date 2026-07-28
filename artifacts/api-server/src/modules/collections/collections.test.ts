import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  collectionAccountsTable,
  engagementsTable,
  firmsTable,
  invoiceLifecycleEventsTable,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
} from "@workspace/db";
import collectionsRouter from "../../routes/collections.ts";
import { recordInboundCollection } from "./service.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Collection accounts. Pinned invariants:
//  - provisioning: the simulator mints a CA- reference when no relay is
//    configured (dark by default), the row persists with provider
//    "simulator", and the party-access wall refuses a client the firm does
//    not engage;
//  - the inbound webhook binds a payment to the client's receivable by
//    invoice number and settles it: append-only collection_account event,
//    stamped -> settled CAS transition, system lifecycle row, pointer-only
//    audit; a `submitted` receivable records the event only (the state
//    machine cannot settle it yet);
//  - a replayed delivery is harmless AND indistinguishable (202): the
//    settled invoice no longer matches the bindable statuses, so the replay
//    lands as an unmatched audit — never a second transition;
//  - deactivate is an idempotent CAS flip, and a deactivated (or unknown)
//    reference is silently ignored — no event, no audit oracle;
//  - an unmatchable invoice number writes the pointer-only unmatched audit;
//  - webhook posture: dark without COLLECTION_WEBHOOK_TOKEN (404), wrong
//    token 401, malformed body 400.

const SALT = makeRunSalt();

const firmA = randomUUID();
const clientParty = randomUUID(); // engaged with firm A — the accounts' owner
const strangerParty = randomUUID(); // NOT engaged — the party-access probe
const buyerParty = randomUUID();

const admin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUser: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId: firmA,
  clientPartyId: clientParty,
  buyerPartyId: null,
};

const WEBHOOK_TOKEN = `col-hook-${SALT}`;
const STAMPED_NUM = `INV-CA-ST-${SALT}`;
const SUBMITTED_NUM = `INV-CA-SUB-${SALT}`;
const DRAFT_NUM = `INV-CA-DR-${SALT}`;

let stampedId: string;
let submittedId: string;
let asAdmin: string;
let asClient: string;

interface AccountView {
  id: string;
  clientPartyId: string;
  provider: string;
  accountReference: string;
  label: string | null;
  active: boolean;
  createdAt: string;
}

const post = (
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

const eventsFor = (invoiceId: string) =>
  getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, invoiceId));

const unmatchedAuditsFor = (accountId: string) =>
  getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "collections.unmatched"),
        eq(auditEventsTable.entityId, accountId),
      ),
    );

async function seedInvoice(
  invoiceNumber: string,
  status: "draft" | "submitted" | "stamped",
): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId: firmA,
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber,
    kind: "invoice",
    status,
    issueDate: new Date().toISOString().slice(0, 10),
    grandTotal: "500.00",
    subtotal: "500.00",
    vatTotal: "0.00",
  });
  return id;
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmA, name: `Col Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: clientParty,
      type: "client_business",
      legalName: `Col Client ${SALT}`,
    },
    {
      id: strangerParty,
      type: "client_business",
      legalName: `Col Stranger ${SALT}`,
    },
    { id: buyerParty, type: "buyer", legalName: `Col Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId: firmA,
    clientPartyId: clientParty,
    type: "retainer",
    title: `collections ${SALT}`,
  });
  stampedId = await seedInvoice(STAMPED_NUM, "stamped");
  submittedId = await seedInvoice(SUBMITTED_NUM, "submitted");
  await seedInvoice(DRAFT_NUM, "draft");

  asAdmin = await listen(appFor(admin, collectionsRouter));
  asClient = await listen(appFor(clientUser, collectionsRouter));
});

after(async () => {
  delete process.env.COLLECTION_WEBHOOK_TOKEN;
  await closeAllServers();
});

// Captured across tests (node:test runs a file's tests in order).
let account: AccountView; // stays active — takes the webhook flows
let deadAccount: AccountView; // deactivated — the ignored-reference probe

test("provisioning: simulator CA- reference, row persisted, walls hold", async () => {
  const resp = await post(asAdmin, "/collection-accounts", {
    clientPartyId: clientParty,
    label: `Main ${SALT}`,
  });
  assert.equal(resp.status, 201);
  account = (await resp.json()) as AccountView;
  assert.match(
    account.accountReference,
    /^CA-[0-9A-F]{12}$/,
    "simulator mints the reference when no relay is configured",
  );
  assert.equal(account.provider, "simulator");
  assert.equal(account.clientPartyId, clientParty);
  assert.equal(account.label, `Main ${SALT}`);
  assert.equal(account.active, true);
  // firmId never leaves the server (the contract has no such field).
  assert.ok(!("firmId" in (account as unknown as Record<string, unknown>)));

  const [row] = await getDb()
    .select()
    .from(collectionAccountsTable)
    .where(eq(collectionAccountsTable.id, account.id));
  assert.ok(row, "row persisted");
  assert.equal(row.firmId, firmA);
  assert.equal(row.accountReference, account.accountReference);
  assert.equal(row.createdByUserId, admin.userId);

  // The list surfaces it for the client.
  const list = await fetch(
    `${asAdmin}/collection-accounts?clientPartyId=${clientParty}`,
  );
  assert.equal(list.status, 200);
  const rows = (await list.json()) as AccountView[];
  assert.ok(rows.some((r) => r.id === account.id));

  // Walls: a party the firm does not engage is refused; a client_user holds
  // no statement.write at all (SEC-03 — clients never wire payment rails).
  assert.equal(
    (
      await post(asAdmin, "/collection-accounts", {
        clientPartyId: strangerParty,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post(asClient, "/collection-accounts", {
        clientPartyId: clientParty,
      })
    ).status,
    403,
  );
});

test("webhook: dark without the secret (404), wrong token 401, bad body 400", async () => {
  delete process.env.COLLECTION_WEBHOOK_TOKEN;
  const payload = {
    accountReference: account.accountReference,
    amount: "500.00",
    invoiceNumber: STAMPED_NUM,
  };
  assert.equal(
    (await post(asAdmin, "/collections/inbound", payload)).status,
    404,
    "unset token keeps the rail dark",
  );
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    assert.equal(
      (
        await post(asAdmin, "/collections/inbound", payload, {
          "x-op-token": "wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(
          asAdmin,
          "/collections/inbound",
          { accountReference: "", amount: "12,000", invoiceNumber: "" },
          { "x-op-token": WEBHOOK_TOKEN },
        )
      ).status,
      400,
    );
    // Nothing settled through the refusals.
    assert.equal((await eventsFor(stampedId)).length, 0);
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});

test("webhook: an inbound payment settles a stamped receivable", async () => {
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    const paidAt = "2026-07-20T09:30:00.000Z";
    const resp = await post(
      asAdmin,
      "/collections/inbound",
      {
        accountReference: account.accountReference,
        amount: "500.00",
        invoiceNumber: STAMPED_NUM,
        reference: `TRF-${SALT}`,
        paidAt,
      },
      { "x-op-token": WEBHOOK_TOKEN },
    );
    assert.equal(resp.status, 202);
    assert.deepEqual(await resp.json(), { received: true });

    const events = await eventsFor(stampedId);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "collection_account");
    assert.equal(events[0].amount, "500.00");
    assert.equal(events[0].paymentStatus, "paid");
    assert.equal(events[0].actorId, null, "machine observer");
    assert.equal(events[0].occurredAt.toISOString(), paidAt);

    const [invoice] = await getDb()
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, stampedId));
    assert.equal(invoice.status, "settled");

    const lifecycle = await getDb()
      .select()
      .from(invoiceLifecycleEventsTable)
      .where(eq(invoiceLifecycleEventsTable.invoiceId, stampedId));
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].fromStatus, "stamped");
    assert.equal(lifecycle[0].toStatus, "settled");
    assert.equal(lifecycle[0].actorRole, "system");
    assert.equal(lifecycle[0].reason, "collection_account");

    // Pointer-only settlement audit: refs, never amounts.
    const audits = await getDb()
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, "collections.settlement"),
          eq(auditEventsTable.entityId, stampedId),
        ),
      );
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].after, {
      collectionAccountId: account.id,
      source: "collection_account",
    });
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});

test("webhook: a submitted receivable records the event but cannot settle yet", async () => {
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    const resp = await post(
      asAdmin,
      "/collections/inbound",
      {
        accountReference: account.accountReference,
        amount: "500.00",
        invoiceNumber: SUBMITTED_NUM,
      },
      { "x-op-token": WEBHOOK_TOKEN },
    );
    assert.equal(resp.status, 202);
    const events = await eventsFor(submittedId);
    assert.equal(events.length, 1, "the observation is recorded as lineage");
    assert.equal(events[0].source, "collection_account");
    const [invoice] = await getDb()
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, submittedId));
    assert.equal(
      invoice.status,
      "submitted",
      "submitted cannot transition to settled — the canTransition guard skips the CAS",
    );
    assert.deepEqual(
      await getDb()
        .select()
        .from(invoiceLifecycleEventsTable)
        .where(eq(invoiceLifecycleEventsTable.invoiceId, submittedId)),
      [],
      "no lifecycle row without a transition",
    );
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});

test("webhook: a replayed delivery is harmless and indistinguishable", async () => {
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    // Exact same delivery as the settling one. The invoice is now settled,
    // so it no longer matches the bindable statuses: the replay lands as an
    // unmatched audit (providers redeliver; the 202 must look identical).
    const resp = await post(
      asAdmin,
      "/collections/inbound",
      {
        accountReference: account.accountReference,
        amount: "500.00",
        invoiceNumber: STAMPED_NUM,
      },
      { "x-op-token": WEBHOOK_TOKEN },
    );
    assert.equal(resp.status, 202);
    assert.deepEqual(await resp.json(), { received: true });

    assert.equal(
      (await eventsFor(stampedId)).length,
      1,
      "no duplicate bound event for a settled invoice",
    );
    const [invoice] = await getDb()
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, stampedId));
    assert.equal(invoice.status, "settled", "still settled exactly once");
    const settledRows = await getDb()
      .select()
      .from(invoiceLifecycleEventsTable)
      .where(
        and(
          eq(invoiceLifecycleEventsTable.invoiceId, stampedId),
          eq(invoiceLifecycleEventsTable.toStatus, "settled"),
        ),
      );
    assert.equal(settledRows.length, 1, "a single settled transition, ever");
    assert.equal((await unmatchedAuditsFor(account.id)).length, 1);
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});

test("webhook: an unmatchable invoice number audits and applies nothing", async () => {
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    const auditsBefore = (await unmatchedAuditsFor(account.id)).length;
    // A DRAFT invoice's number: draft paper is not bindable — same path as a
    // number that exists nowhere.
    const result = await recordInboundCollection({
      accountReference: account.accountReference,
      amount: "10.00",
      invoiceNumber: DRAFT_NUM,
    });
    assert.deepEqual(result, { applied: false });
    const audits = await unmatchedAuditsFor(account.id);
    assert.equal(audits.length, auditsBefore + 1);
    // Pointer-only payload: a boolean, never the payer's free text.
    assert.deepEqual(audits[audits.length - 1].after, {
      hasInvoiceNumber: true,
    });
    assert.equal(
      audits[audits.length - 1].firmId,
      firmA,
      "the audit lands in the account's tenant",
    );
    // No event was bound anywhere for this delivery.
    assert.equal((await eventsFor(stampedId)).length, 1);
    assert.equal((await eventsFor(submittedId)).length, 1);
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});

test("deactivate: an idempotent CAS flip", async () => {
  const created = await post(asAdmin, "/collection-accounts", {
    clientPartyId: clientParty,
  });
  assert.equal(created.status, 201);
  deadAccount = (await created.json()) as AccountView;
  assert.equal(deadAccount.label, null, "label is optional");

  const first = await post(
    asAdmin,
    `/collection-accounts/${deadAccount.id}/deactivate`,
    {},
  );
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as AccountView).active, false);

  // Replay: same 200, same inactive row — never an error.
  const second = await post(
    asAdmin,
    `/collection-accounts/${deadAccount.id}/deactivate`,
    {},
  );
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as AccountView).active, false);

  const missing = await post(
    asAdmin,
    `/collection-accounts/${randomUUID()}/deactivate`,
    {},
  );
  assert.equal(missing.status, 404);
});

test("webhook: deactivated and unknown references are silently ignored", async () => {
  process.env.COLLECTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    const unmatchedBefore = await getDb()
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.action, "collections.unmatched"));

    // Deactivated account: applied false, and — unlike an unmatched invoice
    // on a LIVE account — no audit either (nothing distinguishes it from a
    // reference that never existed).
    assert.deepEqual(
      await recordInboundCollection({
        accountReference: deadAccount.accountReference,
        amount: "500.00",
        invoiceNumber: STAMPED_NUM,
      }),
      { applied: false },
    );
    // Unknown reference: identical.
    assert.deepEqual(
      await recordInboundCollection({
        accountReference: `CA-${SALT.toUpperCase()}NOPE`,
        amount: "500.00",
        invoiceNumber: STAMPED_NUM,
      }),
      { applied: false },
    );
    // And through the route both still answer 202 (anti-probe).
    const resp = await post(
      asAdmin,
      "/collections/inbound",
      {
        accountReference: deadAccount.accountReference,
        amount: "500.00",
        invoiceNumber: STAMPED_NUM,
      },
      { "x-op-token": WEBHOOK_TOKEN },
    );
    assert.equal(resp.status, 202);

    const unmatchedAfter = await getDb()
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.action, "collections.unmatched"));
    assert.equal(
      unmatchedAfter.length,
      unmatchedBefore.length,
      "dead/unknown references write no audit oracle",
    );
    assert.equal((await eventsFor(stampedId)).length, 1, "no event bound");
  } finally {
    delete process.env.COLLECTION_WEBHOOK_TOKEN;
  }
});
