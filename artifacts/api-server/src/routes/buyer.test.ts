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
  messagesTable,
} from "@workspace/db";
import buyerRouter from "./buyer.ts";
import invoicesRouter from "./invoices/index.ts";
import { setFlag } from "../modules/flags/flags.ts";
import { pointerEntityRef } from "../modules/messaging/recipient-ref.ts";
import { parseCsv } from "../lib/csv.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt, daysAgo } from "../test-helpers/fixtures.ts";
import { buyerPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

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
const MESSAGING_FLAG = "messaging_notifications";
let railsWasEnabled: boolean | null = null;
let confirmWasEnabled: boolean | null = null;
let messagingWasEnabled: boolean | null = null;

const firmId = randomUUID();
const staffUserId = randomUUID();
const buyerUser1 = randomUUID();
const buyerUser2 = randomUUID();
const supplier = randomUUID();
const evilSupplier = randomUUID(); // legal name is a formula-injection probe
const buyer1 = randomUUID();
const buyer2 = randomUUID();
const buyerNoTin = randomUUID();

const invFlagId = randomUUID(); // payment-flag target (stamped)
const invDraftId = randomUUID(); // draft — never buyer-visible / flaggable
const invConfirmId = randomUUID(); // confirmation happy path (stamped)
const invQueryId = randomUUID(); // query/re-request path (stamped)
const invNoTinId = randomUUID(); // TIN gate target (stamped)
const invB2Id = randomUUID(); // buyer two's invoice (scoping)
const invBulkAId = randomUUID(); // bulk confirm — open request, confirms
const invBulkBId = randomUUID(); // bulk confirm — no lineage, skips
const invBulkTinId = randomUUID(); // bulk confirm — unvalidated buyer party
const invCsvInjId = randomUUID(); // CSV export — injection-shaped free text
const invNotifyId = randomUUID(); // confirmation-request notification target
const invNotifyDarkId = randomUUID(); // notification target while flag is dark

// CSV formula-injection probes (CWE-1236): tenant-authored free text opened
// in Excel by the buyer's staff.
const EVIL_SUPPLIER_NAME = `=Evil Supplier ${SALT}`;
const EVIL_INVOICE_NUMBER = `=2+5+BRT${SALT}`;

const admin: Principal = firmPrincipal(firmId, { userId: staffUserId });
const buyerOne: Principal = buyerPrincipal(buyer1, { userId: buyerUser1 });
const buyerTwo: Principal = buyerPrincipal(buyer2, { userId: buyerUser2 });
const buyerNoTinUser: Principal = buyerPrincipal(buyerNoTin, {
  userId: buyerUser2,
});

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
    await getDb()
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, key));
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
  messagingWasEnabled = await saveAndEnable(MESSAGING_FLAG);
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
    {
      id: evilSupplier,
      type: "client_business",
      legalName: EVIL_SUPPLIER_NAME,
      tin: "10000000-0032",
      tinValidated: true,
    },
  ]);
  await db.insert(invoicesTable).values([
    invoiceSeed({ id: invFlagId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invDraftId, buyerPartyId: buyer1, status: "draft" }),
    invoiceSeed({ id: invConfirmId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invQueryId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({
      id: invNoTinId,
      buyerPartyId: buyerNoTin,
      status: "stamped",
    }),
    invoiceSeed({ id: invB2Id, buyerPartyId: buyer2, status: "submitted" }),
    invoiceSeed({ id: invBulkAId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({ id: invBulkBId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({
      id: invBulkTinId,
      buyerPartyId: buyerNoTin,
      status: "stamped",
    }),
    invoiceSeed({ id: invNotifyId, buyerPartyId: buyer1, status: "stamped" }),
    invoiceSeed({
      id: invNotifyDarkId,
      buyerPartyId: buyer1,
      status: "stamped",
    }),
    {
      // From the injection-named supplier, with an injection-shaped invoice
      // number and a due date — the CSV export must neutralize both cells.
      id: invCsvInjId,
      firmId,
      supplierPartyId: evilSupplier,
      buyerPartyId: buyer1,
      invoiceNumber: EVIL_INVOICE_NUMBER,
      issueDate: "2026-07-01",
      dueDate: "2026-08-01",
      status: "stamped" as never,
      grandTotal: "120000.00",
      subtotal: "111627.91",
      vatTotal: "8372.09",
    },
  ]);
});

after(async () => {
  await restore(RAILS_FLAG, railsWasEnabled);
  await restore(CONFIRM_FLAG, confirmWasEnabled);
  await restore(MESSAGING_FLAG, messagingWasEnabled);
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

  const partialPaid = await fetch(
    `${base}/invoices/${invFlagId}/payment-flags`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ paymentStatus: "paid", amount: "119999.99" }),
    },
  );
  assert.equal(partialPaid.status, 400);
  assert.match(
    ((await partialPaid.json()) as { error: string }).error,
    /cover the invoice total/,
  );
  assert.equal(
    await invoiceStatus(invFlagId),
    "stamped",
    "a partial paid flag cannot settle the invoice",
  );

  // `paid` settles the invoice (stamped → settled is an allowed transition).
  const paid = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid", amount: "120000.00" }),
  });
  assert.equal(paid.status, 201);
  const paidBody = (await paid.json()) as { id: string };
  assert.equal(await invoiceStatus(invFlagId), "settled");

  // A repeated `paid` flag is an idempotent replay; the event identity and CAS
  // guard never produces a second transition (settled → settled is invalid).
  const again = await fetch(`${base}/invoices/${invFlagId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid" }),
  });
  assert.equal(again.status, 201);
  const againBody = (await again.json()) as { id: string };
  assert.equal(againBody.id, paidBody.id, "a retry returns the first event");
  assert.equal(await invoiceStatus(invFlagId), "settled");

  const events = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, invFlagId));
  assert.equal(events.length, 2, "a retry cannot append another paid flag");
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
  assert.match(
    ((await badAmount.json()) as { error: string }).error,
    /positive decimal string/,
  );

  const draft = await fetch(`${base}/invoices/${invDraftId}/payment-flags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ paymentStatus: "paid" }),
  });
  assert.equal(draft.status, 409);
  assert.match(
    ((await draft.json()) as { error: string }).error,
    /only stamped, confirmed or settled invoices/,
  );
});

test("confirmation respond flow: open request, method, CAS to confirmed", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const buyerBase = await listen(appFor(buyerOne, invoicesRouter));

  const respond = (
    base: string,
    invoiceId: string,
    body: Record<string, unknown>,
  ) =>
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
  assert.match(
    ((await early.json()) as { error: string }).error,
    /requires an open request/,
  );

  // The supplier firm raises the request on the stamped invoice.
  const requested = await respond(staffBase, invConfirmId, {
    state: "requested",
  });
  assert.equal(requested.status, 201);

  // A mismatched body buyerPartyId can never re-point the confirmation.
  const mismatch = await fetch(
    `${buyerBase}/invoices/${invConfirmId}/confirmations`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        buyerPartyId: buyer2,
        state: "confirmed",
        method: "portal",
      }),
    },
  );
  assert.equal(mismatch.status, 409);
  assert.match(
    ((await mismatch.json()) as { error: string }).error,
    /must match the invoice buyer/,
  );

  // A response must state its method.
  const noMethod = await respond(buyerBase, invConfirmId, {
    state: "confirmed",
  });
  assert.equal(noMethod.status, 400);
  assert.match(
    ((await noMethod.json()) as { error: string }).error,
    /must state its method/,
  );

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
  assert.match(
    ((await reRespond.json()) as { error: string }).error,
    /requires an open request/,
  );
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
  assert.match(
    ((await respondAfterQuery.json()) as { error: string }).error,
    /requires an open request/,
  );
  assert.equal((await post(staffBase, { state: "requested" })).status, 201);
});

test("TIN gate: an unvalidated buyer party never enters the workflow", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const request = await fetch(
    `${staffBase}/invoices/${invNoTinId}/confirmations`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ buyerPartyId: buyerNoTin, state: "requested" }),
    },
  );
  assert.equal(request.status, 422);
  assert.match(
    ((await request.json()) as { error: string }).error,
    /Buyer TIN must be validated/,
  );

  // Even with a request forced into the lineage, the responder hits the same
  // gate — the check runs before the state machine.
  await getDb().insert(confirmationsTable).values({
    invoiceId: invNoTinId,
    buyerPartyId: buyerNoTin,
    state: "requested",
  });
  const noTinBase = await listen(appFor(buyerNoTinUser, invoicesRouter));
  const respond = await fetch(
    `${noTinBase}/invoices/${invNoTinId}/confirmations`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        buyerPartyId: buyerNoTin,
        state: "confirmed",
        method: "portal",
      }),
    },
  );
  assert.equal(respond.status, 422);
  assert.match(
    ((await respond.json()) as { error: string }).error,
    /Buyer TIN must be validated/,
  );
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
  const crossFlag = await fetch(
    `${base2}/invoices/${invConfirmId}/payment-flags`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ paymentStatus: "paid" }),
    },
  );
  assert.equal(crossFlag.status, 403);
  assert.match(
    ((await crossFlag.json()) as { error: string }).error,
    /not addressed to your buyer organization/,
  );
});

test("buyer invoice reads are bounded, searchable, summarized and tenant-scoped", async () => {
  const base1 = await listen(appFor(buyerOne, buyerRouter));
  const base2 = await listen(appFor(buyerTwo, buyerRouter));

  const first = (await (
    await fetch(`${base1}/buyer/invoices?limit=2&offset=0`)
  ).json()) as { id: string }[];
  const second = (await (
    await fetch(`${base1}/buyer/invoices?limit=2&offset=2`)
  ).json()) as { id: string }[];
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(
    first.filter((row) => second.some((candidate) => candidate.id === row.id)),
    [],
    "stable pages cannot overlap",
  );
  assert.equal((await fetch(`${base1}/buyer/invoices?limit=201`)).status, 400);

  const searched = (await (
    await fetch(
      `${base1}/buyer/invoices?search=${encodeURIComponent(EVIL_INVOICE_NUMBER)}`,
    )
  ).json()) as { id: string }[];
  assert.deepEqual(
    searched.map((row) => row.id),
    [invCsvInjId],
  );
  const literalWildcard = (await (
    await fetch(`${base1}/buyer/invoices?search=${encodeURIComponent("%_")}`)
  ).json()) as unknown[];
  assert.equal(
    literalWildcard.length,
    0,
    "search wildcards are treated literally",
  );

  const full = (await (
    await fetch(`${base1}/buyer/invoices?limit=200`)
  ).json()) as { id: string }[];
  const summary = (await (
    await fetch(`${base1}/buyer/invoices/summary`)
  ).json()) as {
    total: number;
    counts: Record<string, number>;
  };
  assert.equal(summary.total, full.length);
  assert.equal(
    Object.values(summary.counts).reduce((sum, count) => sum + count, 0),
    summary.total,
  );

  assert.equal(
    (await fetch(`${base1}/buyer/invoices/${invConfirmId}`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${base2}/buyer/invoices/${invConfirmId}`)).status,
    404,
  );
});

interface BulkItem {
  invoiceId: string;
  status: "confirmed" | "skipped";
  reason: string | null;
}

test("bulk confirm: per-item outcomes — one bad row never aborts (or silently passes) the batch", async () => {
  const base1 = await listen(appFor(buyerOne, buyerRouter));
  await getDb().insert(confirmationsTable).values({
    invoiceId: invBulkAId,
    buyerPartyId: buyer1,
    state: "requested",
  });

  const unknownId = randomUUID();
  const res = await fetch(`${base1}/buyer/confirmations/bulk`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      invoiceIds: [invBulkAId, invBulkBId, invB2Id, unknownId, invBulkAId],
      method: "portal-bulk",
      noSetOff: true,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    confirmed: number;
    skipped: number;
    items: BulkItem[];
  };
  assert.equal(body.confirmed, 1);
  assert.equal(body.skipped, 4);
  assert.equal(body.items.length, 5, "one result per requested id, in order");

  // The open request confirms with the exact single-response semantics.
  assert.deepEqual(body.items[0], {
    invoiceId: invBulkAId,
    status: "confirmed",
    reason: null,
  });
  assert.equal(await invoiceStatus(invBulkAId), "confirmed");
  const rowsA = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, invBulkAId));
  const confirmedRow = rowsA.find((r) => r.state === "confirmed");
  assert.ok(confirmedRow, "the append-only confirmed row exists");
  assert.equal(confirmedRow.method, "portal-bulk");
  assert.equal(confirmedRow.noSetOff, true);
  assert.equal(confirmedRow.confirmingUserId, buyerUser1, "BR-02 lineage");

  // No open request → skipped with the single-path refusal, nothing written.
  assert.equal(body.items[1].status, "skipped");
  assert.match(body.items[1].reason ?? "", /requires an open request/);
  assert.equal(await invoiceStatus(invBulkBId), "stamped");
  const rowsB = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, invBulkBId));
  assert.equal(rowsB.length, 0, "the skipped item's savepoint rolled back");

  // Another buyer's invoice is refused per item — the batch continues.
  assert.equal(body.items[2].status, "skipped");
  assert.match(
    body.items[2].reason ?? "",
    /not addressed to your buyer organization/,
  );
  assert.equal(await invoiceStatus(invB2Id), "submitted");

  // An unknown id is reported, never silently dropped.
  assert.equal(body.items[3].status, "skipped");
  assert.match(body.items[3].reason ?? "", /not found/i);

  // The duplicate finds the lane its first occurrence just closed.
  assert.equal(body.items[4].status, "skipped");
  assert.match(body.items[4].reason ?? "", /requires an open request/);

  // The TIN gate holds inside the batch exactly as on the single path.
  await getDb().insert(confirmationsTable).values({
    invoiceId: invBulkTinId,
    buyerPartyId: buyerNoTin,
    state: "requested",
  });
  const noTinBase = await listen(appFor(buyerNoTinUser, buyerRouter));
  const tinRes = await fetch(`${noTinBase}/buyer/confirmations/bulk`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ invoiceIds: [invBulkTinId], method: "portal" }),
  });
  assert.equal(tinRes.status, 200);
  const tinBody = (await tinRes.json()) as {
    confirmed: number;
    items: BulkItem[];
  };
  assert.equal(tinBody.confirmed, 0);
  assert.match(tinBody.items[0].reason ?? "", /TIN must be validated/);
  assert.equal(await invoiceStatus(invBulkTinId), "stamped");

  // The capability gate: a firm principal cannot respond for a buyer.
  const staffBase = await listen(appFor(admin, buyerRouter));
  const staffRes = await fetch(`${staffBase}/buyer/confirmations/bulk`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ invoiceIds: [invBulkBId], method: "portal" }),
  });
  assert.equal(staffRes.status, 403);
});

test("pending-confirmations CSV: awaiting-only rows, buyer-scoped, formula injection neutralized", async () => {
  const base1 = await listen(appFor(buyerOne, buyerRouter));
  const requestedAt = new Date(Date.now() - 5 * 60_000);
  await getDb().insert(confirmationsTable).values({
    invoiceId: invCsvInjId,
    buyerPartyId: buyer1,
    state: "requested",
    createdAt: requestedAt,
  });

  const res = await fetch(`${base1}/buyer/confirmations/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /attachment; filename="pending-confirmations\.csv"/,
  );
  // fetch's text() strips a leading BOM per the WHATWG encoding spec, so the
  // Excel-friendliness check reads the raw bytes.
  const raw = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(
    [...raw.slice(0, 3)],
    [0xef, 0xbb, 0xbf],
    "BOM for Excel UTF-8",
  );
  const text = new TextDecoder().decode(raw.slice(3));
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], [
    "invoiceNumber",
    "supplierName",
    "issueDate",
    "dueDate",
    "currency",
    "grandTotal",
    "requestedAt",
  ]);

  // Only invoices whose LATEST lineage row is `requested` appear: the
  // re-requested invoice and the freshly seeded one — never the confirmed,
  // settled, lineage-less or draft ones, and never another buyer's book.
  const numbers = rows.slice(1).map((r) => r[0]);
  assert.ok(numbers.includes(`BRT-${invQueryId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invConfirmId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invBulkAId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invBulkBId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invFlagId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invDraftId.slice(0, 8)}-${SALT}`));
  assert.ok(!numbers.includes(`BRT-${invB2Id.slice(0, 8)}-${SALT}`));

  // CWE-1236: the formula-shaped invoice number and supplier name are
  // apostrophe-prefixed so Excel renders text, not a live formula — no cell
  // in the file may open with a bare `=`.
  const injRow = rows.slice(1).find((r) => r[0] === `'${EVIL_INVOICE_NUMBER}`);
  assert.ok(injRow, "the injection-shaped invoice is present, neutralized");
  assert.equal(injRow[1], `'${EVIL_SUPPLIER_NAME}`);
  assert.equal(injRow[2], "2026-07-01");
  assert.equal(injRow[3], "2026-08-01");
  assert.equal(injRow[4], "NGN");
  assert.equal(injRow[5], "120000.00");
  assert.equal(injRow[6], requestedAt.toISOString());
  for (const line of text.split("\r\n")) {
    assert.ok(!line.startsWith("="), "no leading formula trigger survives");
  }
  assert.ok(!text.includes(",="), "no mid-row cell opens a formula either");

  // Buyer two awaits nothing: header only — buyer one's book never leaks.
  const base2 = await listen(appFor(buyerTwo, buyerRouter));
  const res2 = await fetch(`${base2}/buyer/confirmations/export`);
  assert.equal(res2.status, 200);
  assert.equal(parseCsv(await res2.text()).length, 1);
});

test("supplier drill-down: same numbers as the breakdown, own-book invoices only, foreign supplier 404", async () => {
  const base1 = await listen(appFor(buyerOne, buyerRouter));
  const base2 = await listen(appFor(buyerTwo, buyerRouter));

  // The breakdown entry and the drill-down aggregate must be the same
  // numbers — supplierSummaryOf is the single aggregation behind both.
  const list = await fetch(`${base1}/buyer/suppliers`);
  assert.equal(list.status, 200);
  const entries = (await list.json()) as Record<string, unknown>[];
  const listEntry = entries.find((e) => e.supplierPartyId === supplier);
  assert.ok(listEntry);

  const detailRes = await fetch(`${base1}/buyer/suppliers/${supplier}`);
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as {
    supplier: Record<string, unknown>;
    invoices: {
      id: string;
      supplierPartyId: string;
      confirmationState: string;
      stampValid: boolean;
    }[];
  };
  assert.deepEqual(detail.supplier, listEntry);

  const ids = new Set(detail.invoices.map((i) => i.id));
  assert.ok(ids.has(invFlagId));
  assert.ok(ids.has(invConfirmId));
  assert.ok(ids.has(invBulkAId));
  assert.ok(!ids.has(invDraftId), "drafts never leave the supplier firm");
  assert.ok(!ids.has(invB2Id), "another buyer's invoice is invisible");
  assert.ok(!ids.has(invCsvInjId), "another supplier's invoice never mixes in");
  assert.ok(detail.invoices.every((i) => i.supplierPartyId === supplier));
  const bulkRow = detail.invoices.find((i) => i.id === invBulkAId);
  assert.equal(bulkRow?.confirmationState, "confirmed");

  // Buyer two drilling into the SHARED supplier sees only its own invoice.
  const detail2Res = await fetch(`${base2}/buyer/suppliers/${supplier}`);
  assert.equal(detail2Res.status, 200);
  const detail2 = (await detail2Res.json()) as { invoices: { id: string }[] };
  assert.deepEqual(
    detail2.invoices.map((i) => i.id),
    [invB2Id],
  );

  // A supplier that never invoiced the caller is a plain 404 — whether it
  // exists for another buyer or not at all.
  assert.equal(
    (await fetch(`${base2}/buyer/suppliers/${evilSupplier}`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${base1}/buyer/suppliers/${randomUUID()}`)).status,
    404,
  );
});

test("confirmation request stamps a pointer-only notification for the buyer party; dark flag writes no row", async () => {
  const staffBase = await listen(appFor(admin, invoicesRouter));
  const invPointer = pointerEntityRef("inv", invNotifyId);
  const rowsFor = () =>
    getDb()
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.recipientPartyId, buyer1),
          eq(messagesTable.templateKey, "confirmation_request"),
          eq(messagesTable.entityId, invPointer),
        ),
      );
  const beforeCount = (await rowsFor()).length;

  const requested = await fetch(
    `${staffBase}/invoices/${invNotifyId}/confirmations`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ buyerPartyId: buyer1, state: "requested" }),
    },
  );
  assert.equal(requested.status, 201);

  const after = await rowsFor();
  assert.equal(after.length, beforeCount + 1, "exactly one send per request");
  const msg = after[after.length - 1];
  // The ledger row's REAL identity is the buyer-party stamp — the feed
  // resolves by it; the ref and entity pointer stay display/correlation only
  // (SEC-12: letters-only derivations, never the raw ids, never amounts).
  assert.equal(msg.recipientPartyId, buyer1);
  assert.equal(msg.recipientUserId, null);
  assert.equal(msg.channel, "email");
  assert.equal(msg.recipientRef, pointerEntityRef("pty", buyer1));
  assert.equal(msg.entityType, "invoice");
  assert.equal(msg.status, "sent");

  // Dark messaging flag: the request itself still lands (201, lineage row),
  // but no message row exists anywhere for it (PL-02 — flag off = rail dark).
  await setFlag(MESSAGING_FLAG, false);
  try {
    const allBefore = (
      await getDb()
        .select({ id: messagesTable.id })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.recipientPartyId, buyer1),
            eq(messagesTable.templateKey, "confirmation_request"),
          ),
        )
    ).length;
    const dark = await fetch(
      `${staffBase}/invoices/${invNotifyDarkId}/confirmations`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ buyerPartyId: buyer1, state: "requested" }),
      },
    );
    assert.equal(
      dark.status,
      201,
      "the confirmation request never depends on messaging",
    );
    const allAfter = (
      await getDb()
        .select({ id: messagesTable.id })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.recipientPartyId, buyer1),
            eq(messagesTable.templateKey, "confirmation_request"),
          ),
        )
    ).length;
    assert.equal(allAfter, allBefore, "dark flag = no ledger row");
  } finally {
    await setFlag(MESSAGING_FLAG, true);
  }
});
