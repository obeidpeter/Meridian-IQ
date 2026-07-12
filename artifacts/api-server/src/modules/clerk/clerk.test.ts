import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import {
  getDb,
  usersTable,
  firmsTable,
  partiesTable,
  engagementsTable,
  invoicesTable,
  claimRecordsTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  featureFlagsTable,
  type ClaimRecord,
  type ProtectedFact,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  CLERK_FLAG_KEY,
  assertClerkEnabled,
  createGateway,
  type ClerkGateway,
  type ClerkProvider,
} from "./gateway.ts";
import { setFlag } from "../flags/flags.ts";
import {
  CANONICAL_FIELDS,
  CRITICAL_FIELDS,
  intentValidator,
  type ExtractionOutput,
} from "./prompts.ts";
import {
  normalizeExtraction,
  createExtractionCase,
  decideCase,
  getCase,
} from "./cases.ts";
import { computeStatusLight } from "./status-light.ts";
import { formatFact, renderProposition, askClerk } from "./ask.ts";
import {
  createClaimDraft,
  submitClaim,
  decideClaim,
} from "./claims.ts";

// Fail-closed tests for Clerk v0 (Task #40). These verify the safety
// invariants, not the happy paths: the kill switch blocks everything, invalid
// model output is discarded, critical fields are always flagged, maker-checker
// blocks self-approval, approval NEVER goes past a draft invoice, and Ask
// Clerk refuses anything outside the approved register.

const suffix = randomUUID().slice(0, 8);
const FAKE_MODEL = "fake-model-test";
// Fixed test users: clerk_cases and the inference ledger are append-only
// audit artifacts (DB triggers forbid deletion), so the users they reference
// must persist. Fixed IDs keep reruns from accumulating users.
const makerId = "cccc0001-0000-4000-8000-00000000cc01";
const checkerId = "cccc0002-0000-4000-8000-00000000cc02";
// The firm/party/engagement fixtures are also fixed: the draft invoice an
// approval creates gets an immutable lifecycle event, so the invoice and the
// rows it references cannot be deleted afterwards either.
const firmId = "cccc0003-0000-4000-8000-00000000cc03";
const supplierId = "cccc0004-0000-4000-8000-00000000cc04";
const buyerId = "cccc0005-0000-4000-8000-00000000cc05";

let flagWasEnabled: boolean | null = null;

function fakeGateway(respond: () => string | Promise<string>): ClerkGateway {
  const provider: ClerkProvider = {
    model: FAKE_MODEL,
    complete: async () => respond(),
  };
  return createGateway(provider);
}

function expectDomainError(err: unknown, code: string, status: number): void {
  assert.ok(err instanceof DomainError, `expected DomainError, got ${err}`);
  assert.equal(err.code, code);
  assert.equal(err.status, status);
}

const RATE_FACT: ProtectedFact = {
  key: "rate",
  label: "Standard VAT rate",
  kind: "rate",
  value: "7.5",
  unit: "%",
};

async function activateTestClaim(claimKey: string): Promise<ClaimRecord> {
  const draft = await createClaimDraft(
    {
      claimKey,
      title: "Test claim",
      proposition: "The standard VAT rate is {rate}.",
      protectedFacts: [RATE_FACT],
      citation: "VAT Act s.4 (test)",
      applicability: {},
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
    makerId,
  );
  await submitClaim(draft.id, makerId);
  return decideClaim(draft.id, "approve", "test approval", checkerId);
}

before(async () => {
  const db = getDb();
  // Remember + force the kill switch ON so tests exercise real code paths.
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
      { id: makerId, email: "clerk-test-maker@test.local" },
      { id: checkerId, email: "clerk-test-checker@test.local" },
    ])
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: "Clerk Test Firm" })
    .onConflictDoNothing();
  await db
    .insert(partiesTable)
    .values([
      {
        id: supplierId,
        type: "client_business",
        legalName: "Clerk Test Supplier",
      },
      { id: buyerId, type: "buyer", legalName: "Clerk Test Buyer" },
    ])
    .onConflictDoNothing();
  // Party-in-firm linkage runs through engagements.
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
        title: "test",
      },
      {
        firmId,
        clientPartyId: buyerId,
        type: "readiness_assessment",
        title: "test",
      },
    ]);
  }
});

after(async () => {
  const db = getDb();
  // clerk_cases, clerk_inference_calls and invoice_lifecycle_events are
  // append-only (DB triggers forbid deletion) — that immutability is itself a
  // platform invariant — so those rows, the draft invoices they trail, and the
  // fixed fixtures above all persist across runs. Only the per-run claims
  // register rows are removed, and the kill switch is restored.
  await db
    .delete(claimRecordsTable)
    .where(like(claimRecordsTable.claimKey, "test.%"));
  if (flagWasEnabled === null) {
    await db
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY));
  } else {
    await setFlag(CLERK_FLAG_KEY, flagWasEnabled);
  }
});

// ---------------------------------------------------------------------------
// Pure rules (no DB, no model)
// ---------------------------------------------------------------------------

test("normalizeExtraction flags every critical field regardless of confidence", () => {
  const output: ExtractionOutput = {
    fields: CANONICAL_FIELDS.map((field) => ({
      field,
      value: "something",
      confidence: 0.99,
      sourceSnippet: null,
    })),
    lines: [],
  };
  const { fields } = normalizeExtraction(output);
  assert.equal(fields.length, CANONICAL_FIELDS.length);
  for (const f of fields) {
    if (CRITICAL_FIELDS.has(f.field as (typeof CANONICAL_FIELDS)[number])) {
      assert.equal(f.critical, true, `${f.field} should be critical`);
      assert.equal(
        f.flagged,
        true,
        `${f.field} must be flagged even at confidence 0.99`,
      );
    }
  }
  // dueDate is the only non-critical field: high confidence → not flagged.
  const dueDate = fields.find((f) => f.field === "dueDate");
  assert.ok(dueDate);
  assert.equal(dueDate.critical, false);
  assert.equal(dueDate.flagged, false);
});

test("normalizeExtraction flags missing and low-confidence fields", () => {
  const output: ExtractionOutput = {
    fields: [
      { field: "dueDate", value: "2026-08-01", confidence: 0.4, sourceSnippet: null },
    ],
    lines: [],
  };
  const { fields } = normalizeExtraction(output);
  const dueDate = fields.find((f) => f.field === "dueDate");
  assert.ok(dueDate);
  assert.equal(dueDate.flagged, true, "low confidence must flag");
  const missing = fields.find((f) => f.field === "invoiceNumber");
  assert.ok(missing);
  assert.equal(missing.value, null);
  assert.equal(missing.confidence, 0);
  assert.equal(missing.flagged, true, "missing value must flag");
});

test("computeStatusLight is deterministic over lifecycle state", () => {
  const draft = computeStatusLight({
    invoice: { status: "draft", dueDate: null },
    attempts: [],
    confirmations: [],
    stamp: null,
  });
  assert.equal(draft.light, "amber");

  const failed = computeStatusLight({
    invoice: { status: "failed", dueDate: null },
    attempts: [
      { status: "rejected", errorCode: "E-TIN-01", createdAt: new Date() },
    ],
    confirmations: [],
    stamp: null,
  });
  assert.equal(failed.light, "red");
  assert.ok(failed.reasons.some((r) => r.includes("E-TIN-01")));

  const stamped = computeStatusLight({
    invoice: { status: "stamped", dueDate: null },
    attempts: [],
    confirmations: [],
    stamp: { irn: "IRN-123" },
  });
  assert.equal(stamped.light, "green");

  const buyerRejected = computeStatusLight({
    invoice: { status: "stamped", dueDate: null },
    attempts: [],
    confirmations: [
      { state: "rejected", note: "wrong amount", createdAt: new Date() },
    ],
    stamp: { irn: "IRN-123" },
  });
  assert.equal(buyerRejected.light, "red");

  // Same input twice → identical output (pure function).
  assert.deepEqual(
    computeStatusLight({
      invoice: { status: "draft", dueDate: null },
      attempts: [],
      confirmations: [],
      stamp: null,
    }),
    draft,
  );
});

test("renderProposition inserts protected facts verbatim, never invents", () => {
  const claim = {
    proposition: "The standard VAT rate is {rate}, see {unknown_key}.",
    protectedFacts: [RATE_FACT],
  } as unknown as ClaimRecord;
  const rendered = renderProposition(claim);
  assert.equal(
    rendered,
    "The standard VAT rate is 7.5%, see {unknown_key}.",
    "facts verbatim; unknown placeholders left visible, not invented",
  );
  assert.equal(formatFact(RATE_FACT), "7.5%");
  assert.equal(
    formatFact({ ...RATE_FACT, unit: undefined }),
    "7.5",
    "unit-less facts render the raw value",
  );
});

test("intentValidator is a closed enum over the active register", () => {
  const validator = intentValidator(["vat.standard_rate"]);
  assert.equal(
    validator.safeParse({ claimKey: "made.up.key", category: "b2b" }).success,
    false,
    "keys outside the register must be rejected",
  );
  assert.equal(
    validator.safeParse({ claimKey: "vat.standard_rate", category: "b2b" })
      .success,
    true,
  );
  assert.equal(
    validator.safeParse({ claimKey: "none", category: "unknown" }).success,
    true,
    "'none' (refusal) is always allowed",
  );
});

// ---------------------------------------------------------------------------
// Kill switch (fail closed, DB-backed)
// ---------------------------------------------------------------------------

test("kill switch blocks every Clerk entry point with 503", async () => {
  await setFlag(CLERK_FLAG_KEY, false);
  try {
    await assert.rejects(assertClerkEnabled(), (err: unknown) => {
      expectDomainError(err, "CLERK_DISABLED", 503);
      return true;
    });

    let providerCalled = false;
    const gateway = fakeGateway(() => {
      providerCalled = true;
      return "{}";
    });
    await assert.rejects(
      gateway.infer({
        purpose: "classify_intent",
        promptVersion: "test.v1",
        system: "s",
        user: "u",
        schemaName: "t",
        jsonSchema: {},
        validator: intentValidator(["x"]),
        inputForHash: "u",
      }),
      (err: unknown) => {
        expectDomainError(err, "CLERK_DISABLED", 503);
        return true;
      },
    );
    assert.equal(providerCalled, false, "provider must never be reached");

    await assert.rejects(
      createExtractionCase(
        { sourceType: "text", text: "Invoice INV-1" },
        makerId,
        gateway,
      ),
      (err: unknown) => {
        expectDomainError(err, "CLERK_DISABLED", 503);
        return true;
      },
    );
    await assert.rejects(
      askClerk("What is the VAT rate?", makerId, gateway),
      (err: unknown) => {
        expectDomainError(err, "CLERK_DISABLED", 503);
        return true;
      },
    );
    assert.equal(providerCalled, false);
  } finally {
    await setFlag(CLERK_FLAG_KEY, true);
  }
});

// ---------------------------------------------------------------------------
// Invalid model output is discarded (DB-backed)
// ---------------------------------------------------------------------------

test("non-JSON model output is discarded and the case escalates", async () => {
  const gateway = fakeGateway(() => "THIS IS NOT JSON {{{");
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice test ${suffix}`, name: "bad.txt" },
    makerId,
    gateway,
  );
  assert.equal(kase.status, "escalated", "invalid output must escalate");
  assert.equal(kase.extraction, null, "discarded output must never be stored");
  assert.ok(kase.failReason && kase.failReason.includes("discarded"));

  const [ledger] = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.caseId, kase.id))
    .limit(1);
  assert.ok(ledger, "every inference call must be ledgered");
  assert.equal(ledger.outcome, "invalid_discarded");
  assert.equal(ledger.schemaValid, false);
});

test("schema-invalid JSON is discarded and the case escalates", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({ fields: "not-an-array", lines: [] }),
  );
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice test ${suffix} 2` },
    makerId,
    gateway,
  );
  assert.equal(kase.status, "escalated");
  assert.equal(kase.extraction, null);
});

test("provider errors mark the case failed, not silently retried", async () => {
  const gateway = fakeGateway(() => {
    throw new Error("upstream 500");
  });
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice test ${suffix} 3` },
    makerId,
    gateway,
  );
  assert.equal(kase.status, "failed");
  assert.equal(kase.extraction, null);
});

// ---------------------------------------------------------------------------
// Maker-checker on the claims register (DB-backed)
// ---------------------------------------------------------------------------

test("maker-checker: the author cannot approve their own claim version", async () => {
  const claimKey = `test.maker_checker.${suffix}`;
  const draft = await createClaimDraft(
    {
      claimKey,
      title: "Maker-checker test",
      proposition: "Rate is {rate}.",
      protectedFacts: [RATE_FACT],
      citation: "Test Act s.1",
      effectiveFrom: "2026-01-01",
    },
    makerId,
  );
  await submitClaim(draft.id, makerId);

  await assert.rejects(
    decideClaim(draft.id, "approve", null, makerId),
    (err: unknown) => {
      expectDomainError(err, "CLAIM_SELF_APPROVAL", 403);
      return true;
    },
  );
  const [still] = await getDb()
    .select()
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.id, draft.id))
    .limit(1);
  assert.equal(still.state, "review", "failed approval must not change state");

  const approved = await decideClaim(draft.id, "approve", "ok", checkerId);
  assert.equal(approved.state, "active");
  assert.equal(approved.decidedBy, checkerId);
});

// ---------------------------------------------------------------------------
// Review flow: approval creates a DRAFT invoice and nothing more (DB-backed)
// ---------------------------------------------------------------------------

test("approving an extraction case creates a draft invoice only — never submits", async () => {
  const goodOutput: ExtractionOutput = {
    fields: [
      {
        field: "invoiceNumber",
        value: `CLK-${suffix}`,
        confidence: 0.95,
        sourceSnippet: `Invoice No CLK-${suffix}`,
      },
    ],
    lines: [
      {
        description: "Consulting",
        quantity: "1",
        unitPrice: "1000.00",
        vatRate: "0.075",
        confidence: 0.9,
      },
    ],
  };
  const gateway = fakeGateway(() => JSON.stringify(goodOutput));
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice CLK-${suffix}` },
    makerId,
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
      invoiceNumber: `CLK-${suffix}`,
      issueDate: "2026-07-01",
      currency: "NGN",
      category: "b2b",
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          unitPrice: "1000.00",
          vatRate: "0.075",
        },
      ],
    },
    checkerId,
  );
  assert.equal(decided.status, "approved");
  assert.ok(decided.createdInvoiceId, "approval must record the created draft");

  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, decided.createdInvoiceId!))
    .limit(1);
  assert.ok(invoice);
  assert.equal(
    invoice.status,
    "draft",
    "THE no-submit invariant: approval must stop at a draft",
  );

  const attempts = await getDb().execute(
    sql`SELECT id FROM submission_attempts WHERE invoice_id = ${invoice.id}`,
  );
  assert.equal(
    attempts.rows.length,
    0,
    "approval must never create a submission attempt",
  );

  // A decided case cannot be decided again.
  await assert.rejects(
    decideCase(kase.id, { action: "reject", reason: "again" }, checkerId),
    (err: unknown) => {
      expectDomainError(err, "CASE_BAD_STATE", 409);
      return true;
    },
  );
});

test("approval with percent-style VAT rates is rejected loudly", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({ fields: [], lines: [] } satisfies ExtractionOutput),
  );
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice VAT test ${suffix}` },
    makerId,
    gateway,
  );
  await assert.rejects(
    decideCase(
      kase.id,
      {
        action: "approve",
        firmId,
        supplierPartyId: supplierId,
        buyerPartyId: buyerId,
        invoiceNumber: `CLK-VAT-${suffix}`,
        issueDate: "2026-07-01",
        lines: [
          { description: "x", quantity: "1", unitPrice: "100", vatRate: "7.5" },
        ],
      },
      checkerId,
    ),
    (err: unknown) => {
      expectDomainError(err, "VAT_RATE_IMPLAUSIBLE", 400);
      return true;
    },
  );
});

test("approval with a missing VAT rate is rejected — never auto-filled with a default", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({ fields: [], lines: [] } satisfies ExtractionOutput),
  );
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice missing-VAT test ${suffix}` },
    makerId,
    gateway,
  );
  await assert.rejects(
    decideCase(
      kase.id,
      {
        action: "approve",
        firmId,
        supplierPartyId: supplierId,
        buyerPartyId: buyerId,
        invoiceNumber: `CLK-NOVAT-${suffix}`,
        issueDate: "2026-07-01",
        lines: [
          { description: "x", quantity: "1", unitPrice: "100", vatRate: "" },
        ],
      },
      checkerId,
    ),
    (err: unknown) => {
      expectDomainError(err, "VAT_RATE_IMPLAUSIBLE", 400);
      assert.match(String((err as Error).message), /required/i);
      return true;
    },
  );
  // The rejected approval must leave the case undecided (status unchanged).
  const after = await getCase(kase.id);
  assert.equal(after.status, kase.status);
  assert.notEqual(after.status, "approved");
});

// ---------------------------------------------------------------------------
// Ask Clerk: register-only answers, refusal otherwise (DB-backed)
// ---------------------------------------------------------------------------

test("askClerk answers verbatim from the register with citation", async () => {
  const claimKey = `test.ask.${suffix}`;
  const claim = await activateTestClaim(claimKey);

  const gateway = fakeGateway(() =>
    JSON.stringify({ claimKey, category: "b2b" }),
  );
  const kase = await askClerk("What is the VAT rate?", makerId, gateway);
  assert.equal(kase.status, "approved");
  assert.ok(kase.answer);
  assert.equal(kase.answer.answered, true);
  assert.equal(kase.answer.claimKey, claimKey);
  assert.equal(kase.answer.claimVersion, claim.version);
  assert.ok(
    kase.answer.proposition?.includes("7.5%"),
    "protected fact must appear verbatim in the answer",
  );
  assert.equal(kase.answer.citation, "VAT Act s.4 (test)");
  assert.deepEqual(kase.answer.facts, [RATE_FACT]);
});

test("askClerk refuses topics outside the register and escalates", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({ claimKey: "none", category: "unknown" }),
  );
  const kase = await askClerk(
    "Should I incorporate in Delaware?",
    makerId,
    gateway,
  );
  assert.equal(kase.status, "escalated", "refusals escalate to an operator");
  assert.ok(kase.answer);
  assert.equal(kase.answer.answered, false);
  assert.ok(
    kase.answer.refusalReason?.startsWith(
      "I can only answer from the approved claims register.",
    ),
    "refusal must use the neutral register-only wording",
  );
});

test("askClerk refuses when the model output cannot be trusted", async () => {
  const gateway = fakeGateway(() => "garbage output");
  const kase = await askClerk("What is the VAT rate?", makerId, gateway);
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
});

test("askClerk re-verifies the claim key against the register (fail closed)", async () => {
  // The model names a key that is NOT in the active register: even though the
  // closed enum should prevent this, the app re-checks and refuses.
  const gateway = fakeGateway(() =>
    JSON.stringify({ claimKey: `test.notactive.${suffix}`, category: "b2b" }),
  );
  const kase = await askClerk("What about the other rate?", makerId, gateway);
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
});
