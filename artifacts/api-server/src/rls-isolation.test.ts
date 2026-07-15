import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  runInBypassContext,
  firmsTable,
  usersTable,
  membershipsTable,
  partiesTable,
  engagementsTable,
  invoicesTable,
  escalationsTable,
  operatorCasesTable,
  alertPreferencesTable,
  consentRecordsTable,
  passwordResetsTable,
} from "@workspace/db";
import { makeRunSalt } from "./test-helpers/fixtures.ts";

// Behavioral RLS isolation (SEC-02). Every other DB-backed suite runs on the
// raw superuser pool where RLS is inert — until this file, a wrong USING
// clause in any policy would pass the whole battery green. These tests
// exercise the policies the way production does: runRequestContext drops to
// the non-BYPASSRLS meridian_app role and binds the firm GUC, then asserts a
// firm principal can see and write ONLY its own rows. Representative tables
// cover each policy shape (0001 firm-keyed, 0013 firm-keyed / id-keyed /
// engagement-scoped, 0012 bypass-only); the rls-coverage test in lib/db
// asserts every other tenant-keyed table carries a policy at all.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const partyA = randomUUID();
const partyB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const invoiceA = randomUUID();
const invoiceB = randomUUID();

// Run a query as a firm principal would: real transaction, SET LOCAL ROLE
// meridian_app, firm GUC bound — the exact posture app.ts tenantContext gives
// a firm-scoped request.
const asFirm = <T>(firmId: string, fn: () => Promise<T>) =>
  runRequestContext({ bypass: false, firmId }, fn);

// Drizzle wraps the pg error ("Failed query: ...") with the driver error as
// `cause`, so walk the chain for the RLS violation (SQLSTATE 42501).
function isRlsViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: string; message?: string; cause?: unknown };
    if (e.code === "42501") return true;
    if (e.message?.includes("row-level security")) return true;
    cur = e.cause;
  }
  return false;
}

function rejectsWithRls(label: string): (err: unknown) => boolean {
  return (err) => {
    assert.ok(isRlsViolation(err), `${label}: expected an RLS violation, got: ${String(err)}`);
    return true;
  };
}

before(async () => {
  // Fixtures via the bypass context (how trusted internal work writes).
  await runInBypassContext(async () => {
    const db = getDb();
    await db.insert(firmsTable).values([
      { id: firmA, name: `RLS Firm A ${SALT}` },
      { id: firmB, name: `RLS Firm B ${SALT}` },
    ]);
    await db.insert(usersTable).values([
      { id: userA, email: `rls-a-${SALT}@test.local` },
      { id: userB, email: `rls-b-${SALT}@test.local` },
    ]);
    await db.insert(membershipsTable).values([
      { userId: userA, firmId: firmA, role: "firm_admin" },
      { userId: userB, firmId: firmB, role: "firm_admin" },
    ]);
    await db.insert(partiesTable).values([
      { id: partyA, type: "client_business", legalName: `RLS Party A ${SALT}` },
      { id: partyB, type: "client_business", legalName: `RLS Party B ${SALT}` },
    ]);
    await db.insert(engagementsTable).values([
      {
        firmId: firmA,
        clientPartyId: partyA,
        type: "readiness_assessment",
        title: `RLS engagement A ${SALT}`,
      },
      {
        firmId: firmB,
        clientPartyId: partyB,
        type: "readiness_assessment",
        title: `RLS engagement B ${SALT}`,
      },
    ]);
    await db.insert(invoicesTable).values(
      [
        { id: invoiceA, firmId: firmA, party: partyA, n: "A" },
        { id: invoiceB, firmId: firmB, party: partyB, n: "B" },
      ].map((f) => ({
        id: f.id,
        firmId: f.firmId,
        supplierPartyId: f.party,
        buyerPartyId: f.party,
        invoiceNumber: `RLS-${f.n}-${SALT}`,
        issueDate: "2026-07-01",
      })),
    );
    await db.insert(escalationsTable).values(
      [
        { firmId: firmA, party: partyA, invoiceId: invoiceA },
        { firmId: firmB, party: partyB, invoiceId: invoiceB },
      ].map((f) => ({
        invoiceId: f.invoiceId,
        firmId: f.firmId,
        clientPartyId: f.party,
        reason: `rls probe ${SALT}`,
      })),
    );
    await db.insert(operatorCasesTable).values([
      { firmId: firmA, title: `RLS case A ${SALT}` },
      { firmId: firmB, title: `RLS case B ${SALT}` },
    ]);
    await db
      .insert(alertPreferencesTable)
      .values([{ clientPartyId: partyA }, { clientPartyId: partyB }])
      .onConflictDoNothing();
    await db.insert(consentRecordsTable).values(
      [partyA, partyB].map((partyId) => ({
        partyId,
        layer: 1,
        action: "grant" as const,
        scope: "compliance",
        basis: "contract",
        channel: "rls-test",
      })),
    );
    await db.insert(passwordResetsTable).values({
      userId: userA,
      tokenHash: `rls-${SALT}`,
      expiresAt: new Date(Date.now() + 60_000),
      issuedByUserId: userA,
    });
  });
});

test("firm-keyed tables: a firm context sees only its own rows", async () => {
  // [table, firm-A row visible?, firm-B row must NOT be]
  await asFirm(firmA, async () => {
    const db = getDb();

    const invoices = await db
      .select({ id: invoicesTable.id, firmId: invoicesTable.firmId })
      .from(invoicesTable)
      .where(eq(invoicesTable.supplierPartyId, partyA));
    assert.ok(invoices.length > 0, "own invoices visible");

    const foreignInvoices = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceB));
    assert.equal(foreignInvoices.length, 0, "another firm's invoice invisible");

    const escalations = await db.select().from(escalationsTable);
    assert.ok(
      escalations.length > 0 && escalations.every((e) => e.firmId === firmA),
      "escalations: only own-firm rows",
    );

    const cases = await db.select().from(operatorCasesTable);
    assert.ok(
      cases.length > 0 && cases.every((c) => c.firmId === firmA),
      "operator_cases: only own-firm rows",
    );

    const members = await db.select().from(membershipsTable);
    assert.ok(
      members.length > 0 && members.every((m) => m.firmId === firmA),
      "memberships: only own-firm rows (platform-role NULLs invisible)",
    );

    const firms = await db.select({ id: firmsTable.id }).from(firmsTable);
    assert.deepEqual(
      firms.map((f) => f.id),
      [firmA],
      "firms: exactly the principal's own firm",
    );
  });
});

test("engagement-scoped tables: reachable exactly through the firm's engagements", async () => {
  await asFirm(firmA, async () => {
    const db = getDb();
    const prefs = await db.select().from(alertPreferencesTable);
    assert.deepEqual(
      prefs.map((p) => p.clientPartyId),
      [partyA],
      "alert_preferences: only the engaged party's row",
    );
    const consent = await db.select().from(consentRecordsTable);
    assert.ok(
      consent.length > 0 && consent.every((c) => c.partyId === partyA),
      "consent_records: only the engaged party's history",
    );
  });
});

test("WITH CHECK: a firm context cannot write rows for another firm", async () => {
  // Each write runs in its own context: the RLS violation aborts the
  // transaction, so probes cannot share one.
  await assert.rejects(
    asFirm(firmA, () =>
      getDb().insert(invoicesTable).values({
        firmId: firmB,
        supplierPartyId: partyB,
        buyerPartyId: partyB,
        invoiceNumber: `RLS-XFIRM-${SALT}`,
        issueDate: "2026-07-01",
      }),
    ),
    rejectsWithRls("cross-firm invoice insert"),
  );
  await assert.rejects(
    asFirm(firmA, () =>
      getDb()
        .insert(operatorCasesTable)
        .values({ firmId: firmB, title: `RLS xfirm case ${SALT}` }),
    ),
    rejectsWithRls("cross-firm operator_case insert"),
  );
  await assert.rejects(
    asFirm(firmA, () =>
      getDb().insert(consentRecordsTable).values({
        partyId: partyB,
        layer: 1,
        action: "revoke",
        scope: "compliance",
        basis: "contract",
        channel: "rls-test",
      }),
    ),
    rejectsWithRls("consent write for a non-engaged party"),
  );
});

test("bypass-only tables: invisible and unwritable from any firm context", async () => {
  await asFirm(firmA, async () => {
    const rows = await getDb()
      .select({ id: passwordResetsTable.id })
      .from(passwordResetsTable);
    assert.equal(rows.length, 0, "password_resets: nothing visible");
  });
  await assert.rejects(
    asFirm(firmA, () =>
      getDb().insert(passwordResetsTable).values({
        userId: userA,
        tokenHash: `rls-xfirm-${SALT}`,
        expiresAt: new Date(Date.now() + 60_000),
        issuedByUserId: userA,
      }),
    ),
    rejectsWithRls("password_resets insert from a firm context"),
  );
});
