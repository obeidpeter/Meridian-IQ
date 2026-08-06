import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clientComplianceProfilesTable,
  engagementsTable,
  firmsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import complianceProfileRouter from "../../routes/compliance-profile.ts";
import {
  complianceProfileSummary,
  getClientComplianceProfile,
  upsertComplianceProfile,
} from "./profile.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import {
  clientPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The Client Compliance Profile module + routes: the (firm, client) natural
// upsert behind the engagement wall (404 non-disclosure), the
// PROFILE_BAD_DATE guard, the pointer-only audit (facts, never notes), the
// live-client adoption summary, and the route postures (filing.read +
// SEC-03 pin on GET, filing.write on PUT, the console rollup posture on the
// summary). Fixtures are salted; every assertion is scoped to this run's
// firms.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const emptyFirmId = randomUUID();
const routeFirmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const archivedClient = randomUUID(); // archived engagement ONLY
const foreignClient = randomUUID(); // engaged by the OTHER firm
const routeClient = randomUUID();
const routeSibling = randomUUID();
const userId = randomUUID();

// Frozen clock for the non-future incorporationDate boundary.
const FROZEN_NOW = new Date("2026-08-06T12:00:00Z");

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `profile-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Profile Firm ${SALT}` },
    { id: otherFirmId, name: `Profile Firm B ${SALT}` },
    { id: emptyFirmId, name: `Profile Empty Firm ${SALT}` },
    { id: routeFirmId, name: `Profile Route Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values(
    [clientA, clientB, archivedClient, foreignClient, routeClient, routeSibling].map(
      (id, i) => ({
        id,
        type: "client_business" as const,
        legalName: `Profile Client ${i} ${SALT}`,
      }),
    ),
  );
  const engagement = (
    firm: string,
    client: string,
    status: "open" | "archived",
    title: string,
  ) => ({
    firmId: firm,
    clientPartyId: client,
    type: "retainer" as const,
    status,
    title: `${title} ${SALT}`,
  });
  await db.insert(engagementsTable).values([
    engagement(firmId, clientA, "open", "profile A"),
    engagement(firmId, clientB, "open", "profile B"),
    engagement(firmId, archivedClient, "archived", "profile archived"),
    engagement(otherFirmId, foreignClient, "open", "profile foreign"),
    engagement(routeFirmId, routeClient, "open", "profile route"),
    engagement(routeFirmId, routeSibling, "open", "profile route sibling"),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("get → null until asserted; upsert creates then UPDATES the one (firm, client) row", async () => {
  assert.equal(await getClientComplianceProfile(firmId, clientA), null);

  const created = await upsertComplianceProfile(
    firmId,
    clientA,
    {
      vatRegistered: true,
      payeEmployer: false,
      fyeMonth: 12,
      incorporationDate: "2020-03-15",
      notes: "asserted from the engagement letter",
    },
    userId,
    FROZEN_NOW,
  );
  assert.equal(created.vatRegistered, true);
  assert.equal(created.payeEmployer, false);
  assert.equal(created.fyeMonth, 12);
  assert.equal(created.incorporationDate, "2020-03-15");
  assert.equal(created.notes, "asserted from the engagement letter");
  assert.equal(created.updatedBy, userId);
  assert.equal((await getClientComplianceProfile(firmId, clientA))?.id, created.id);

  // Second PUT is the natural upsert: same row id, replaced facts; omitted
  // optionals clear (the PUT is a full assertion, not a patch).
  const updated = await upsertComplianceProfile(
    firmId,
    clientA,
    { vatRegistered: false, payeEmployer: true },
    userId,
    FROZEN_NOW,
  );
  assert.equal(updated.id, created.id);
  assert.equal(updated.vatRegistered, false);
  assert.equal(updated.payeEmployer, true);
  assert.equal(updated.fyeMonth, null);
  assert.equal(updated.incorporationDate, null);
  assert.equal(updated.notes, null);
  const all = await getDb()
    .select()
    .from(clientComplianceProfilesTable)
    .where(
      and(
        eq(clientComplianceProfilesTable.firmId, firmId),
        eq(clientComplianceProfilesTable.clientPartyId, clientA),
      ),
    );
  assert.equal(all.length, 1, "the unique key holds exactly one row");

  // Pointer-only audit: one event per assertion, statutory FACTS only —
  // never the free-text notes.
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "compliance_profile"),
        eq(auditEventsTable.entityId, clientA),
      ),
    );
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.action === "filings.profile_updated"));
  assert.ok(
    events.every((e) => !JSON.stringify(e.after).includes("engagement letter")),
    "notes never reach the audit trail",
  );
  const second = events.find(
    (e) => (e.after as { vatRegistered: boolean }).vatRegistered === false,
  );
  assert.deepEqual(second?.before, {
    vatRegistered: true,
    payeEmployer: false,
    fyeMonth: 12,
    incorporationDate: "2020-03-15",
  });
  assert.deepEqual(second?.after, {
    vatRegistered: false,
    payeEmployer: true,
    fyeMonth: null,
    incorporationDate: null,
  });
});

test("the engagement wall: foreign and unknown parties 404 indistinguishably; archived still counts", async () => {
  const notFound = (err: unknown) =>
    err instanceof DomainError && err.code === "NOT_FOUND" && err.status === 404;
  const input = { vatRegistered: true, payeEmployer: true };
  // Another firm's client and a party that does not exist read identically.
  await assert.rejects(
    upsertComplianceProfile(firmId, foreignClient, input, userId, FROZEN_NOW),
    notFound,
  );
  await assert.rejects(
    upsertComplianceProfile(firmId, randomUUID(), input, userId, FROZEN_NOW),
    notFound,
  );
  // An archived-only client is still the firm's client (rbac's
  // firmEngagesParty — the retention-era posture); only the mint's LIVE wall
  // keeps its register from growing.
  const archived = await upsertComplianceProfile(
    firmId,
    archivedClient,
    input,
    userId,
    FROZEN_NOW,
  );
  assert.equal(archived.clientPartyId, archivedClient);
});

test("incorporationDate must be a real, non-future Lagos date (PROFILE_BAD_DATE)", async () => {
  const badDate = (err: unknown) =>
    err instanceof DomainError &&
    err.code === "PROFILE_BAD_DATE" &&
    err.status === 400;
  for (const bad of ["2026-02-30", "15/03/2020", "2026-8-2", "2026-08-07"]) {
    await assert.rejects(
      upsertComplianceProfile(
        firmId,
        clientB,
        { vatRegistered: true, payeEmployer: true, incorporationDate: bad },
        userId,
        FROZEN_NOW,
      ),
      badDate,
      `incorporationDate ${bad} must be rejected`,
    );
  }
  assert.equal(
    await getClientComplianceProfile(firmId, clientB),
    null,
    "a rejected assertion writes nothing",
  );
  // Lagos-today itself is not future.
  const today = await upsertComplianceProfile(
    firmId,
    clientB,
    { vatRegistered: true, payeEmployer: true, incorporationDate: "2026-08-06" },
    userId,
    FROZEN_NOW,
  );
  assert.equal(today.incorporationDate, "2026-08-06");
});

test("summary: DISTINCT live clients vs profiled — archived books count nowhere", async () => {
  // By now clientA and clientB are profiled, and so is archivedClient — but
  // the archived book is not LIVE, so it appears in neither figure.
  assert.deepEqual(await complianceProfileSummary(firmId), {
    clients: 2,
    profiled: 2,
  });
  assert.deepEqual(await complianceProfileSummary(emptyFirmId), {
    clients: 0,
    profiled: 0,
  });
  // The other firm's client is live but unprofiled.
  assert.deepEqual(await complianceProfileSummary(otherFirmId), {
    clients: 1,
    profiled: 0,
  });
});

test("routes: GET/PUT under the filing capabilities with the SEC-03 pin; summary under the console posture", async () => {
  const db = getDb();
  const staffUserId = randomUUID();
  await db
    .insert(usersTable)
    .values({ id: staffUserId, email: `profile-staff-${SALT}@test.local` })
    .onConflictDoNothing();
  const firmBase = await listen(
    appFor(
      firmPrincipal(routeFirmId, { userId: staffUserId }),
      complianceProfileRouter,
    ),
  );
  const clientBase = await listen(
    appFor(clientPrincipal(routeFirmId, routeClient), complianceProfileRouter),
  );

  // No profile yet: the envelope answers null (the load-bearing absence).
  let res = await fetch(`${firmBase}/clients/${routeClient}/compliance-profile`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { profile: null });

  // The firm asserts the facts.
  res = await fetch(`${firmBase}/clients/${routeClient}/compliance-profile`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      vatRegistered: true,
      payeEmployer: false,
      fyeMonth: 3,
      incorporationDate: "2021-01-15",
      notes: "from CAC records",
    }),
  });
  assert.equal(res.status, 200);
  const saved = (await res.json()) as Record<string, unknown>;
  assert.equal(saved.clientPartyId, routeClient);
  assert.equal(saved.vatRegistered, true);
  assert.equal(saved.payeEmployer, false);
  assert.equal(saved.fyeMonth, 3);
  assert.equal(saved.incorporationDate, "2021-01-15");
  assert.equal(saved.notes, "from CAC records");

  // GET round-trips it, contract-shaped (no id/firmId leak).
  res = await fetch(`${firmBase}/clients/${routeClient}/compliance-profile`);
  assert.equal(res.status, 200);
  const envelope = (await res.json()) as { profile: Record<string, unknown> };
  assert.equal(envelope.profile.vatRegistered, true);
  assert.equal(envelope.profile.fyeMonth, 3);
  assert.equal(envelope.profile.id, undefined);
  assert.equal(envelope.profile.firmId, undefined);

  // A client_user reads ITS OWN profile; a sibling id is pinned out (403 —
  // a pure scope comparison, nothing looked up).
  res = await fetch(`${clientBase}/clients/${routeClient}/compliance-profile`);
  assert.equal(res.status, 200);
  res = await fetch(`${clientBase}/clients/${routeSibling}/compliance-profile`);
  assert.equal(res.status, 403);

  // Asserting is firm work: a client_user lacks filing.write.
  res = await fetch(`${clientBase}/clients/${routeClient}/compliance-profile`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ vatRegistered: false, payeEmployer: false }),
  });
  assert.equal(res.status, 403);

  // Contract bounds: fyeMonth 13 dies in the generated zod (400).
  res = await fetch(`${firmBase}/clients/${routeClient}/compliance-profile`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ vatRegistered: true, payeEmployer: true, fyeMonth: 13 }),
  });
  assert.equal(res.status, 400);

  // The module's date guard reaches the wire as a 400 too.
  res = await fetch(`${firmBase}/clients/${routeClient}/compliance-profile`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      vatRegistered: true,
      payeEmployer: true,
      incorporationDate: "2026-02-30",
    }),
  });
  assert.equal(res.status, 400);

  // An unknown party 404s without disclosure.
  res = await fetch(`${firmBase}/clients/${randomUUID()}/compliance-profile`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ vatRegistered: true, payeEmployer: true }),
  });
  assert.equal(res.status, 404);

  // The adoption rollup: routeClient profiled, routeSibling not.
  res = await fetch(`${firmBase}/compliance-profiles/summary`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clients: 2, profiled: 1 });

  // Firm-internal rollup: a client_user lacks console.portfolio.read.
  res = await fetch(`${clientBase}/compliance-profiles/summary`);
  assert.equal(res.status, 403);
});
