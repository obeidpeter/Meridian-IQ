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
  consentRecordsTable,
  featureFlagsTable,
  messagesTable,
  type ClientStatementFacts,
} from "@workspace/db";
import {
  buildTemplateStatement,
  computeClientStatementFacts,
  deliverClientStatements,
  generateClientStatement,
  lagosMonthStart,
  listClientStatements,
  monthLabel,
  statementIsQuiet,
  sweepClientStatements,
} from "./client-statement.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { setFlag } from "../flags/flags.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Per-client monthly statement (idea #5). The digest covenant, per client and
// per closed Lagos month: every number is SQL over the client's own invoices;
// the model only phrases; template fallback always answers; the sweep is
// idempotent on (firm, client, month). Delivery is claim-first on
// delivered_at, consent-gated (CORE-03) and pointer-only (SEC-12).

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();
// Delivery fixtures: consented, consented-but-quiet, and never-consented.
const deliverClient = randomUUID();
const quietClient = randomUUID();
const noConsentClient = randomUUID();

const MESSAGING_FLAG = "messaging_notifications";
// Flag save/restore: the delivery tests need messaging live, so put the flag
// back exactly as found (delete when it did not pre-exist).
let messagingFlagWasEnabled: boolean | null = null;

// Matches the fan-out's recipient derivation (letters of the uuid): the
// assertion key tying message rows back to a fixture party.
const refFor = (partyId: string) =>
  `ref-${partyId.replace(/[^a-z]/gi, "").slice(0, 16) || "client"}`;

async function statementMessagesFor(partyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refFor(partyId)),
        eq(messagesTable.templateKey, "client_statement_ready"),
      ),
    );
}

// The shared DB accumulates undelivered statement rows from every suite that
// ever ran, and one pass is bounded — drain until the pass claims nothing so
// the assertions see this file's fixtures processed.
async function drainDeliveries() {
  while ((await deliverClientStatements()) > 0) {
    /* keep delivering */
  }
}

const BUSY_FACTS: ClientStatementFacts = {
  issuedCount: 2,
  issuedTotal: "300.00",
  acceptedCount: 1,
  acceptedTotal: "100.00",
  acceptedVat: "7.50",
  failedCount: 0,
  stillUnsubmittedCount: 1,
};

const QUIET_FACTS: ClientStatementFacts = {
  issuedCount: 0,
  issuedTotal: "0",
  acceptedCount: 0,
  acceptedTotal: "0",
  acceptedVat: "0",
  failedCount: 0,
  stillUnsubmittedCount: 0,
};

// Insert a stored statement row directly (generation is covered above; the
// delivery tests only need a row in a known state).
async function seedStatement(
  clientPartyId: string,
  facts: ClientStatementFacts,
  monthStart = MONTH,
) {
  const [row] = await getDb()
    .insert(clerkClientStatementsTable)
    .values({
      firmId: firmA,
      clientPartyId,
      monthStart,
      facts,
      headline: `Seeded statement ${SALT}`,
      bullets: [],
      source: "template",
    })
    .returning();
  return row;
}

async function statementById(id: string) {
  const [row] = await getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(eq(clerkClientStatementsTable.id, id))
    .limit(1);
  return row;
}

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
  const [existingFlag] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG))
    .limit(1);
  messagingFlagWasEnabled = existingFlag ? existingFlag.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: MESSAGING_FLAG, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  await db.insert(firmsTable).values([
    { id: firmA, name: `CS Firm A ${SALT}` },
    { id: firmB, name: `CS Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `CS Client A ${SALT}` },
    { id: clientA2, type: "client_business", legalName: `CS Client A2 ${SALT}` },
    { id: clientB, type: "client_business", legalName: `CS Client B ${SALT}` },
    { id: buyer, type: "buyer", legalName: `CS Buyer ${SALT}` },
    { id: deliverClient, type: "client_business", legalName: `CS Deliver ${SALT}` },
    { id: quietClient, type: "client_business", legalName: `CS Quiet ${SALT}` },
    { id: noConsentClient, type: "client_business", legalName: `CS NoConsent ${SALT}` },
  ]);
  // Alert fan-out is gated on layer-1 consent (CORE-03): grant it for the
  // delivery fixtures EXCEPT the party proving the no-grant path.
  await db.insert(consentRecordsTable).values(
    [deliverClient, quietClient].map((partyId) => ({
      partyId,
      layer: 1,
      action: "grant" as const,
      scope: "compliance",
      basis: "contract",
      channel: "test",
    })),
  );

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
  const db = getDb();
  if (messagingFlagWasEnabled === null) {
    await db
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  } else {
    await setFlag(MESSAGING_FLAG, messagingFlagWasEnabled);
  }
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

test("delivery: a busy statement is offered exactly once across two passes", async () => {
  const row = await seedStatement(deliverClient, BUSY_FACTS);
  await drainDeliveries();

  const claimed = await statementById(row.id);
  assert.ok(claimed.deliveredAt, "the claim marked the row delivered");

  // No prefs row: table defaults — whatsapp + email on, sms off; push is
  // attempted but the party has no registered devices, so no ledger row.
  const msgs = await statementMessagesFor(deliverClient);
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  // Pointer-only payload (SEC-12): opaque refs, no month/amounts/counts.
  assert.equal(msgs[0].entityType, "clerk_client_statement");
  assert.ok(msgs[0].entityId?.startsWith("stmt-"));

  // Second pass: the delivered_at claim blocks a re-send.
  await drainDeliveries();
  assert.equal((await statementMessagesFor(deliverClient)).length, msgs.length);
});

test("delivery: quiet statements claim silently — delivered, nothing sent", async () => {
  const row = await seedStatement(quietClient, QUIET_FACTS);
  await drainDeliveries();

  const claimed = await statementById(row.id);
  assert.ok(claimed.deliveredAt, "the quiet row stops rescanning forever");
  assert.equal((await statementMessagesFor(quietClient)).length, 0);
});

test("the sweep delivers even while the generation flag is off", async () => {
  // The clerk_client_statements flag gates GENERATION only: turning it off
  // must not strand already-generated rows undelivered (they'd otherwise
  // blast out as a stale backlog on re-enable). Force the flag off, seed an
  // undelivered row, and run the real sweep.
  const STATEMENT_FLAG = "clerk_client_statements";
  const [existing] = await getDb()
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, STATEMENT_FLAG))
    .limit(1);
  const statementFlagWasEnabled = existing ? existing.enabled : null;
  await getDb()
    .insert(featureFlagsTable)
    .values({ key: STATEMENT_FLAG, enabled: false, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: false },
    });
  try {
    // A quiet row (fresh month — the unique key already holds this client's
    // MONTH row from the quiet-delivery test): the claim retires it without
    // needing consent fixtures.
    const row = await seedStatement(quietClient, QUIET_FACTS, lagosMonthStart(3));
    // One delivery pass is bounded; other suites' undelivered backlog could
    // outsize it, so sweep until our row is claimed (bounded — each pass
    // claims up to 50 rows, so a stuck loop fails the assertion instead of
    // spinning forever).
    for (let i = 0; i < 20; i++) {
      await sweepClientStatements();
      if ((await statementById(row.id)).deliveredAt) break;
    }
    assert.ok(
      (await statementById(row.id)).deliveredAt,
      "delivery ran despite the dark generation flag",
    );
  } finally {
    if (statementFlagWasEnabled === null) {
      await getDb()
        .delete(featureFlagsTable)
        .where(eq(featureFlagsTable.key, STATEMENT_FLAG));
    } else {
      await setFlag(STATEMENT_FLAG, statementFlagWasEnabled);
    }
  }
});

test("delivery: no layer-1 consent claims the row but sends nothing (CORE-03)", async () => {
  const row = await seedStatement(noConsentClient, BUSY_FACTS);
  await drainDeliveries();

  // The slot is claimed — a later grant must not backfill the alert — but
  // fanOutAlert returned before touching any channel.
  const claimed = await statementById(row.id);
  assert.ok(claimed.deliveredAt);
  assert.equal((await statementMessagesFor(noConsentClient)).length, 0);
});
