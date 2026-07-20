import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  firmsTable,
  partiesTable,
  usersTable,
  invoicesTable,
  confirmationsTable,
  settlementEventsTable,
  invoiceLifecycleEventsTable,
} from "@workspace/db";
import buyerRouter from "./buyer.ts";
import invoicesRouter from "./invoices.ts";
import { setFlag } from "../modules/flags/flags.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt, daysAgo } from "../test-helpers/fixtures.ts";

// Buyer Rails server behaviour (BR-02, BR-04, BR-05):
//  - payment flags are append-only settlement lineage; a `paid` flag settles
//    the invoice through a compare-and-set, and a repeat flag never records a
//    second transition;
//  - the confirmation respond flow: confirm CAS→confirmed, responses need an
//    open request (NO_OPEN_REQUEST) and a stated method, the TIN gate fails
//    closed (TIN_NOT_VALIDATED), and a query re-opens the request lane;
//  - every buyer surface is scoped to the caller's own buyer Party — another
//    buyer's book is invisible and cross-buyer writes are 403.

const SALT = makeRunSalt();

const RAILS_FLAG = "buyer_rails";
const CONFIRM_FLAG = "buyer_confirmations";
let railsWasEnabled: boolean | null = null;
let confirmWasEnabled: boolean | null = null;

const firmId = randomUUID();
const staffUserId = randomUUID();
const buyerUser1 = randomUUID();
const buyerUser2 = randomUUID();
const supplier = randomUUID();
const buyer1 = randomUUID();
const buyer2 = randomUUID();
const buyerNoTin = randomUUID();

const invFlagId = randomUUID(); // payment-flag target (stamped)
const invDraftId = randomUUID(); // draft — never buyer-visible / flaggable
const invConfirmId = randomUUID(); // confirmation happy path (stamped)
const invQueryId = randomUUID(); // query/re-request path (stamped)
const invNoTinId = randomUUID(); // TIN gate target (stamped)
const invB2Id = randomUUID(); // buyer two's invoice (scoping)

const admin: Principal = {
  userId: staffUserId,
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const buyerOne: Principal = {
  userId: buyerUser1,
  role: "buyer_user",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: buyer1,
};
const buyerTwo: Principal = {
  userId: buyerUser2,
  role: "buyer_user",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: buyer2,
};
const buyerNoTinUser: Principal = {
  userId: buyerUser2,
  role: "buyer_user",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: buyerNoTin,
};

async function saveAndEnable(key: string): Promise<boolean | null> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, key))
    .limit(1);
  await db
    .insert(featureFlagsTable)
    .values({ key, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  return existing ? existing.enabled : null;
}

async function restore(key: string, was: boolean | null): Promise<void> {
  if (was === null) {
    await getDb().delete(featureFlagsTable).where(eq(featureFlagsTable.key, key));
  } else {
    await setFlag(key, was);
  }
}

function invoiceSeed(over: {
  id: string;
  buyerPartyId: string;
  status: string;
  issueDate?: string;
}) {
  return {
    id: over.id,
    firmId,
    supplierPartyId: supplier,
    buyerPartyId: over.buyerPartyId,
    invoiceNumber: `BRT-${over.id.slice(0, 8)}-${SALT}`,
    issueDate: over.issueDate ?? daysAgo(10),
    status: over.status as never,
    grandTotal: "120000.00",
    subtotal: "111627.91",
    vatTotal: "8372.09",
  };
}

before(async () => {
  railsWasEnabled = await saveAndEnable(RAILS_FLAG);
  confirmWasEnabled = await saveAndEnable(CONFIRM_FLAG);
  const db = getDb();
  await db
    .insert(usersTable)
    .values([
      { id: staffUserId, email: `brt-staff-${SALT}@test.local` },
      { id: buyerUser1, email: `brt-b1-${SALT}@test.local` },
      { id: buyerUser2, email: `brt-b2-${SALT}@test.local` },
    ])
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `BRT Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `BRT Supplier ${SALT}`,
      tin: "10000000-0031",
      tinValidated: true,
    },
    {
      id: buyer1,
      type: "buyer",
      legalName: `BRT Buyer One ${SALT}`,
      tin: "20000000-0031",
      tinValidated: true,
    },
    {
      id: buyer2,
      type: "buyer",
      legalName: `BRT Buyer Two ${SALT}`,
      tin: "20000000-0032",
      tinValidated: true,
    },
    {
      id: buyerNoTin,
      type: "buyer",
      legalName: `BRT Buyer NoTin ${SALT}`,
      tinValidated: false,
    },
  ]);
  await db.insert(invoicesTable).values([
    invoiceSeed({ id: invFlagId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invDraftId, buyerPartyId: buyer1, status: "draft" }),
    invoiceSeed({ id: invConfirmId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invQueryId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invNoTinId, buyerPartyId: buyerNoTin, status: "stamped" }),
    invoiceSeed({ id: invB2Id, buyerPartyId: buyer2, status: "submitted" }),
  ]);
});

after(async () => {
  await restore(RAILS_FLAG, railsWasEnabled);
  await restore(CONFIRM_FLAG, confirmWasEnabled);
  await closeAllServers();
});

async function invoiceStatus(id: string): Promise<string> {
  const [row] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id))
    .limit(1);
  return row.status;
}

test("payment flags: scheduled then paid settles once via CAS, lineage append-only", async () => {
  const base = await listen(appFor(buyerOne, buyerRouter));

  // `scheduled` is an intent signal: one event, no transition.
  const scheduled = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "scheduled" }),
  });
  assert.equal(scheduled.status, 201);
  const scheduledBody = (await scheduled.json()) as {
    paymentStatus: string;
    amount: string;
  };
  assert.equal(scheduledBody.paymentStatus, "scheduled");
  assert.equal(
    scheduledBody.amount,
    "120000.00",
    "amount defaults to the invoice grand total",
  );
  assert.equal(await invoiceStatus(invFlagId), "stamped");

  // `paid` settles the invoice (stamped → settled is an allowed transition).
  const paid = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid", amount: "120000.00" }),
  });
  assert.equal(paid.status, 201);
  assert.equal(await invoiceStatus(invFlagId), "settled");

  // A repeat `paid` flag on the settled invoice records lineage but the CAS
  // guard never produces a second transition (settled → settled is invalid).
  const again = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid" }),
  });
  assert.equal(again.status, 201);
  assert.equal(await invoiceStatus(invFlagId), "settled");

  const events = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, invFlagId));
  assert.equal(events.length, 3, "every flag is one append-only event");
  assert.ok(events.every((e) => e.source === "buyer_flag"));
  assert.ok(events.every((e) => e.actorId === buyerUser1));

  const transitions = await getDb()
    .select()
    .from(invoiceLifecycleEventsTable)
    .where(
      and(
        eq(invoiceLifecycleEventsTable.invoiceId, invFlagId),
        eq(invoiceLifecycleEventsTable.toStatus, "settled"),
      ),
    );
  assert.equal(transitions.length, 1, "exactly one settled transition");
  assert.equal(transitions[0].fromStatus, "stamped");
  assert.equal(transitions[0].reason, "buyer_flag:paid");

  // Guard rails: non-decimal amounts and unflaggable statuses are rejected.
  const badAmount = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid", amount: "12.345" }),
  });
  assert.equal(badAmount.status, 400);
  assert.match(((await badAmount.json()) as { error: string }).error, /plain decimal string/);

  const draft = await fetch(`${base}/invoices/${invDraftId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid" }),
  });
  assert.equal(draft.status, 409);
  assert.match(((await draft.json()) as { error: string }).error, /only stamped, confirmed or settled invoices/);
});

test("confirmation respond flow: open request, method, CAS to confirmed", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const buyerBase = await listen(appFor(buyerOne, invoicesRouter));

  const respond = (base: string, invoiceId: string, body: Record<string, unknown>) =>
    fetch(`${base}/invoices/${invoiceId}/confirmations`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ buyerPartyId: buyer1, ...body }),
    });

  // A response with no open request is refused.
  const early = await respond(buyerBase, invConfirmId, {
    state: "confirmed",
    method: "portal",
  });
  assert.equal(early.status, 409);
  assert.match(((await early.json()) as { error: string }).error, /requires an open request/);

  // The supplier firm raises the request on the stamped invoice.
  const requested = await respond(staffBase, invConfirmId, { state: "requested" });
  assert.equal(requested.status, 201);

  // A mismatched body buyerPartyId can never re-point the confirmation.
  const mismatch = await fetch(`${buyerBase}/invoices/${invConfirmId}/confirmations`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ buyerPartyId: buyer2, state: "confirmed", method: "portal" }),
  });
  assert.equal(mismatch.status, 409);
  assert.match(((await mismatch.json()) as { error: string }).error, /must match the invoice buyer/);

  // A response must state its method.
  const noMethod = await respond(buyerBase, invConfirmId, { state: "confirmed" });
  assert.equal(noMethod.status, 400);
  assert.match(((await noMethod.json()) as { error: string }).error, /must state its method/);

  // Confirm: the row is recorded with the confirming user, and the invoice
  // moves stamped → confirmed through the compare-and-set.
  const confirmed = await respond(buyerBase, invConfirmId, {
    state: "confirmed",
    method: "portal",
  });
  assert.equal(confirmed.status, 201);
  const confirmedRow = (await confirmed.json()) as {
    state: string;
    confirmingUserId: string | null;
  };
  assert.equal(confirmedRow.state, "confirmed");
  assert.equal(confirmedRow.confirmingUserId, buyerUser1);
  assert.equal(await invoiceStatus(invConfirmId), "confirmed");

  // The lineage is closed: a second response finds no open request.
  const reRespond = await respond(buyerBase, invConfirmId, {
    state: "queried",
    method: "portal",
    note: "too late",
  });
  assert.equal(reRespond.status, 409);
  assert.match(((await reRespond.json()) as { error: string }).error, /requires an open request/);
});

test("query response stores the note, keeps status, and re-opens the request lane", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const buyerBase = await listen(appFor(buyerOne, invoicesRouter));
  const post = (base: string, body: Record<string, unknown>) =>
    fetch(`${base}/invoices/${invQueryId}/confirmations`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ buyerPartyId: buyer1, ...body }),
    });

  assert.equal((await post(staffBase, { state: "requested" })).status, 201);
  const queried = await post(buyerBase, {
    state: "queried",
    method: "portal",
    note: `Quantity mismatch ${SALT}`,
  });
  assert.equal(queried.status, 201);
  const queriedRow = (await queried.json()) as {
    state: string;
    note: string | null;
  };
  assert.equal(queriedRow.state, "queried");
  assert.equal(queriedRow.note, `Quantity mismatch ${SALT}`);
  assert.equal(
    await invoiceStatus(invQueryId),
    "stamped",
    "a query never transitions the invoice",
  );

  // The query closed the open request (no dangling respond lane) but allows
  // the supplier to re-request.
  const respondAfterQuery = await post(buyerBase, {
    state: "rejected",
    method: "portal",
    note: "still wrong",
  });
  assert.equal(respondAfterQuery.status, 409);
  assert.match(((await respondAfterQuery.json()) as { error: string }).error, /requires an open request/);
  assert.equal((await post(staffBase, { state: "requested" })).status, 201);
});

test("TIN gate: an unvalidated buyer party never enters the workflow", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const request = await fetch(`${staffBase}/invoices/${invNoTinId}/confirmations`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ buyerPartyId: buyerNoTin, state: "requested" }),
  });
  assert.equal(request.status, 422);
  assert.match(((await request.json()) as { error: string }).error, /Buyer TIN must be validated/);

  // Even with a request forced into the lineage, the responder hits the same
  // gate — the check runs before the state machine.
  await getDb().insert(confirmationsTable).values({
    invoiceId: invNoTinId,
    buyerPartyId: buyerNoTin,
    state: "requested",
  });
  const noTinBase = await listen(appFor(buyerNoTinUser, invoicesRouter));
  const respond = await fetch(`${noTinBase}/invoices/${invNoTinId}/confirmations`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ buyerPartyId: buyerNoTin, state: "confirmed", method: "portal" }),
  });
  assert.equal(respond.status, 422);
  assert.match(((await respond.json()) as { error: string }).error, /Buyer TIN must be validated/);
});

test("buyer scoping: a buyer_user sees only its own party's book", async () => {
  const base1 = await listen(appFor(buyerOne, buyerRouter));
  const base2 = await listen(appFor(buyerTwo, buyerRouter));

  const list1 = await fetch(`${base1}/buyer/invoices`);
  assert.equal(list1.status, 200);
  const ids1 = new Set(
    ((await list1.json()) as { id: string }[]).map((r) => r.id),
  );
  assert.ok(ids1.has(invFlagId));
  assert.ok(ids1.has(invConfirmId));
  assert.ok(!ids1.has(invDraftId), "drafts never leave the supplier firm");
  assert.ok(!ids1.has(invB2Id), "another buyer's invoice is invisible");

  const list2 = await fetch(`${base2}/buyer/invoices`);
  assert.equal(list2.status, 200);
  const rows2 = (await list2.json()) as { id: string }[];
  const ids2 = new Set(rows2.map((r) => r.id));
  assert.ok(ids2.has(invB2Id));
  assert.ok(!ids2.has(invFlagId));
  assert.ok(!ids2.has(invConfirmId));

  // The scoreboard is scoped the same way: buyer two sees only the book
  // addressed to it.
  const scoreboard2 = await fetch(`${base2}/buyer/scoreboard`);
  assert.equal(scoreboard2.status, 200);
  const entries2 = (await scoreboard2.json()) as {
    supplierPartyId: string;
    invoiceCount: number;
  }[];
  const supplierEntry = entries2.find((e) => e.supplierPartyId === supplier);
  assert.ok(supplierEntry);
  assert.equal(
    supplierEntry.invoiceCount,
    1,
    "only buyer two's own invoice counts",
  );

  // Cross-buyer writes are refused, before any state is touched.
  const crossFlag = await fetch(`${base2}/invoices/${invConfirmId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid" }),
  });
  assert.equal(crossFlag.status, 403);
  assert.match(((await crossFlag.json()) as { error: string }).error, /not addressed to your buyer organization/);
});
