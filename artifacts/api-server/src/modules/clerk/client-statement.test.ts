import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
  clerkClientStatementsTable,
  clerkInferenceCallsTable,
  type ClientStatementFacts,
} from "@workspace/db";
import {
  buildTemplateStatement,
  computeClientStatementFacts,
  generateClientStatement,
  lagosMonthStart,
  listClientStatements,
  monthLabel,
  statementIsQuiet,
} from "./client-statement.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Per-client monthly statement (idea #5). The digest covenant, per client and
// per closed Lagos month: every number is SQL over the client's own invoices;
// the model only phrases; template fallback always answers; the sweep is
// idempotent on (firm, client, month).

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

// The closed month the sweep generates: the newest fully-elapsed Lagos month.
const MONTH = lagosMonthStart(1);

const ISSUED_1 = `CS-ISS1-${SALT}`;
const ISSUED_2 = `CS-ISS2-${SALT}`;
const ACCEPTED = `CS-ACC-${SALT}`;
const FAILED = `CS-FAIL-${SALT}`;
const OTHER_CLIENT = `CS-OTHER-${SALT}`;
const FOREIGN = `CS-FOREIGN-${SALT}`;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `CS Firm A ${SALT}` },
    { id: firmB, name: `CS Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `CS Client A ${SALT}` },
    { id: clientA2, type: "client_business", legalName: `CS Client A2 ${SALT}` },
    { id: clientB, type: "client_business", legalName: `CS Client B ${SALT}` },
    { id: buyer, type: "buyer", legalName: `CS Buyer ${SALT}` },
  ]);

  // Mid-month noon UTC (13:00 Lagos) — unambiguously inside MONTH.
  const inMonth = new Date(`${MONTH.slice(0, 7)}-15T12:00:00Z`);
  const acceptedId = randomUUID();
  const failedId = randomUUID();

  type Seed = typeof invoicesTable.$inferInsert;
  const inv = (over: Partial<Seed> & Pick<Seed, "invoiceNumber" | "issueDate">): Seed => ({
    firmId: firmA,
    supplierPartyId: clientA,
    buyerPartyId: buyer,
    ...over,
  });

  await db.insert(invoicesTable).values([
    // Two invoices issued in the month (one draft, one stamped) — both count
    // toward issuedCount/issuedTotal.
    inv({ invoiceNumber: ISSUED_1, issueDate: `${MONTH.slice(0, 7)}-03`, status: "draft", grandTotal: "100.00" }),
    inv({ invoiceNumber: ISSUED_2, issueDate: `${MONTH.slice(0, 7)}-20`, status: "stamped", grandTotal: "200.00" }),
    // Accepted by the rails during the month (attempt row below).
    inv({ id: acceptedId, invoiceNumber: ACCEPTED, issueDate: `${MONTH.slice(0, 7)}-05`, status: "submitted", grandTotal: "500.00", vatTotal: "34.88" }),
    // Rejected during the month (attempt row below); issued earlier, so it is
    // NOT in issuedCount but IS in failedCount.
    inv({ id: failedId, invoiceNumber: FAILED, issueDate: lagosMonthStart(2), status: "failed", grandTotal: "9.00" }),
    // Another client of the same firm — must never leak into client A's row.
    inv({ invoiceNumber: OTHER_CLIENT, supplierPartyId: clientA2, issueDate: `${MONTH.slice(0, 7)}-08`, status: "draft", grandTotal: "77.00" }),
    // Another firm entirely.
    { firmId: firmB, supplierPartyId: clientB, buyerPartyId: buyer, invoiceNumber: FOREIGN, issueDate: `${MONTH.slice(0, 7)}-08`, status: "draft", grandTotal: "88.00" },
  ]);

  await db.insert(submissionAttemptsTable).values([
    {
      invoiceId: acceptedId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `cs-acc-${SALT}`,
      status: "accepted",
      createdAt: inMonth,
    },
    {
      invoiceId: failedId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `cs-fail-${SALT}`,
      status: "rejected",
      errorCode: "MBS_INVALID_TIN",
      createdAt: inMonth,
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("lagosMonthStart returns closed-month firsts with year carry", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  assert.equal(lagosMonthStart(1, now), "2025-12-01");
  assert.equal(lagosMonthStart(2, now), "2025-11-01");
  assert.equal(monthLabel("2025-12-01"), "December 2025");
});

test("facts are SQL over the client's own month — no sibling, no other firm", async () => {
  const facts = await computeClientStatementFacts(firmA, clientA, MONTH);
  assert.equal(facts.issuedCount, 3, "two issued + the accepted one");
  assert.equal(facts.issuedTotal, "800.00");
  assert.equal(facts.acceptedCount, 1);
  assert.equal(facts.acceptedTotal, "500.00");
  assert.equal(facts.acceptedVat, "34.88");
  assert.equal(facts.failedCount, 1, "one rejected attempt in the month");
  // ISSUED_1 (draft) is still unsubmitted; ISSUED_2 stamped, ACCEPTED submitted.
  assert.equal(facts.stillUnsubmittedCount, 1);

  // The other client's and the other firm's invoices are invisible here.
  const other = await computeClientStatementFacts(firmA, clientA2, MONTH);
  assert.equal(other.issuedCount, 1);
  assert.equal(other.issuedTotal, "77.00");
});

test("template phrasing is deterministic and quiet months read as quiet", () => {
  const quiet: ClientStatementFacts = {
    issuedCount: 0,
    issuedTotal: "0",
    acceptedCount: 0,
    acceptedTotal: "0",
    acceptedVat: "0",
    failedCount: 0,
    stillUnsubmittedCount: 0,
  };
  assert.ok(statementIsQuiet(quiet));
  const t = buildTemplateStatement(quiet, "2026-05-01");
  assert.match(t.headline, /No invoicing activity in May 2026/);

  const busy: ClientStatementFacts = {
    issuedCount: 3,
    issuedTotal: "800.00",
    acceptedCount: 1,
    acceptedTotal: "500.00",
    acceptedVat: "34.88",
    failedCount: 1,
    stillUnsubmittedCount: 1,
  };
  assert.ok(!statementIsQuiet(busy));
  const b = buildTemplateStatement(busy, "2026-05-01");
  assert.ok(b.bullets.some((x) => x.includes("NGN 800.00")));
  assert.ok(b.bullets.some((x) => x.includes("NGN 34.88 VAT")));
  assert.ok(b.headline.includes("2 still need attention"));
});

test("generate stores the template when the model is unavailable, and is idempotent", async () => {
  const first = await generateClientStatement(firmA, clientA, MONTH, null);
  assert.equal(first.source, "template");
  assert.equal(first.facts.issuedCount, 3);
  assert.ok(first.headline.length > 0);

  // A second call for the same (firm, client, month) returns the SAME row.
  const second = await generateClientStatement(firmA, clientA, MONTH, null);
  assert.equal(second.id, first.id);

  const rows = await getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(
      and(
        eq(clerkClientStatementsTable.firmId, firmA),
        eq(clerkClientStatementsTable.clientPartyId, clientA),
        eq(clerkClientStatementsTable.monthStart, MONTH),
      ),
    );
  assert.equal(rows.length, 1, "exactly one statement per client-month");
});

test("a quiet client-month never calls the model (dormant clients cost nothing)", async () => {
  // clientB belongs to firmB, which has one draft this month — but generate
  // for a firm/client with NO activity: reuse clientA2 under a fresh month
  // with no invoices.
  const emptyMonth = lagosMonthStart(6);
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({ headline: "should not be used", bullets: [] });
  });
  const row = await generateClientStatement(firmA, clientA2, emptyMonth, gateway);
  assert.equal(row.source, "template");
  assert.equal(calls.length, 0, "no provider call for a quiet month");
});

test("the model phrases an active month; the call is ledgered to the firm", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      headline: "Great month, three invoices cleared.",
      bullets: ["You issued 3 invoices.", "1 needs a fix."],
    });
  });
  // clientA's MONTH already has a stored template row from an earlier test;
  // use clientA2 with real activity in MONTH (the OTHER_CLIENT draft).
  const row = await generateClientStatement(firmA, clientA2, MONTH, gateway);
  assert.equal(row.source, "clerk");
  assert.equal(row.headline, "Great month, three invoices cleared.");
  assert.equal(calls.length, 1);
  // Facts are still SQL — the model only phrased them.
  assert.equal(row.facts.issuedCount, 1);
  assert.equal(row.facts.issuedTotal, "77.00");

  const ledger = await getDb()
    .select({ purpose: clerkInferenceCallsTable.purpose })
    .from(clerkInferenceCallsTable)
    .where(
      and(
        eq(clerkInferenceCallsTable.firmId, firmA),
        eq(clerkInferenceCallsTable.purpose, "client_statement"),
      ),
    );
  assert.ok(
    ledger.length >= 1,
    "the phrasing call is ledgered against the firm for budget accounting",
  );

  // The read path returns newest-first for the client.
  const list = await listClientStatements(firmA, clientA2);
  assert.ok(list.some((s) => s.clientPartyId === clientA2 && s.monthStart === MONTH));
});
