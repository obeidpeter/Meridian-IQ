import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  usersTable,
  firmsTable,
  partiesTable,
  engagementsTable,
  auditEventsTable,
  clerkInferenceCallsTable,
  type ClerkExtraction,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { DomainError } from "../errors.ts";
import {
  CLERK_FLAG_KEY,
  createGateway,
  type ClerkGateway,
  type ClerkProvider,
} from "./gateway.ts";
import { isFeatureEnabled, setFlag } from "../flags/flags.ts";
import {
  claimCase,
  computeCorrections,
  createExtractionCase,
  decideCase,
  releaseCase,
} from "./cases.ts";
import { runClerkWatchdog } from "./watchdog.ts";

// Clerk operations package: correction exhaust, case claiming, and the
// watchdog auto-trip. Same conventions as the sibling clerk test files —
// fixed fixture IDs (append-only ledgers keep referenced rows forever),
// injected fake gateway, flag restored after the run.

const FAKE_MODEL = "fake-model-test";
const opA = "dddd0001-0000-4000-8000-00000000dd01";
const opB = "dddd0002-0000-4000-8000-00000000dd02";
const firmId = "dddd0003-0000-4000-8000-00000000dd03";
const supplierId = "dddd0004-0000-4000-8000-00000000dd04";
const buyerId = "dddd0005-0000-4000-8000-00000000dd05";

let flagWasEnabled: boolean | null = null;

function fakeGateway(respond: () => string): ClerkGateway {
  const provider: ClerkProvider = {
    model: FAKE_MODEL,
    complete: async () => respond(),
  };
  return createGateway(provider);
}

const EXTRACTION_JSON = JSON.stringify({
  fields: [
    { field: "invoiceNumber", value: "INV-500", confidence: 0.95, sourceSnippet: null },
    { field: "issueDate", value: "2026-07-01", confidence: 0.9, sourceSnippet: null },
    { field: "currency", value: "NGN", confidence: 0.9, sourceSnippet: null },
    { field: "grandTotal", value: "161250", confidence: 0.85, sourceSnippet: null },
  ],
  lines: [],
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
      { id: opA, email: "clerk-ops-a@test.local" },
      { id: opB, email: "clerk-ops-b@test.local" },
    ])
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: "Clerk Ops Test Firm" })
    .onConflictDoNothing();
  await db
    .insert(partiesTable)
    .values([
      { id: supplierId, type: "client_business", legalName: "Ops Supplier" },
      { id: buyerId, type: "buyer", legalName: "Ops Buyer" },
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
        title: "ops test",
      },
      {
        firmId,
        clientPartyId: buyerId,
        type: "readiness_assessment",
        title: "ops test",
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
// Correction exhaust
// ---------------------------------------------------------------------------

const SAMPLE_EXTRACTION: ClerkExtraction = {
  fields: [
    { field: "invoiceNumber", value: "INV-500", confidence: 0.95, sourceSnippet: null, critical: true, flagged: true },
    { field: "issueDate", value: "2026-07-01", confidence: 0.9, sourceSnippet: null, critical: true, flagged: true },
    { field: "currency", value: "NGN", confidence: 0.9, sourceSnippet: null, critical: true, flagged: true },
    { field: "grandTotal", value: "161250", confidence: 0.85, sourceSnippet: null, critical: true, flagged: true },
  ],
  lines: [],
  promptVersion: "extract.v1",
  model: FAKE_MODEL,
};

test("computeCorrections marks kept vs overridden fields", () => {
  const corrections = computeCorrections(SAMPLE_EXTRACTION, {
    invoiceNumber: "INV-500", // kept
    issueDate: "2026-07-02", // operator corrected the date
    dueDate: null, // model proposed nothing, operator set nothing
    currency: "NGN", // kept
    subtotal: "150000.00",
    vatTotal: "11250.00",
    grandTotal: "161250.00", // numerically equal to "161250" -> kept
  });
  const byField = new Map(corrections.map((c) => [c.field, c]));
  assert.equal(byField.get("invoiceNumber")?.changed, false);
  assert.equal(byField.get("issueDate")?.changed, true);
  assert.equal(byField.get("issueDate")?.extracted, "2026-07-01");
  assert.equal(byField.get("issueDate")?.final, "2026-07-02");
  assert.equal(byField.get("currency")?.changed, false);
  // Numeric equality tolerates formatting, not value drift.
  assert.equal(byField.get("grandTotal")?.changed, false);
  // Model proposed nothing for subtotal; operator's lines produced one.
  assert.equal(byField.get("subtotal")?.changed, true);
  // Both sides empty: not an override.
  assert.equal(byField.get("dueDate")?.changed, false);
});

test("approval stores the correction exhaust on the case", async () => {
  const gateway = fakeGateway(() => EXTRACTION_JSON);
  const kase = await createExtractionCase(
    { sourceType: "text", text: "Invoice INV-500 ..." },
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
      invoiceNumber: "INV-500-FIXED", // operator corrected the number
      issueDate: "2026-07-01",
      currency: "NGN",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "150000", vatRate: "0.075" },
      ],
    },
    opA,
  );
  assert.equal(decided.status, "approved");
  assert.ok(decided.corrections);
  const inv = decided.corrections!.find((c) => c.field === "invoiceNumber");
  assert.ok(inv);
  assert.equal(inv!.changed, true);
  assert.equal(inv!.extracted, "INV-500");
  assert.equal(inv!.final, "INV-500-FIXED");
  const date = decided.corrections!.find((c) => c.field === "issueDate");
  assert.equal(date?.changed, false);
});

// ---------------------------------------------------------------------------
// Case claiming
// ---------------------------------------------------------------------------

test("claiming is first-wins; the holder decides; release hands over", async () => {
  const gateway = fakeGateway(() => EXTRACTION_JSON);
  const kase = await createExtractionCase(
    { sourceType: "text", text: "Invoice INV-501 ..." },
    opA,
    gateway,
  );

  const claimed = await claimCase(kase.id, opA);
  assert.equal(claimed.status, "in_review");
  assert.equal(claimed.claimedBy, opA);
  assert.ok(claimed.claimedAt);

  // Second claim loses.
  await assert.rejects(
    claimCase(kase.id, opB),
    (e: unknown) => e instanceof DomainError && e.code === "CASE_CLAIM_CONFLICT",
  );

  // A non-holder cannot decide a claimed case.
  await assert.rejects(
    decideCase(kase.id, { action: "reject", reason: "not mine" }, opB),
    (e: unknown) => e instanceof DomainError && e.code === "CASE_CLAIMED",
  );

  // Release puts it back in the queue; the other operator can then decide.
  const released = await releaseCase(kase.id, opB);
  assert.equal(released.status, "extracted");
  assert.equal(released.claimedBy, null);
  const decided = await decideCase(
    kase.id,
    { action: "reject", reason: "test rejection" },
    opB,
  );
  assert.equal(decided.status, "rejected");
});

test("only extracted cases can be claimed", async () => {
  const gateway = fakeGateway(() => EXTRACTION_JSON);
  const kase = await createExtractionCase(
    { sourceType: "text", text: "Invoice INV-502 ..." },
    opA,
    gateway,
  );
  await decideCase(kase.id, { action: "escalate", reason: "test" }, opA);
  await assert.rejects(
    claimCase(kase.id, opA),
    (e: unknown) => e instanceof DomainError && e.code === "CASE_CLAIM_CONFLICT",
  );
});

// ---------------------------------------------------------------------------
// Watchdog auto-trip
// ---------------------------------------------------------------------------

test("watchdog trips the kill switch on a bad-output spike and audits it", async () => {
  // Injected flag state: the real platform flag is shared by concurrently
  // running test files and must not be flipped mid-suite.
  let enabled = true;
  const deps = {
    isEnabled: async () => enabled,
    disable: async () => {
      enabled = false;
    },
  };
  // The append-only ledger is shared across the suite, and this run's other
  // tests have already written healthy calls into the watchdog window. Seed
  // exactly enough bad rows to push the window past the trip threshold no
  // matter what came before: with T existing calls (B of them bad), adding N
  // bad rows gives (B+N)/(T+N) >= 0.5 whenever N >= T - 2B.
  const db = getDb();
  const [win] = (
    await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE outcome IN ('invalid_discarded','error'))::int AS bad
      FROM clerk_inference_calls
      WHERE created_at >= now() - make_interval(mins => 60)
    `)
  ).rows as { total: number; bad: number }[];
  const needed = Math.max(12, (win?.total ?? 0) - 2 * (win?.bad ?? 0) + 2);
  const values = Array.from({ length: needed }, (_, i) => ({
    purpose: "extract_invoice",
    model: "watchdog-test-model",
    promptVersion: "wd.v1",
    inputRef: `wd-${Date.now()}-${i}`,
    outputJson: null,
    schemaValid: false,
    outcome: "invalid_discarded" as const,
    latencyMs: 1,
  }));
  await db.insert(clerkInferenceCallsTable).values(values);

  const result = await runClerkWatchdog(deps);
  assert.equal(result.checked, true);
  assert.equal(result.tripped, true);
  assert.ok(result.badRate >= 0.5);
  assert.equal(enabled, false, "watchdog must disable the capability");

  // The trip is audited with its evidence.
  const [auditRow] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.kill_switch.auto_tripped"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow);

  // With Clerk off, the watchdog stands down instead of re-evaluating.
  const second = await runClerkWatchdog(deps);
  assert.equal(second.checked, false);
  assert.equal(second.tripped, false);
});
