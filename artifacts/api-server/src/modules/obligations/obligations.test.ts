import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  firmsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  OBLIGATION_DUE_SOON_DAYS,
  countOpenObligations,
  createObligation,
  getObligation,
  listObligations,
  openObligationSamples,
  updateObligationStatus,
} from "./obligations.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The obligations domain module: create/list/status lifecycle, date and
// amount validation, the single fact function's FILTER math around the Lagos
// today, and the SEC-03 client narrowing. Fixtures are salted and every
// assertion is scoped to this run's own firm ids — the shared DB persists
// across runs and sibling suites.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
// A dedicated firm for the count math so its FILTER counts stay exact.
const countFirmId = randomUUID();
const partyA = randomUUID();
const partyB = randomUUID();
const userId = randomUUID();

// Exact Lagos calendar dates (WAT is fixed UTC+1, no DST) so the day-boundary
// predicates are tested without flakiness.
function lagosDateOffset(days: number): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `obl-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Obligation Firm ${SALT}` },
    { id: otherFirmId, name: `Obligation Firm B ${SALT}` },
    { id: countFirmId, name: `Obligation Count Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: partyA,
      type: "client_business",
      legalName: `Obligation Client A ${SALT}`,
    },
    {
      id: partyB,
      type: "client_business",
      legalName: `Obligation Client B ${SALT}`,
    },
  ]);
});

function input(over: Partial<Parameters<typeof createObligation>[1]> = {}) {
  return {
    clientPartyId: partyA,
    noticeType: "assessment",
    authority: "firs",
    responseDueDate: lagosDateOffset(10),
    ...over,
  };
}

test("create/list/status lifecycle with audit events", async () => {
  const created = await createObligation(
    firmId,
    input({
      reference: `NOTICE-${SALT}`,
      taxType: "vat",
      amount: "120000.00",
      currency: "NGN",
      issueDate: lagosDateOffset(-5),
      notes: "arrived by courier",
    }),
    userId,
  );
  assert.equal(created.firmId, firmId);
  assert.equal(created.status, "open");
  assert.equal(created.responseDueDate, lagosDateOffset(10));
  assert.equal(created.amount, "120000.00");
  assert.equal(created.createdBy, userId);

  const fetched = await getObligation(created.id);
  assert.equal(fetched?.id, created.id);
  assert.equal(await getObligation(randomUUID()), null);

  const listed = await listObligations(firmId);
  assert.ok(listed.some((o) => o.id === created.id));

  const updated = await updateObligationStatus(
    created.id,
    firmId,
    "responded",
    "objection filed",
    userId,
  );
  assert.equal(updated?.status, "responded");
  assert.equal(updated?.notes, "objection filed");
  // Omitted notes keep the stored text.
  const closed = await updateObligationStatus(
    created.id,
    firmId,
    "closed",
    undefined,
    userId,
  );
  assert.equal(closed?.status, "closed");
  assert.equal(closed?.notes, "objection filed");

  // A foreign firm's id updates zero rows — the route's 404 path.
  assert.equal(
    await updateObligationStatus(created.id, otherFirmId, "open", undefined, userId),
    null,
  );
  assert.equal((await getObligation(created.id))?.status, "closed");

  // Audit: one create event and one status event per transition.
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "obligation"),
        eq(auditEventsTable.entityId, created.id),
      ),
    );
  assert.equal(
    events.filter((e) => e.action === "obligation.create").length,
    1,
  );
  assert.equal(
    events.filter((e) => e.action === "obligation.status").length,
    2,
  );
  const statusEvent = events.find(
    (e) =>
      e.action === "obligation.status" &&
      (e.after as { status: string }).status === "responded",
  );
  assert.deepEqual(statusEvent?.before, { status: "open" });
});

test("date and amount validation reject malformed input before the DB sees it", async () => {
  for (const bad of ["30/07/2026", "2026-7-1", "not-a-date", "2026-02-30"]) {
    await assert.rejects(
      createObligation(firmId, input({ responseDueDate: bad }), userId),
      (err: unknown) =>
        err instanceof DomainError &&
        err.code === "OBLIGATION_BAD_DATE" &&
        err.status === 400,
      `responseDueDate ${bad} must be rejected`,
    );
  }
  await assert.rejects(
    createObligation(firmId, input({ issueDate: "07-30-2026" }), userId),
    (err: unknown) =>
      err instanceof DomainError && err.code === "OBLIGATION_BAD_DATE",
    "issueDate is validated too",
  );
  await assert.rejects(
    createObligation(firmId, input({ amount: "12,000" }), userId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "OBLIGATION_BAD_AMOUNT" &&
      err.status === 400,
    "amount must be a plain decimal",
  );
});

test("listObligations orders by deadline, filters by status/client and honours limit/offset", async () => {
  const late = await createObligation(
    firmId,
    input({ clientPartyId: partyB, responseDueDate: lagosDateOffset(30) }),
    userId,
  );
  const early = await createObligation(
    firmId,
    input({ clientPartyId: partyB, responseDueDate: lagosDateOffset(2) }),
    userId,
  );
  const mid = await createObligation(
    firmId,
    input({ clientPartyId: partyB, responseDueDate: lagosDateOffset(15) }),
    userId,
  );

  // SEC-03 narrowing: the party filter confines the list to that client.
  const forB = await listObligations(firmId, { clientPartyId: partyB });
  assert.deepEqual(
    forB.map((o) => o.id),
    [early.id, mid.id, late.id],
    "soonest deadline first, stable order",
  );
  assert.ok(forB.every((o) => o.clientPartyId === partyB));

  const openOnly = await listObligations(firmId, {
    clientPartyId: partyB,
    status: "open",
  });
  assert.equal(openOnly.length, 3);
  await updateObligationStatus(mid.id, firmId, "closed", undefined, userId);
  assert.equal(
    (await listObligations(firmId, { clientPartyId: partyB, status: "open" }))
      .length,
    2,
  );

  const page = await listObligations(firmId, {
    clientPartyId: partyB,
    limit: 1,
    offset: 1,
  });
  assert.deepEqual(page.map((o) => o.id), [mid.id]);

  // A foreign firm sees nothing of this firm's book.
  assert.equal(
    (await listObligations(otherFirmId, { clientPartyId: partyB })).length,
    0,
  );
});

test("countOpenObligations: one SQL pass over the Lagos calendar", async () => {
  // Seeded around lagos-today: due today and due at the window edge are
  // due-soon; past the window edge is open-but-quiet; yesterday is overdue;
  // responded/closed rows never count.
  await createObligation(
    countFirmId,
    input({ responseDueDate: lagosDateOffset(0) }),
    userId,
  );
  await createObligation(
    countFirmId,
    input({ responseDueDate: lagosDateOffset(OBLIGATION_DUE_SOON_DAYS) }),
    userId,
  );
  await createObligation(
    countFirmId,
    input({ responseDueDate: lagosDateOffset(OBLIGATION_DUE_SOON_DAYS + 1) }),
    userId,
  );
  await createObligation(
    countFirmId,
    input({ responseDueDate: lagosDateOffset(-1) }),
    userId,
  );
  const responded = await createObligation(
    countFirmId,
    input({ responseDueDate: lagosDateOffset(-10) }),
    userId,
  );
  await updateObligationStatus(
    responded.id,
    countFirmId,
    "responded",
    undefined,
    userId,
  );

  const counts = await countOpenObligations(countFirmId);
  assert.equal(counts.open, 4);
  assert.equal(counts.dueSoon, 2, "today and today+window are both due-soon");
  assert.equal(counts.overdue, 1, "overdue starts the day AFTER the due date");
  assert.equal(counts.nearestDue, lagosDateOffset(-1));

  // The client pin: partyA owns everything here, partyB nothing.
  const pinned = await countOpenObligations(countFirmId, partyB);
  assert.deepEqual(pinned, {
    open: 0,
    dueSoon: 0,
    overdue: 0,
    nearestDue: null,
  });
  const own = await countOpenObligations(countFirmId, partyA);
  assert.equal(own.open, 4);
});

test("openObligationSamples: open rows, newest deadline first, capped", async () => {
  const samples = await openObligationSamples(countFirmId, partyA);
  assert.equal(samples.length, 4, "the responded row stays out");
  assert.deepEqual(
    samples.map((s) => s.responseDueDate),
    [
      lagosDateOffset(OBLIGATION_DUE_SOON_DAYS + 1),
      lagosDateOffset(OBLIGATION_DUE_SOON_DAYS),
      lagosDateOffset(0),
      lagosDateOffset(-1),
    ],
    "newest deadline first",
  );
  for (const s of samples) {
    assert.equal(s.authority, "firs");
    assert.equal(s.noticeType, "assessment");
    assert.ok("reference" in s && "id" in s);
  }
  assert.equal((await openObligationSamples(countFirmId, partyA, 2)).length, 2);
});
