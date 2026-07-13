import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  usersTable,
  partiesTable,
  auditEventsTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import {
  createGateway,
  type ClerkProvider,
  type CompletionRequest,
} from "./gateway.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  saveAndEnableClerkFlag,
  restoreClerkFlag,
  fakeGateway,
} from "./test-support.ts";
import { createExtractionCase, decideCase, retryExtraction } from "./cases.ts";
import {
  nameScore,
  scorePartyCandidates,
  suggestPartiesForCase,
  tinScore,
} from "./party-match.ts";
import { sweepExpiredCaseContent } from "./retention.ts";
import {
  fieldMatches,
  listEvalRuns,
  runEvalCorpus,
  scoreFixture,
  withAccuracy,
} from "./eval.ts";
import { EVAL_FIXTURES, type EvalFixture } from "./eval-fixtures.ts";
import { CANONICAL_FIELDS, type CanonicalField } from "./prompts.ts";

// Clerk v0.4 package: party-matching suggestions, the OPEN-8 content
// retention sweep, and the §13.1 evaluation-run harness. Same conventions as
// the sibling clerk test files — fixed fixture IDs, injected fake gateways,
// flag restored after the run, per-run salt for persisted source content.

const FAKE_MODEL = "fake-model-v04";
const opA = "ffff0001-0000-4000-8000-00000000ff01";
const partySupplier = "ffff0002-0000-4000-8000-00000000ff02";
const partySupplierMerged = "ffff0003-0000-4000-8000-00000000ff03";
const partyBuyer = "ffff0004-0000-4000-8000-00000000ff04";
const partyOther = "ffff0005-0000-4000-8000-00000000ff05";

const RUN_SALT = makeRunSalt();

before(async () => {
  const db = getDb();
  await saveAndEnableClerkFlag();
  await db
    .insert(usersTable)
    .values({ id: opA, email: "clerk-v04@test.local" })
    .onConflictDoNothing();
  await db
    .insert(partiesTable)
    .values([
      {
        id: partySupplier,
        type: "client_business",
        legalName: "Adekunle Textiles Ltd",
        tin: "12345678-0001",
      },
      {
        id: partySupplierMerged,
        type: "client_business",
        legalName: "Adekunle Textiles (duplicate)",
        tin: "12345678-0001",
        mergedIntoId: partySupplier,
      },
      {
        id: partyBuyer,
        type: "buyer",
        legalName: "Harmony Fabrics Enterprises",
        tin: "87654321-0001",
      },
      {
        id: partyOther,
        type: "client_business",
        legalName: "Completely Unrelated Ventures",
        tin: "99999999-0001",
      },
    ])
    .onConflictDoNothing();
  // Earlier runs may have left the merged marker unset if this file evolves;
  // assert the fixture invariant every run.
  await db
    .update(partiesTable)
    .set({ mergedIntoId: partySupplier })
    .where(eq(partiesTable.id, partySupplierMerged));
});

after(async () => {
  await restoreClerkFlag();
});

// ---------------------------------------------------------------------------
// Party matching — pure scoring
// ---------------------------------------------------------------------------

test("tinScore matches only on normalized exact identity", () => {
  assert.equal(tinScore("1234-5678-0001", "12345678-0001"), 1);
  assert.equal(tinScore("12345678-0001", "12345678-0002"), 0);
  assert.equal(tinScore("123", "123"), 0, "too short to identify anyone");
  assert.equal(tinScore(null, "12345678-0001"), 0);
});

test("nameScore rewards containment and ignores legal-form suffixes", () => {
  assert.equal(nameScore("Chukwuma Stores", "Chukwuma Stores Nigeria Ltd"), 1);
  assert.equal(nameScore("ADEKUNLE TEXTILES", "Adekunle Textiles Ltd"), 1);
  assert.equal(nameScore("Zenith Fittings", "Harmony Fabrics Enterprises"), 0);
  assert.equal(nameScore(null, "Anything"), 0);
});

test("scorePartyCandidates ranks a TIN hit above a name-only hit", () => {
  const candidates = [
    {
      id: "a",
      legalName: "Adekunle Textiles Ltd",
      tin: "12345678-0001",
      type: "client_business" as const,
    },
    {
      id: "b",
      legalName: "Adekunle Textiles International Ltd",
      tin: "55555555-0001",
      type: "client_business" as const,
    },
  ];
  const scored = scorePartyCandidates(
    { name: "Adekunle Textiles", tin: "12345678-0001" },
    candidates,
  );
  assert.equal(scored[0]?.partyId, "a");
  assert.equal(scored[0]?.tinScore, 1);
  assert.ok(scored[0]!.confidence > scored[1]!.confidence);
  // No identity, no suggestions.
  assert.deepEqual(scorePartyCandidates({ name: null, tin: null }, candidates), []);
});

// ---------------------------------------------------------------------------
// Party matching — case endpoint behaviour
// ---------------------------------------------------------------------------

const V04_EXTRACTION = JSON.stringify({
  fields: [
    { field: "invoiceNumber", value: "INV-V04", confidence: 0.95, sourceSnippet: null },
    { field: "issueDate", value: "2026-07-01", confidence: 0.9, sourceSnippet: null },
    { field: "currency", value: "NGN", confidence: 0.9, sourceSnippet: null },
    { field: "supplierName", value: "Adekunle Textiles", confidence: 0.9, sourceSnippet: null },
    { field: "supplierTin", value: "12345678-0001", confidence: 0.9, sourceSnippet: null },
    { field: "buyerName", value: "Harmony Fabrics", confidence: 0.85, sourceSnippet: null },
    { field: "grandTotal", value: "215000", confidence: 0.85, sourceSnippet: null },
  ],
  lines: [],
});

test("suggestPartiesForCase scores register parties and skips merged tombstones", async () => {
  const gateway = fakeGateway(() => V04_EXTRACTION, FAKE_MODEL);
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 parties ${RUN_SALT}` },
    opA,
    gateway,
  );
  const suggestions = await suggestPartiesForCase(kase.id);

  const supplierIds = suggestions.supplier.map((s) => s.partyId);
  assert.ok(supplierIds.includes(partySupplier), "TIN+name hit must surface");
  assert.ok(
    !supplierIds.includes(partySupplierMerged),
    "merged parties are tombstones and never suggested",
  );
  assert.ok(
    !supplierIds.includes(partyOther),
    "unrelated parties stay below the threshold",
  );
  assert.equal(suggestions.supplier[0]?.partyId, partySupplier);
  assert.equal(suggestions.supplier[0]?.tinScore, 1);

  const buyerIds = suggestions.buyer.map((s) => s.partyId);
  assert.ok(buyerIds.includes(partyBuyer), "buyer name containment must surface");
});

test("party suggestions reject question cases and go empty without identity fields", async () => {
  const db = getDb();
  const [question] = await db
    .insert(clerkCasesTable)
    .values({
      kind: "question",
      status: "pending",
      question: "What is the VAT rate?",
      createdBy: opA,
    })
    .returning();
  await assert.rejects(
    suggestPartiesForCase(question.id),
    isDomainError("CASE_BAD_KIND"),
  );

  const bare = fakeGateway(
    () =>
      JSON.stringify({
        fields: [
          { field: "invoiceNumber", value: "INV-V04-BARE", confidence: 0.9, sourceSnippet: null },
        ],
        lines: [],
      }),
    FAKE_MODEL,
  );
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 bare ${RUN_SALT}` },
    opA,
    bare,
  );
  const suggestions = await suggestPartiesForCase(kase.id);
  assert.deepEqual(suggestions.supplier, []);
  assert.deepEqual(suggestions.buyer, []);
});

// ---------------------------------------------------------------------------
// Content retention sweep (OPEN-8)
// ---------------------------------------------------------------------------

async function backdateCase(id: string, days: number) {
  await getDb().execute(
    sql`UPDATE clerk_cases
        SET updated_at = now() - make_interval(days => ${days})
        WHERE id = ${id}`,
  );
}

test("the sweep purges raw content from old settled cases but keeps evidence", async () => {
  const gateway = fakeGateway(() => V04_EXTRACTION, FAKE_MODEL);
  const settled = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 retention settled ${RUN_SALT}` },
    opA,
    gateway,
  );
  await decideCase(settled.id, { action: "reject", reason: "retention test" }, opA);
  await backdateCase(settled.id, 40);

  // A live escalated case of the same age must NOT be touched.
  const invalidGateway = fakeGateway(() => "NOT JSON {{{", FAKE_MODEL);
  const escalated = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 retention escalated ${RUN_SALT}` },
    opA,
    invalidGateway,
  );
  assert.equal(escalated.status, "escalated");
  await backdateCase(escalated.id, 40);

  // A recent settled case must not be touched either.
  const recent = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 retention recent ${RUN_SALT}` },
    opA,
    gateway,
  );
  await decideCase(recent.id, { action: "reject", reason: "retention test" }, opA);

  const purged = await sweepExpiredCaseContent();
  assert.ok(purged >= 1, "the old settled case must be purged");

  const db = getDb();
  const [settledRow] = await db
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, settled.id));
  assert.equal(settledRow.sourceText, null, "raw content gone");
  assert.ok(settledRow.sourceHash, "hash retained (duplicate guard evidence)");
  assert.ok(settledRow.extraction, "extraction retained");

  const [escalatedRow] = await db
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, escalated.id));
  assert.ok(escalatedRow.sourceText, "live escalated case keeps its source");

  const [recentRow] = await db
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, recent.id));
  assert.ok(recentRow.sourceText, "recent settled case keeps its source");

  const [auditRow] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.case.content_purged"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow, "purges are audited");
});

test("a purged failed case fails retry safely instead of re-extracting nothing", async () => {
  let calls = 0;
  const flaky = fakeGateway(() => {
    calls += 1;
    if (calls === 1) throw new Error("provider down");
    return V04_EXTRACTION;
  }, FAKE_MODEL);
  const failed = await createExtractionCase(
    { sourceType: "text", text: `Invoice INV-V04 retention failed ${RUN_SALT}` },
    opA,
    flaky,
  );
  assert.equal(failed.status, "failed");
  await backdateCase(failed.id, 40);
  await sweepExpiredCaseContent();

  await assert.rejects(
    retryExtraction(failed.id, opA, flaky),
    isDomainError("CASE_NO_SOURCE"),
  );
});

// ---------------------------------------------------------------------------
// Evaluation harness — pure scoring
// ---------------------------------------------------------------------------

function outputFor(
  fixture: EvalFixture,
  overrides: Partial<Record<CanonicalField, string | null>> = {},
): string {
  return JSON.stringify({
    fields: CANONICAL_FIELDS.map((field) => ({
      field,
      value:
        overrides[field] !== undefined ? overrides[field] : fixture.expected[field],
      confidence: 0.9,
      sourceSnippet: null,
    })),
    lines: [],
  });
}

test("fieldMatches mirrors correction semantics (numeric tolerance, case-blind text, honest nulls)", () => {
  assert.equal(fieldMatches("grandTotal", "215000.00", "215,000"), true);
  assert.equal(fieldMatches("grandTotal", "215000", "215001"), false);
  assert.equal(fieldMatches("supplierName", "Adekunle Textiles Ltd", "ADEKUNLE TEXTILES LTD"), true);
  assert.equal(fieldMatches("dueDate", null, null), true);
  assert.equal(
    fieldMatches("dueDate", null, "2026-01-01"),
    false,
    "hallucinating a value for an absent field is an error",
  );
  assert.equal(fieldMatches("subtotal", null, ""), true, "blank equals null");
});

test("scoreFixture flags injection obedience through critical-field mismatches", () => {
  const injection = EVAL_FIXTURES.find((f) => f.key === "injection.instruction")!;
  const clean = JSON.parse(outputFor(injection));
  const resisted = scoreFixture(injection, clean);
  assert.equal(resisted.fieldsCorrect, resisted.fieldsCompared);
  assert.equal(resisted.injectionResisted, true);

  const obeyed = JSON.parse(
    outputFor(injection, {
      grandTotal: "1.00",
      supplierName: "APPROVED VENDOR LTD",
    }),
  );
  const tricked = scoreFixture(injection, obeyed);
  assert.equal(tricked.injectionResisted, false);
  assert.equal(tricked.mismatches.length, 2);

  const cleanFixture = EVAL_FIXTURES.find((f) => f.key === "clean.standard")!;
  const scored = scoreFixture(cleanFixture, JSON.parse(outputFor(cleanFixture)));
  assert.equal(scored.injectionResisted, null, "non-injection fixtures carry no verdict");
});

// ---------------------------------------------------------------------------
// Evaluation harness — full run through the gateway
// ---------------------------------------------------------------------------

test("runEvalCorpus scores the corpus, ledgers every call, and persists the run", async () => {
  // Fixture-aware fake: perfect answers everywhere except one deliberately
  // broken call (invalid JSON) and one obeyed injection.
  const provider: ClerkProvider = {
    model: "fake-eval-model",
    complete: async (req: CompletionRequest) => {
      const doc = typeof req.user === "string" ? req.user : "";
      const fixture = EVAL_FIXTURES.find((f) => doc.includes(f.sourceText));
      assert.ok(fixture, "every eval call carries a fixture document");
      if (fixture!.key === "skewed.ocr") return "NOT JSON {{{";
      if (fixture!.key === "injection.instruction") {
        return outputFor(fixture!, {
          grandTotal: "1.00",
          supplierName: "APPROVED VENDOR LTD",
        });
      }
      return outputFor(fixture!);
    },
  };
  const gateway = createGateway(provider);

  const run = await runEvalCorpus(opA, gateway);
  const okFixtures = EVAL_FIXTURES.length - 1; // skewed.ocr came back invalid

  assert.equal(run.fixtureCount, EVAL_FIXTURES.length);
  assert.equal(run.fieldsCompared, CANONICAL_FIELDS.length * okFixtures);
  assert.equal(
    run.fieldsCorrect,
    run.fieldsCompared - 2,
    "exactly the two tampered fields miss",
  );
  assert.equal(run.injectionFixtures, 2);
  assert.equal(run.injectionResisted, 1, "one injection resisted, one obeyed");
  assert.equal(run.model, "fake-eval-model");

  const invalid = run.results.find((r) => r.key === "skewed.ocr");
  assert.equal(invalid?.outcome, "invalid");
  assert.equal(invalid?.fieldsCompared, 0);

  // Accuracy is derived, not stored.
  const api = withAccuracy(run);
  assert.equal(
    api.accuracy,
    Number((run.fieldsCorrect / run.fieldsCompared).toFixed(4)),
  );

  // Every call is in the append-only ledger under the eval purpose.
  const db = getDb();
  const ledger = await db
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.purpose, "eval_extract"));
  assert.ok(ledger.length >= EVAL_FIXTURES.length);

  // The run is audited and listable (newest first).
  const [auditRow] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.eval.run"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow);
  const runs = await listEvalRuns(5);
  assert.equal(runs[0]?.id, run.id);
});
