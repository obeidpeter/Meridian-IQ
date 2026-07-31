import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import { ListBankStatementLinesResponse } from "@workspace/api-zod";
import { assertCan, type Principal } from "../auth/rbac.ts";
import {
  NARRATION_MATCH_PROMPT_VERSION,
  inNarrationBand,
  narrationKeptRate,
  suggestNarrationMatches,
} from "./narration-match.ts";
import { getClerkMetrics } from "./metrics.ts";
import { assertFirmClerkBudget } from "./budget.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal as makeClientPrincipal,
  firmPrincipal as makeFirmPrincipal,
} from "../../test-helpers/principals.ts";

// Narration match lane. Pinned invariants:
//  - band edges: a line is swept only when its BEST pending proposal sits in
//  [PROPOSAL_THRESHOLD, DEFAULT_BULK_ACCEPT_THRESHOLD) — 0.85 is out, 0.84 in;
//  - positional closed list: the model sees Candidate 1..N (no proposal or
//  invoice id ever enters the prompt) and the app maps the pick back to the
//  confidence-ranked proposals; an out-of-range pick is discarded as invalid;
//  - abstention PERSISTS (a re-run never re-spends on a read line) while a
//  failure persists nothing (a re-run retries it);
//  - orientation: a debit (bill) line's candidate names the SUPPLIER;
//  - tenancy/spend: cross-tenant and sibling-client principals are refused
//  before any model work, client_user lacks reconciliation.act entirely, and
//  an exhausted budget refuses before any provider call.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const brokeFirmId = randomUUID();
const clientPartyId = randomUUID();
const buyerPartyId = randomUUID();
const supplierPartyId = randomUUID();

const CLIENT_NAME = `NM Client ${SALT}`;
const BUYER_NAME = `Alpha Distribution ${SALT}`;
const SUPPLIER_NAME = `Omega Supplies ${SALT}`;

// Band statement: one line at 0.85 (out), one at 0.84 (in).
const stmtBandId = randomUUID();
const lineHighId = randomUUID();
const lineMidId = randomUUID();
const invHighId = randomUUID();
const invMidId = randomUUID();

// Happy statement: one line, two ranked candidates.
const stmtHappyId = randomUUID();
const lineHappyId = randomUUID();
const invAId = randomUUID();
const invBId = randomUUID();
const propAId = randomUUID();
const propBId = randomUUID();

// Abstain statement.
const stmtAbstainId = randomUUID();
const lineAbstainId = randomUUID();
const invAbId = randomUUID();
const propAbId = randomUUID();

// Invalid-output statement (two candidates so candidate_3 is out of range).
const stmtInvalidId = randomUUID();
const lineInvalidId = randomUUID();
const invI1Id = randomUUID();
const invI2Id = randomUUID();
const propI1Id = randomUUID();
const propI2Id = randomUUID();

// Bill statement: one DEBIT line against a captured supplier invoice.
const stmtBillId = randomUUID();
const lineBillId = randomUUID();
const invBillId = randomUUID();
const propBillId = randomUUID();

// Broke-firm statement (budget exhaustion).
const stmtBrokeId = randomUUID();
const lineBrokeId = randomUUID();
const invBrokeId = randomUUID();
const propBrokeId = randomUUID();

const firmPrincipal: Principal = makeFirmPrincipal(firmId);

function receivable(
  id: string,
  firm: string,
  number: string,
  total: string,
  issueDate = "2026-07-01",
) {
  return {
    id,
    firmId: firm,
    supplierPartyId: clientPartyId,
    buyerPartyId,
    invoiceNumber: number,
    status: "stamped" as const,
    issueDate,
    grandTotal: total,
  };
}

function creditLine(
  id: string,
  statementId: string,
  lineNo: number,
  narration: string,
  amount: string,
) {
  return {
    id,
    statementId,
    lineNo,
    valueDate: "2026-07-10",
    amount,
    direction: "credit" as const,
    narration,
    parseStatus: "parsed" as const,
    rawLine: `10/07/2026,${amount},CR,${narration}`,
  };
}

function proposal(
  id: string,
  firm: string,
  statementLineId: string,
  invoiceId: string,
  confidence: string,
) {
  return {
    id,
    firmId: firm,
    statementLineId,
    invoiceId,
    confidence,
    features: { amountScore: 1, referenceScore: 0, dateScore: 0.5, nameScore: 0.5 },
    status: "proposed" as const,
  };
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `NM Firm ${SALT}` },
    { id: otherFirmId, name: `NM Other Firm ${SALT}` },
    { id: brokeFirmId, name: `NM Broke Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientPartyId, type: "client_business", legalName: CLIENT_NAME },
    { id: buyerPartyId, type: "buyer", legalName: BUYER_NAME },
    { id: supplierPartyId, type: "buyer", legalName: SUPPLIER_NAME },
  ]);
  await db.insert(invoicesTable).values([
    receivable(invHighId, firmId, `NM-H-${SALT}`, "100000.00"),
    receivable(invMidId, firmId, `NM-M-${SALT}`, "120000.00"),
    receivable(invAId, firmId, `NM-A-${SALT}`, "150000.00"),
    receivable(invBId, firmId, `NM-B-${SALT}`, "151000.00", "2026-06-20"),
    receivable(invAbId, firmId, `NM-AB-${SALT}`, "90000.00"),
    receivable(invI1Id, firmId, `NM-I1-${SALT}`, "80000.00"),
    receivable(invI2Id, firmId, `NM-I2-${SALT}`, "81000.00"),
    // The bill: this client is the BUYER of a captured supplier invoice.
    {
      id: invBillId,
      firmId,
      supplierPartyId: supplierPartyId,
      buyerPartyId: clientPartyId,
      invoiceNumber: `NM-BILL-${SALT}`,
      status: "draft" as const,
      issueDate: "2026-07-01",
      grandTotal: "70000.00",
    },
    {
      ...receivable(invBrokeId, brokeFirmId, `NM-BROKE-${SALT}`, "50000.00"),
    },
  ]);
  await db.insert(bankStatementsTable).values(
    [stmtBandId, stmtHappyId, stmtAbstainId, stmtInvalidId, stmtBillId].map(
      (id) => ({
        id,
        firmId,
        clientPartyId,
        formatKey: "generic",
        status: "reconciled" as const,
        lineCount: 2,
        parsedCount: 2,
      }),
    ),
  );
  await db.insert(bankStatementsTable).values({
    id: stmtBrokeId,
    firmId: brokeFirmId,
    clientPartyId,
    formatKey: "generic",
    status: "reconciled",
    lineCount: 1,
    parsedCount: 1,
  });
  await db.insert(bankStatementLinesTable).values([
    creditLine(lineHighId, stmtBandId, 1, `TRF HIGH BAND ${SALT}`, "100000.00"),
    creditLine(lineMidId, stmtBandId, 2, `TRF MID BAND ${SALT}`, "120000.00"),
    creditLine(
      lineHappyId,
      stmtHappyId,
      1,
      `TRF FROM ALPHA DIST FOR GOODS ${SALT}`,
      "150000.00",
    ),
    creditLine(lineAbstainId, stmtAbstainId, 1, `TRF UNCLEAR ${SALT}`, "90000.00"),
    creditLine(lineInvalidId, stmtInvalidId, 1, `TRF MAYBE ${SALT}`, "80000.00"),
    {
      ...creditLine(lineBillId, stmtBillId, 1, `TRF TO OMEGA SUPPLIES ${SALT}`, "70000.00"),
      direction: "debit" as const,
    },
    creditLine(lineBrokeId, stmtBrokeId, 1, `TRF BROKE ${SALT}`, "50000.00"),
  ]);
  await db.insert(matchProposalsTable).values([
    proposal(randomUUID(), firmId, lineHighId, invHighId, "0.8500"),
    proposal(randomUUID(), firmId, lineMidId, invMidId, "0.8400"),
    proposal(propAId, firmId, lineHappyId, invAId, "0.6000"),
    proposal(propBId, firmId, lineHappyId, invBId, "0.4600"),
    proposal(propAbId, firmId, lineAbstainId, invAbId, "0.5000"),
    proposal(propI1Id, firmId, lineInvalidId, invI1Id, "0.6000"),
    proposal(propI2Id, firmId, lineInvalidId, invI2Id, "0.4000"),
    proposal(propBillId, firmId, lineBillId, invBillId, "0.5000"),
    proposal(propBrokeId, brokeFirmId, lineBrokeId, invBrokeId, "0.5000"),
  ]);
  // Spend the broke firm's entire default allowance (2,000,000 tokens) so its
  // sweep must refuse before any provider call. Append-only ledger — the
  // random firm id keeps runs independent.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: brokeFirmId,
    purpose: "match_narration",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `narration-budget-${SALT}`,
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 1_500_000,
    completionTokens: 500_000,
  });
});

after(async () => {
  await restoreClerkFlag();
});

async function loadSuggestion(lineId: string) {
  const [line] = await getDb()
    .select({ narrationSuggestion: bankStatementLinesTable.narrationSuggestion })
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.id, lineId))
    .limit(1);
  return line.narrationSuggestion;
}

test("inNarrationBand: [PROPOSAL_THRESHOLD, DEFAULT_BULK_ACCEPT_THRESHOLD)", () => {
  assert.equal(inNarrationBand(0.35), true, "the floor is inclusive");
  assert.equal(inNarrationBand(0.8499), true);
  assert.equal(inNarrationBand(0.85), false, "bulk-accept owns 0.85 and up");
  assert.equal(inNarrationBand(0.3499), false, "below the proposal floor");
});

test("band edges: 0.85 is not swept, 0.84 is", async () => {
  const calls: CompletionRequest[] = [];
  const result = await suggestNarrationMatches(
    stmtBandId,
    firmPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ pick: "none", cue: null });
    }),
  );
  assert.equal(result.considered, 1, "only the 0.84 line is middle-band");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].statementLineId, lineMidId);
  assert.equal(calls.length, 1, "one model call for one line");
  assert.equal(
    await loadSuggestion(lineHighId),
    null,
    "the bulk-accept-clearing line was never read",
  );
});

test("happy pick: positional candidate maps back to the top proposal", async () => {
  const calls: CompletionRequest[] = [];
  const result = await suggestNarrationMatches(
    stmtHappyId,
    firmPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ pick: "candidate_1", cue: "name_abbreviation" });
    }),
  );
  assert.equal(result.statementId, stmtHappyId);
  assert.equal(result.considered, 1);
  assert.equal(result.suggested, 1);
  assert.equal(result.abstained, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.lines[0], {
    statementLineId: lineHappyId,
    outcome: "suggested",
    proposalId: propAId,
    cue: "name_abbreviation",
  });

  const suggestion = await loadSuggestion(lineHappyId);
  assert.ok(suggestion);
  assert.equal(suggestion.proposalId, propAId, "candidate_1 = top confidence");
  assert.equal(suggestion.invoiceId, invAId);
  assert.equal(suggestion.cue, "name_abbreviation");
  assert.equal(suggestion.promptVersion, NARRATION_MATCH_PROMPT_VERSION);
  assert.equal(suggestion.model, "fake-model-test");
  assert.ok(Number.isFinite(Date.parse(suggestion.at)), "at is a timestamp");

  // The narration travels fenced, the candidate list is positional, and no
  // proposal or invoice id ever reaches the model.
  assert.equal(calls.length, 1);
  const user = calls[0].user as string;
  assert.ok(user.includes("-----BEGIN NARRATION-----"));
  assert.ok(user.includes("-----BEGIN CANDIDATES-----"));
  assert.ok(user.includes(`TRF FROM ALPHA DIST FOR GOODS ${SALT}`));
  assert.ok(user.includes(`Candidate 1: invoice NM-A-${SALT}`));
  assert.ok(user.includes(`Candidate 2: invoice NM-B-${SALT}`));
  assert.ok(user.includes(BUYER_NAME), "receivable candidates name the buyer");
  for (const id of [propAId, propBId, invAId, invBId, lineHappyId]) {
    assert.equal(user.includes(id), false, `no id leaks into the prompt (${id})`);
  }
});

test("the lines endpoint projection carries {proposalId, invoiceId, cue, at} and strips provenance", async () => {
  // GET /statements/:id/lines selects whole rows and parses them with the
  // generated schema; the suggestion's wire shape keeps the pick fields and
  // strips promptVersion/model (intended by the contract).
  const rows = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, stmtHappyId));
  const wire = ListBankStatementLinesResponse.parse(rows);
  const line = wire.find((l) => l.id === lineHappyId);
  assert.ok(line, "the happy line is on the wire");
  assert.ok(line.narrationSuggestion, "the suggestion survives the parse");
  assert.deepEqual(line.narrationSuggestion, {
    proposalId: propAId,
    invoiceId: invAId,
    cue: "name_abbreviation",
    at: (await loadSuggestion(lineHappyId))!.at,
  });
});

test("abstention persists and a re-run skips the line (no second spend)", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return JSON.stringify({ pick: "none", cue: null });
  });
  const first = await suggestNarrationMatches(stmtAbstainId, firmPrincipal, gateway);
  assert.equal(first.considered, 1);
  assert.equal(first.abstained, 1);
  assert.deepEqual(first.lines[0], {
    statementLineId: lineAbstainId,
    outcome: "abstained",
  });
  const suggestion = await loadSuggestion(lineAbstainId);
  assert.ok(suggestion, "the abstention is persisted");
  assert.equal(suggestion.proposalId, null);
  assert.equal(suggestion.invoiceId, null);
  assert.equal(suggestion.cue, null);
  assert.equal(suggestion.promptVersion, NARRATION_MATCH_PROMPT_VERSION);
  assert.equal(providerCalls, 1);

  const second = await suggestNarrationMatches(stmtAbstainId, firmPrincipal, gateway);
  assert.equal(second.considered, 0, "the read line is not re-swept");
  assert.deepEqual(second.lines, []);
  assert.equal(providerCalls, 1, "no second model call for the same line");
});

test("invalid output fails the line, persists nothing, and a re-run retries", async () => {
  // Garbage JSON → invalid_discarded → failed, nothing persisted.
  const garbage = await suggestNarrationMatches(
    stmtInvalidId,
    firmPrincipal,
    fakeGateway(() => "not json"),
  );
  assert.equal(garbage.failed, 1);
  assert.equal(garbage.suggested + garbage.abstained, 0);
  assert.deepEqual(garbage.lines[0], {
    statementLineId: lineInvalidId,
    outcome: "failed",
  });
  assert.equal(await loadSuggestion(lineInvalidId), null);

  // candidate_3 with only two candidates offered → schema-invalid (the pick
  // enum is closed over the offered candidates) → failed, nothing persisted.
  const outOfRange = await suggestNarrationMatches(
    stmtInvalidId,
    firmPrincipal,
    fakeGateway(() =>
      JSON.stringify({ pick: "candidate_3", cue: "exact_reference" }),
    ),
  );
  assert.equal(outOfRange.considered, 1, "the failed line is retryable");
  assert.equal(outOfRange.failed, 1);
  assert.equal(await loadSuggestion(lineInvalidId), null);

  // A later valid pass reads the same line: candidate_2 maps to the SECOND
  // proposal by confidence rank.
  const valid = await suggestNarrationMatches(
    stmtInvalidId,
    firmPrincipal,
    fakeGateway(() =>
      JSON.stringify({ pick: "candidate_2", cue: "reference_fragment" }),
    ),
  );
  assert.equal(valid.suggested, 1);
  const suggestion = await loadSuggestion(lineInvalidId);
  assert.equal(suggestion?.proposalId, propI2Id);
  assert.equal(suggestion?.invoiceId, invI2Id);
  assert.equal(suggestion?.cue, "reference_fragment");
});

test("orientation: a debit (bill) line's candidate names the SUPPLIER", async () => {
  const calls: CompletionRequest[] = [];
  const result = await suggestNarrationMatches(
    stmtBillId,
    firmPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ pick: "candidate_1", cue: "payer_context" });
    }),
  );
  assert.equal(result.suggested, 1);
  const user = calls[0].user as string;
  assert.ok(user.startsWith("Bank debit line:"));
  assert.ok(
    user.includes(SUPPLIER_NAME),
    "the bill candidate names the supplier — who the client paid",
  );
  assert.equal(
    user.includes(CLIENT_NAME),
    false,
    "the client's own name (the bill's buyer) is not the counterparty",
  );
  const suggestion = await loadSuggestion(lineBillId);
  assert.equal(suggestion?.proposalId, propBillId);
  assert.equal(suggestion?.invoiceId, invBillId);
});

test("tenancy: cross-tenant, sibling client and missing statement are refused before any model work", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return JSON.stringify({ pick: "none", cue: null });
  });
  const foreign: Principal = { ...firmPrincipal, firmId: otherFirmId };
  await assert.rejects(
    suggestNarrationMatches(stmtHappyId, foreign, gateway),
    (err: Error & { code?: string }) => err.code === "CROSS_TENANT",
  );
  // SEC-03: a sibling client of the SAME firm is refused too.
  const siblingClient = makeClientPrincipal(firmId, randomUUID());
  await assert.rejects(
    suggestNarrationMatches(stmtHappyId, siblingClient, gateway),
    (err: Error & { code?: string }) => err.code === "CROSS_CLIENT",
  );
  await assert.rejects(
    suggestNarrationMatches(randomUUID(), firmPrincipal, gateway),
    (err: Error & { code?: string }) => err.code === "NOT_FOUND",
  );
  assert.equal(providerCalls, 0, "no model call preceded any refusal");
});

test("a client principal lacks reconciliation.act — the route's spend gate", () => {
  // The route gates on the DECIDER's capability before anything else:
  // client_user holds only reconciliation.read and must never trigger spend.
  const client = makeClientPrincipal(firmId, clientPartyId);
  assert.throws(
    () => assertCan(client, "reconciliation.act"),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "FORBIDDEN" && err.status === 403,
  );
});

test("budget: an exhausted firm refuses before any provider call", async () => {
  // The route's pre-check (assertFirmClerkBudget runs before getClerkGateway
  // and the module): a clean 429, no model call.
  await assert.rejects(
    assertFirmClerkBudget(brokeFirmId),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_BUDGET_EXHAUSTED" && err.status === 429,
  );
  // Defense in depth: even reaching the module, the gateway's own backstop
  // refuses each call before the provider — outcome failed, zero provider
  // calls, nothing persisted, the line stays retryable.
  let providerCalls = 0;
  const result = await suggestNarrationMatches(
    stmtBrokeId,
    makeFirmPrincipal(brokeFirmId),
    fakeGateway(() => {
      providerCalls += 1;
      return JSON.stringify({ pick: "none", cue: null });
    }),
  );
  assert.equal(providerCalls, 0, "the provider is never touched");
  assert.equal(result.failed, 1);
  assert.equal(await loadSuggestion(lineBrokeId), null);
});

test("narrationKeptRate labels kept / overridden / abstained from decisions", async () => {
  const db = getDb();
  const before = await narrationKeptRate(30);

  // Three decided fixtures on their own statement: a kept pick, an
  // overridden pick (a different proposal was accepted) and an abstention.
  const stmtKeptId = randomUUID();
  const lineK1 = randomUUID();
  const lineK2 = randomUUID();
  const lineK3 = randomUUID();
  const invK1 = randomUUID();
  const invK2a = randomUUID();
  const invK2b = randomUUID();
  const propK1 = randomUUID();
  const propK2a = randomUUID();
  const propK2b = randomUUID();
  await db.insert(invoicesTable).values([
    receivable(invK1, firmId, `NM-K1-${SALT}`, "10000.00"),
    receivable(invK2a, firmId, `NM-K2A-${SALT}`, "20000.00"),
    receivable(invK2b, firmId, `NM-K2B-${SALT}`, "20100.00"),
  ]);
  await db.insert(bankStatementsTable).values({
    id: stmtKeptId,
    firmId,
    clientPartyId,
    formatKey: "generic",
    status: "reconciled",
    lineCount: 3,
    parsedCount: 3,
  });
  const suggestionBase = {
    promptVersion: NARRATION_MATCH_PROMPT_VERSION,
    model: "fake-model-test",
    at: new Date().toISOString(),
  };
  await db.insert(bankStatementLinesTable).values([
    {
      ...creditLine(lineK1, stmtKeptId, 1, `TRF K1 ${SALT}`, "10000.00"),
      narrationSuggestion: {
        proposalId: propK1,
        invoiceId: invK1,
        cue: "exact_reference",
        ...suggestionBase,
      },
    },
    {
      ...creditLine(lineK2, stmtKeptId, 2, `TRF K2 ${SALT}`, "20000.00"),
      narrationSuggestion: {
        proposalId: propK2a,
        invoiceId: invK2a,
        cue: "name_abbreviation",
        ...suggestionBase,
      },
    },
    {
      ...creditLine(lineK3, stmtKeptId, 3, `TRF K3 ${SALT}`, "30000.00"),
      narrationSuggestion: {
        proposalId: null,
        invoiceId: null,
        cue: null,
        ...suggestionBase,
      },
    },
  ]);
  await db.insert(matchProposalsTable).values([
    // Kept: the human accepted the suggested proposal.
    { ...proposal(propK1, firmId, lineK1, invK1, "0.6000"), status: "accepted" as const },
    // Overridden: the suggestion named K2a but the human accepted K2b.
    { ...proposal(propK2a, firmId, lineK2, invK2a, "0.6000"), status: "superseded" as const },
    { ...proposal(propK2b, firmId, lineK2, invK2b, "0.5000"), status: "accepted" as const },
  ]);

  const after = await narrationKeptRate(30);
  assert.equal(after.windowDays, 30);
  // Deltas, not absolutes: earlier tests in this file (and reruns on a reused
  // DB) also leave suggestions behind.
  assert.equal(after.kept - before.kept, 1);
  assert.equal(after.overridden - before.overridden, 1);
  assert.equal(after.abstained - before.abstained, 1);
  assert.equal(after.suggested - before.suggested, 2, "two picks were seeded");

  // The clerk health report surfaces the same numbers from the same SQL.
  const metrics = await getClerkMetrics(30);
  assert.deepEqual(metrics.narrationMatch, {
    suggested: after.suggested,
    kept: after.kept,
    overridden: after.overridden,
    abstained: after.abstained,
  });
});
