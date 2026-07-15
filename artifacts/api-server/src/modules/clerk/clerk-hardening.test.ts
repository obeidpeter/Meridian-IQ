import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkInferenceCallsTable,
  firmsTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { createExtractionCase, decideCase } from "./cases.ts";
import { sha256 } from "./gateway.ts";
import {
  ensureClerkFixtures,
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Clerk plumbing hardening: the gateway-level budget backstop (no call site
// can forget the cap — the provider is never touched for an exhausted firm)
// and the decision compare-and-set (two concurrent decisions on the same case
// can never both apply). The route-level budget 429s stay covered by
// clerk-capture-scope.test.ts.

const SALT = makeRunSalt();

const firmId = randomUUID();
const brokeFirmId = randomUUID();
const supplierId = randomUUID();
const buyerId = randomUUID();
const makerId = randomUUID();
const checkerId = randomUUID();

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

before(async () => {
  await saveAndEnableClerkFlag();
  await ensureClerkFixtures({
    users: [
      { id: makerId, email: `clk-hard-maker-${SALT}@test.local` },
      { id: checkerId, email: `clk-hard-checker-${SALT}@test.local` },
    ],
    firmId,
    firmName: `Clerk Hardening Firm ${SALT}`,
    supplierId,
    supplierName: `Clerk Hardening Supplier ${SALT}`,
    buyerId,
    buyerName: `Clerk Hardening Buyer ${SALT}`,
    engagementTitle: `Clerk hardening ${SALT}`,
  });
  // A second firm whose entire default allowance (2,000,000 tokens) is
  // already ledgered as spent, for the backstop test.
  await getDb()
    .insert(firmsTable)
    .values({ id: brokeFirmId, name: `Clerk Hardening Broke Firm ${SALT}` });
  await getDb().insert(clerkInferenceCallsTable).values({
    firmId: brokeFirmId,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `hardening-budget-${SALT}`,
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

test("gateway backstop: an exhausted firm's call never reaches the provider", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okExtraction();
  });
  const input = `Backstop probe ${SALT}`;
  const result = await gateway.infer({
    purpose: "extract_invoice",
    firmId: brokeFirmId,
    promptVersion: "test",
    system: "test",
    user: input,
    schemaName: "invoice_extraction",
    jsonSchema: { type: "object" },
    validator: { safeParse: () => ({ success: true, data: {} }) } as never,
    inputForHash: input,
  });

  assert.equal(result.ok, false, "typed failure, not a throw");
  assert.equal(providerCalls, 0, "the provider was never touched");
  // No tokens were spent, so no ledger row either.
  const rows = await getDb()
    .select({ id: clerkInferenceCallsTable.id })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.inputRef, sha256(input)));
  assert.equal(rows.length, 0, "a call that never left the platform is not ledgered");
});

test("gateway backstop: capture for an exhausted firm fails the case closed", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okExtraction();
  });
  const kase = await createExtractionCase(
    {
      sourceType: "text",
      text: `Invoice HARD-BROKE-${SALT} total 100`,
      name: `hard-broke-${SALT}.txt`,
    },
    makerId,
    gateway,
    undefined,
    { firmId: brokeFirmId },
  );
  assert.equal(providerCalls, 0);
  assert.equal(kase.status, "failed", "no silent success without a model call");
  assert.ok(kase.failReason, "the case says why");
});

test("concurrent decisions: exactly one wins, the loser gets a 409", async () => {
  const gateway = fakeGateway(okExtraction);
  const kase = await createExtractionCase(
    {
      sourceType: "text",
      text: `Invoice HARD-RACE-${SALT} total 500`,
      name: `hard-race-${SALT}.txt`,
    },
    makerId,
    gateway,
    undefined,
    { firmId },
  );
  assert.equal(kase.status, "extracted");

  const decision = (n: number) =>
    decideCase(
      kase.id,
      {
        action: "approve",
        firmId,
        supplierPartyId: supplierId,
        buyerPartyId: buyerId,
        invoiceNumber: `HARD-RACE-${SALT}-${n}`,
        issueDate: "2026-07-01",
        currency: "NGN",
        category: "b2b",
        lines: [
          { description: "Goods", quantity: "1", unitPrice: "500.00", vatRate: "0.075" },
        ],
      },
      checkerId,
    );

  const [a, b] = await Promise.allSettled([decision(1), decision(2)]);
  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one decision applies");
  assert.equal(rejected.length, 1);
  const err = (rejected[0] as PromiseRejectedResult).reason as DomainError;
  assert.ok(err instanceof DomainError);
  assert.equal(err.status, 409, "the loser is told, never silently overwritten");

  const [row] = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(
      and(eq(clerkCasesTable.id, kase.id), eq(clerkCasesTable.status, "approved")),
    );
  assert.ok(row?.createdInvoiceId, "the winner's draft is recorded on the case");
});
