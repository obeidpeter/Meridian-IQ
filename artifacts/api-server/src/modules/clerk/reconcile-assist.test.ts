import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
} from "@workspace/db";
import type { Principal } from "../auth/rbac.ts";
import {
  assistMatch,
  buildTemplateAssist,
  proposalHighlights,
} from "./reconcile-assist.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Reconciliation match assist (idea #2). Pinned invariants:
//  - the ranking and every highlight are computed from the matcher's RECORDED
//  features — identical whether or not the model phrases the narrative;
//  - the template path always answers (no gateway, kill switch, garbage
//  output — never an AI-availability error);
//  - tenancy: a principal from another firm is refused before any read of
//  the candidates.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const clientPartyId = randomUUID();
const buyerPartyId = randomUUID();
const statementId = randomUUID();
const lineId = randomUUID();
const bareLineId = randomUUID();
const invoiceAId = randomUUID();
const invoiceBId = randomUUID();
const proposalAId = randomUUID();
const proposalBId = randomUUID();

const INV_A = `RA-A-${SALT}`;
const INV_B = `RA-B-${SALT}`;

const firmPrincipal: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Assist Firm ${SALT}` },
    { id: otherFirmId, name: `Assist Other Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientPartyId,
      type: "client_business",
      legalName: `Assist Client ${SALT}`,
    },
    { id: buyerPartyId, type: "buyer", legalName: `Assist Buyer ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    {
      id: invoiceAId,
      firmId,
      supplierPartyId: clientPartyId,
      buyerPartyId,
      invoiceNumber: INV_A,
      status: "stamped",
      issueDate: "2026-07-01",
      grandTotal: "150000.00",
    },
    {
      id: invoiceBId,
      firmId,
      supplierPartyId: clientPartyId,
      buyerPartyId,
      invoiceNumber: INV_B,
      status: "stamped",
      issueDate: "2026-06-20",
      grandTotal: "151000.00",
    },
  ]);
  await db.insert(bankStatementsTable).values({
    id: statementId,
    firmId,
    clientPartyId,
    formatKey: "generic",
    status: "reconciled",
    lineCount: 2,
    parsedCount: 2,
  });
  await db.insert(bankStatementLinesTable).values([
    {
      id: lineId,
      statementId,
      lineNo: 1,
      valueDate: "2026-07-04",
      amount: "150000.00",
      direction: "credit",
      narration: `TRF ${INV_A} FROM ASSIST BUYER`,
      parseStatus: "parsed",
      rawLine: `04/07/2026,150000.00,CR,TRF ${INV_A} FROM ASSIST BUYER`,
    },
    {
      id: bareLineId,
      statementId,
      lineNo: 2,
      valueDate: "2026-07-05",
      amount: "999.00",
      direction: "credit",
      narration: "TRF UNMATCHED",
      parseStatus: "parsed",
      rawLine: "05/07/2026,999.00,CR,TRF UNMATCHED",
    },
  ]);
  await db.insert(matchProposalsTable).values([
    {
      id: proposalAId,
      firmId,
      statementLineId: lineId,
      invoiceId: invoiceAId,
      confidence: "0.7800",
      features: {
        amountScore: 1,
        referenceScore: 1,
        dateScore: 0.95,
        nameScore: 1,
      },
      status: "proposed",
    },
    {
      id: proposalBId,
      firmId,
      statementLineId: lineId,
      invoiceId: invoiceBId,
      confidence: "0.4600",
      features: {
        amountScore: 0.7,
        referenceScore: 0,
        dateScore: 0.77,
        nameScore: 1,
      },
      status: "proposed",
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("proposalHighlights reads the recorded features into plain language", () => {
  const strong = proposalHighlights({
    features: { amountScore: 1, referenceScore: 1, dateScore: 0.95, nameScore: 1 },
    valueDate: "2026-07-04",
    issueDate: "2026-07-01",
  });
  assert.ok(strong.includes("the paid amount matches the invoice total exactly"));
  assert.ok(strong.includes("the invoice number appears in the bank narration"));
  assert.ok(strong.includes("payment landed 3 days after the invoice was issued"));
  assert.ok(strong.includes("the customer's name appears in the narration"));

  const near = proposalHighlights({
    features: { amountScore: 0.7, referenceScore: 0, nameScore: 0.5 },
    valueDate: null,
    issueDate: "2026-07-01",
  });
  assert.ok(near.some((h) => h.includes("within 2% of the invoice total")));
  assert.ok(near.some((h) => h.includes("most of the customer's name")));
  assert.equal(near.some((h) => h.includes("invoice number")), false);

  // The matcher recorded ZERO date support (implausibly early / outside the
  // window): no date highlight may appear, even though raw dates exist —
  // this module never claims evidence the matcher withheld.
  const withheld = proposalHighlights({
    features: { amountScore: 1, referenceScore: 1, dateScore: 0, nameScore: 0 },
    valueDate: "2026-06-01",
    issueDate: "2026-07-01",
  });
  assert.equal(
    withheld.some((h) => h.includes("payment landed")),
    false,
    "dateScore 0 = no date evidence",
  );
});

test("buildTemplateAssist names both candidates with their confidences", () => {
  const text = buildTemplateAssist([
    {
      proposalId: "p1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      confidence: "0.78",
      highlights: ["the paid amount matches the invoice total exactly"],
    },
    {
      proposalId: "p2",
      invoiceId: "i2",
      invoiceNumber: "INV-2",
      confidence: "0.46",
      highlights: [],
    },
  ]);
  assert.ok(text.includes("INV-1 is the strongest candidate at 78%"));
  assert.ok(text.includes("INV-2 scores 46%"));
  assert.ok(text.includes("The decision stays with you."));
});

test("no gateway: the template path answers with deterministic ranking", async () => {
  const result = await assistMatch(lineId, firmPrincipal, null);
  assert.equal(result.source, "template");
  assert.equal(result.ranked.length, 2);
  assert.equal(result.ranked[0].invoiceNumber, INV_A, "confidence-desc order");
  assert.equal(result.ranked[1].invoiceNumber, INV_B);
  assert.ok(result.explanation.includes(INV_A));
  assert.ok(
    result.ranked[0].highlights.includes(
      "the invoice number appears in the bank narration",
    ),
  );
});

test("garbage model output falls back to the template — never an error", async () => {
  const result = await assistMatch(
    lineId,
    firmPrincipal,
    fakeGateway(() => "not json"),
  );
  assert.equal(result.source, "template");
  assert.ok(result.explanation.includes(INV_A));
});

test("a valid phrasing is used, but the ranking stays platform-computed", async () => {
  const calls: CompletionRequest[] = [];
  const result = await assistMatch(
    lineId,
    firmPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ explanation: "Model phrased comparison." });
    }),
  );
  assert.equal(result.source, "clerk");
  assert.equal(result.explanation, "Model phrased comparison.");
  assert.equal(result.ranked[0].invoiceNumber, INV_A);
  // The narration is untrusted bank text, and invoice numbers / buyer names
  // are client-authored — both travel only inside fences.
  assert.equal(calls.length, 1);
  assert.ok((calls[0].user as string).includes("-----BEGIN NARRATION-----"));
  assert.ok((calls[0].user as string).includes("-----BEGIN CANDIDATES-----"));
});

test("a line with no pending proposals is a 404, not an empty explanation", async () => {
  await assert.rejects(
    assistMatch(bareLineId, firmPrincipal, null),
    (err: Error & { code?: string }) => err.code === "NO_PROPOSALS",
  );
});

test("a principal from another firm is refused before any explanation", async () => {
  const foreign: Principal = { ...firmPrincipal, firmId: otherFirmId };
  await assert.rejects(
    assistMatch(lineId, foreign, null),
    (err: Error & { code?: string }) => err.code === "CROSS_TENANT",
  );
  // SEC-03: a sibling client of the SAME firm is refused too.
  const siblingClient: Principal = {
    userId: randomUUID(),
    role: "client_user",
    firmId,
    clientPartyId: randomUUID(),
    buyerPartyId: null,
  };
  await assert.rejects(
    assistMatch(lineId, siblingClient, null),
    (err: Error & { code?: string }) => err.code === "CROSS_CLIENT",
  );
});
