import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  usersTable,
  firmsTable,
  partiesTable,
  engagementsTable,
  auditEventsTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  CLERK_FLAG_KEY,
  createGateway,
  type ClerkGateway,
  type ClerkProvider,
} from "./gateway.ts";
import { setFlag } from "../flags/flags.ts";
import {
  computeLineCorrections,
  createExtractionCase,
  decideCase,
  retryExtraction,
} from "./cases.ts";
import {
  createClaimDraft,
  decideClaim,
  getActiveClaims,
  getClaim,
  submitClaim,
  sweepExpiredClaims,
} from "./claims.ts";
import { getClerkMetrics } from "./metrics.ts";

// Clerk v0.3 package: cost tracking, line-level corrections, the
// duplicate-document guard + retry, and claims governance freshness. Same
// conventions as the sibling clerk test files — fixed fixture IDs (append-only
// ledgers keep referenced rows forever), injected fake gateways, flag restored
// after the run. Case source text and claim keys are salted per run because
// case rows and claim versions persist across runs of the shared database.

const FAKE_MODEL = "fake-model-v03";
const opA = "eeee0001-0000-4000-8000-00000000ee01";
const opB = "eeee0002-0000-4000-8000-00000000ee02";
const firmId = "eeee0003-0000-4000-8000-00000000ee03";
const supplierId = "eeee0004-0000-4000-8000-00000000ee04";
const buyerId = "eeee0005-0000-4000-8000-00000000ee05";

const RUN_SALT = `${Date.now()}-${process.pid}`;

let flagWasEnabled: boolean | null = null;

function fakeGateway(
  respond: () => string | { content: string; promptTokens?: number | null; completionTokens?: number | null },
): ClerkGateway {
  const provider: ClerkProvider = {
    model: FAKE_MODEL,
    complete: async () => respond(),
  };
  return createGateway(provider);
}

const EXTRACTION_WITH_LINES = JSON.stringify({
  fields: [
    { field: "invoiceNumber", value: "INV-900", confidence: 0.95, sourceSnippet: null },
    { field: "issueDate", value: "2026-07-01", confidence: 0.9, sourceSnippet: null },
    { field: "currency", value: "NGN", confidence: 0.9, sourceSnippet: null },
    { field: "grandTotal", value: "215000", confidence: 0.85, sourceSnippet: null },
  ],
  lines: [
    {
      description: "Widget A",
      quantity: "2",
      unitPrice: "100000.00",
      vatRate: "7.5",
      confidence: 0.9,
    },
  ],
});

before(async () => {
  const db = getDb();
  const [flag] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY))
    .limit(1);
  flagWasEnabled = flag ? flag.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: CLERK_FLAG_KEY, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  await db
    .insert(usersTable)
    .values([
      { id: opA, email: "clerk-v03-a@test.local" },
      { id: opB, email: "clerk-v03-b@test.local" },
    ])
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: "Clerk V03 Test Firm" })
    .onConflictDoNothing();
  await db
    .insert(partiesTable)
    .values([
      { id: supplierId, type: "client_business", legalName: "V03 Supplier" },
      { id: buyerId, type: "buyer", legalName: "V03 Buyer" },
    ])
    .onConflictDoNothing();
  const existing = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.firmId, firmId));
  if (existing.length === 0) {
    await db.insert(engagementsTable).values([
      {
        firmId,
        clientPartyId: supplierId,
        type: "readiness_assessment",
        title: "v03 test",
      },
      {
        firmId,
        clientPartyId: buyerId,
        type: "readiness_assessment",
        title: "v03 test",
      },
    ]);
  }
});

after(async () => {
  if (flagWasEnabled === null) {
    await getDb()
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY));
  } else {
    await setFlag(CLERK_FLAG_KEY, flagWasEnabled);
  }
});

// ---------------------------------------------------------------------------
// Line-level corrections
// ---------------------------------------------------------------------------

test("computeLineCorrections diffs positionally and records count drift", () => {
  const extracted = [
    { description: "Widget A", quantity: "2", unitPrice: "100.00", vatRate: "7.5", confidence: 0.9 },
    { description: "Delivery", quantity: "1", unitPrice: "50", vatRate: null, confidence: 0.8 },
  ];
  const approved = [
    { description: "Widget A", quantity: "3", unitPrice: "100", vatRate: "0.075" },
  ];
  const byField = new Map(
    computeLineCorrections(extracted, approved).map((c) => [c.field, c]),
  );
  // The operator dropped a line: count drift is itself a correction.
  assert.equal(byField.get("lines.count")?.changed, true);
  assert.equal(byField.get("lines.count")?.extracted, "2");
  assert.equal(byField.get("lines.count")?.final, "1");
  // Paired line 0: description kept, quantity overridden, price formatting
  // difference is NOT an override.
  assert.equal(byField.get("lines.0.description")?.changed, false);
  assert.equal(byField.get("lines.0.quantity")?.changed, true);
  assert.equal(byField.get("lines.0.quantity")?.extracted, "2");
  assert.equal(byField.get("lines.0.quantity")?.final, "3");
  assert.equal(byField.get("lines.0.unitPrice")?.changed, false);
  // VAT dialects: the document prints "7.5" (percent), the API carries
  // "0.075" (fraction). Same rate, so NOT an override.
  assert.equal(byField.get("lines.0.vatRate")?.changed, false);
  // The dropped second line has no pair and produces no per-field entries.
  assert.equal(byField.has("lines.1.description"), false);
});

test("computeLineCorrections treats a real VAT change and null-vs-value as overrides", () => {
  const extracted = [
    { description: "X", quantity: "1", unitPrice: "10", vatRate: "7.5", confidence: 0.9 },
    { description: "Y", quantity: "1", unitPrice: "10", vatRate: null, confidence: 0.9 },
  ];
  const approved = [
    { description: "X", quantity: "1", unitPrice: "10", vatRate: "0.05" },
    { description: "Y", quantity: "1", unitPrice: "10", vatRate: "0.075" },
  ];
  const byField = new Map(
    computeLineCorrections(extracted, approved).map((c) => [c.field, c]),
  );
  assert.equal(byField.get("lines.count")?.changed, false);
  assert.equal(byField.get("lines.0.vatRate")?.changed, true, "7.5% -> 5% is a real change");
  assert.equal(byField.get("lines.1.vatRate")?.changed, true, "null -> 7.5% is a real change");
});

test("approval stores line-level corrections alongside header corrections", async () => {
  const gateway = fakeGateway(() => EXTRACTION_WITH_LINES);
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-900 lines ${RUN_SALT}` },
    opA,
    gateway,
  );
  assert.equal(kase.status, "extracted");
  const decided = await decideCase(
    kase.id,
    {
      action: "approve",
      firmId,
      supplierPartyId: supplierId,
      buyerPartyId: buyerId,
      invoiceNumber: `INV-900-${RUN_SALT}`,
      issueDate: "2026-07-01",
      currency: "NGN",
      lines: [
        // Operator corrected the quantity; VAT arrives in fraction dialect.
        { description: "Widget A", quantity: "3", unitPrice: "100000", vatRate: "0.075" },
      ],
    },
    opA,
  );
  assert.equal(decided.status, "approved");
  const byField = new Map(decided.corrections!.map((c) => [c.field, c]));
  // Header exhaust still present…
  assert.ok(byField.has("invoiceNumber"));
  // …and the line exhaust joins it.
  assert.equal(byField.get("lines.count")?.changed, false);
  assert.equal(byField.get("lines.0.quantity")?.changed, true);
  assert.equal(byField.get("lines.0.unitPrice")?.changed, false);
  assert.equal(byField.get("lines.0.vatRate")?.changed, false);
});

// ---------------------------------------------------------------------------
// Duplicate-document guard + retry
// ---------------------------------------------------------------------------

test("the same document is rejected as a duplicate unless deliberately overridden", async () => {
  const gateway = fakeGateway(() => EXTRACTION_WITH_LINES);
  const text = `Invoice INV-901 duplicate probe ${RUN_SALT}`;
  const first = await createExtractionCase(
    { sourceType: "text", text },
    opA,
    gateway,
  );
  assert.equal(first.status, "extracted");
  assert.ok(first.sourceHash, "cases record their source hash");

  await assert.rejects(
    createExtractionCase({ sourceType: "text", text }, opA, gateway),
    (e: unknown) =>
      e instanceof DomainError &&
      e.code === "DUPLICATE_SOURCE" &&
      e.status === 409,
  );

  // The operator saw the warning and insists: allowDuplicate bypasses.
  const second = await createExtractionCase(
    { sourceType: "text", text, allowDuplicate: true },
    opA,
    gateway,
  );
  assert.equal(second.status, "extracted");
  assert.equal(second.sourceHash, first.sourceHash);
});

test("a failed or rejected case does not block re-upload", async () => {
  let calls = 0;
  const flaky = fakeGateway(() => {
    calls += 1;
    if (calls === 1) throw new Error("provider down");
    return EXTRACTION_WITH_LINES;
  });
  const text = `Invoice INV-902 failed-then-reupload ${RUN_SALT}`;
  const failed = await createExtractionCase(
    { sourceType: "text", text },
    opA,
    flaky,
  );
  assert.equal(failed.status, "failed");
  // Same content again: the failed case is not a live duplicate.
  const retried = await createExtractionCase(
    { sourceType: "text", text },
    opA,
    flaky,
  );
  assert.equal(retried.status, "extracted");
});

test("retry re-runs extraction on the stored source of a failed case", async () => {
  let calls = 0;
  const flaky = fakeGateway(() => {
    calls += 1;
    if (calls === 1) throw new Error("provider down");
    return EXTRACTION_WITH_LINES;
  });
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-903 retry ${RUN_SALT}` },
    opA,
    flaky,
  );
  assert.equal(kase.status, "failed");
  assert.ok(kase.failReason);

  const retried = await retryExtraction(kase.id, opA, flaky);
  assert.equal(retried.status, "extracted");
  assert.equal(retried.failReason, null, "a successful retry clears the fail reason");
  assert.ok(retried.extraction?.fields.length);

  // Only failed cases can be retried — an extracted case cannot be re-rolled.
  await assert.rejects(
    retryExtraction(kase.id, opA, flaky),
    (e: unknown) => e instanceof DomainError && e.code === "CASE_BAD_STATE",
  );
});

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

test("the gateway records token usage in the ledger and metrics report cost", async () => {
  const gateway = fakeGateway(() => ({
    content: EXTRACTION_WITH_LINES,
    promptTokens: 111,
    completionTokens: 22,
  }));
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-904 tokens ${RUN_SALT}` },
    opA,
    gateway,
  );
  assert.equal(kase.status, "extracted");

  const [call] = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.caseId, kase.id))
    .limit(1);
  assert.ok(call);
  assert.equal(call.promptTokens, 111);
  assert.equal(call.completionTokens, 22);

  // Decide the case so it enters the tokens-per-decided-case denominator.
  await decideCase(kase.id, { action: "reject", reason: "cost test" }, opA);

  const prevIn = process.env.CLERK_COST_PER_1M_INPUT_USD;
  const prevOut = process.env.CLERK_COST_PER_1M_OUTPUT_USD;
  try {
    delete process.env.CLERK_COST_PER_1M_INPUT_USD;
    delete process.env.CLERK_COST_PER_1M_OUTPUT_USD;
    const bare = await getClerkMetrics(30);
    assert.ok(bare.cost.promptTokens >= 111);
    assert.ok(bare.cost.completionTokens >= 22);
    assert.ok(bare.cost.callsWithUsage >= 1);
    assert.ok(
      bare.cost.tokensPerDecidedCase !== null &&
        bare.cost.tokensPerDecidedCase > 0,
      "a decided case with usage yields a per-case figure",
    );
    assert.equal(
      bare.cost.estimatedUsd,
      null,
      "no USD estimate without configured rates",
    );

    process.env.CLERK_COST_PER_1M_INPUT_USD = "2";
    process.env.CLERK_COST_PER_1M_OUTPUT_USD = "8";
    const priced = await getClerkMetrics(30);
    assert.ok(priced.cost.estimatedUsd !== null && priced.cost.estimatedUsd > 0);
  } finally {
    if (prevIn === undefined) delete process.env.CLERK_COST_PER_1M_INPUT_USD;
    else process.env.CLERK_COST_PER_1M_INPUT_USD = prevIn;
    if (prevOut === undefined) delete process.env.CLERK_COST_PER_1M_OUTPUT_USD;
    else process.env.CLERK_COST_PER_1M_OUTPUT_USD = prevOut;
  }
});

// ---------------------------------------------------------------------------
// Claims governance freshness (CLK-KB-07)
// ---------------------------------------------------------------------------

async function approveClaim(input: {
  claimKey: string;
  effectiveTo?: string | null;
  reviewDueAt?: string | null;
}) {
  const draft = await createClaimDraft(
    {
      claimKey: input.claimKey,
      title: "V03 freshness test",
      proposition: "Test proposition for {rate}.",
      protectedFacts: [
        { key: "rate", label: "Rate", kind: "rate", value: "7.5%" },
      ],
      citation: "Test citation",
      effectiveFrom: "2020-01-01",
      effectiveTo: input.effectiveTo ?? null,
      reviewDueAt: input.reviewDueAt ?? null,
    },
    opA,
  );
  await submitClaim(draft.id, opA);
  // Maker-checker: a second operator approves.
  return decideClaim(draft.id, "approve", "v03 test", opB);
}

test("a claim overdue for review is register-visible but not answerable", async () => {
  const overdue = await approveClaim({
    claimKey: `v03.freshness.overdue.${RUN_SALT}`,
    reviewDueAt: "2020-06-01", // long past
  });
  const fresh = await approveClaim({
    claimKey: `v03.freshness.fresh.${RUN_SALT}`,
    reviewDueAt: "2099-01-01",
  });
  const undated = await approveClaim({
    claimKey: `v03.freshness.undated.${RUN_SALT}`,
  });

  assert.equal(overdue.state, "active", "overdue-review claims stay active in the register");
  const answerableIds = new Set((await getActiveClaims()).map((c) => c.id));
  assert.equal(answerableIds.has(overdue.id), false, "overdue claims cannot answer");
  assert.equal(answerableIds.has(fresh.id), true);
  assert.equal(answerableIds.has(undated.id), true, "no review date means no freshness gate");
});

test("the sweep expires active claims whose effective window has closed", async () => {
  const lapsed = await approveClaim({
    claimKey: `v03.expiry.${RUN_SALT}`,
    effectiveTo: "2021-01-01", // long past
  });
  assert.equal(lapsed.state, "active");

  const flipped = await sweepExpiredClaims();
  assert.ok(flipped >= 1, "at least the lapsed claim flips");

  const now = await getClaim(lapsed.id);
  assert.equal(now.state, "expired");

  // The flip is audited.
  const [auditRow] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.claim.expired"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow);

  // Idempotent: a second sweep finds nothing new for this claim.
  await sweepExpiredClaims();
  assert.equal((await getClaim(lapsed.id)).state, "expired");
});
