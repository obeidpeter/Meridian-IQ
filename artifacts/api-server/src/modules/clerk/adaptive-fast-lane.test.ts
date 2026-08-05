import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkEvalFixturesTable,
  type ClerkCorrection,
  type ClerkExtraction,
} from "@workspace/db";
import {
  saveAndEnableClerkFlag,
  restoreClerkFlag,
  ensureClerkFixtures,
  fakeGateway,
} from "./test-support.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";
import type { ExtractionOutput } from "./prompts.ts";
import {
  FAST_LANE_DEFAULT,
  FAST_LANE_FLOOR,
  firmFastLaneThreshold,
} from "./metrics.ts";
import { createExtractionCase, type CaseDecisionInput } from "./cases.ts";
import { bulkApproveCases, fastLaneBlocker } from "./bulk-approve.ts";

// Adaptive fast lane (round 7). Invariants pinned here:
//  - firmFastLaneThreshold derives from the firm's OWN calibration exhaust:
//    a firm whose top confidence band holds >= 200 compared fields at a kept
//    rate >= 0.97 relaxes to the 0.8 floor; anything less (including no firm
//    at all) stays at the 0.9 default — the deliberate conservative rule;
//  - bulkApproveCases resolves the threshold per case firm and threads it
//    into the same fastLaneBlocker predicate, so a 0.85-confidence critical
//    field passes the fast lane ONLY for the qualifying firm.

const SALT = makeRunSalt();

// Fixed fixtures (clerk cases + the inference ledger are append-only for the
// gateway-touched cases, so referenced users/firms/parties must persist —
// the bulk-approve.test posture).
const operatorId = "adf10001-0000-4000-8000-0000000000a1";
const qualFirmId = "adf10002-0000-4000-8000-0000000000a2";
const qualSupplierId = "adf10003-0000-4000-8000-0000000000a3";
const qualBuyerId = "adf10004-0000-4000-8000-0000000000a4";
const plainFirmId = "adf10005-0000-4000-8000-0000000000a5";
const plainSupplierId = "adf10006-0000-4000-8000-0000000000a6";
const plainBuyerId = "adf10007-0000-4000-8000-0000000000a7";

// Deterministic ids for the seeded calibration exhaust: these rows never
// touch the gateway (no ledger references), so each run deletes and reseeds
// them — exactly 20 per firm, freshly dated inside the 30-day window.
const calCaseId = (firm: "q" | "p", i: number): string =>
  `adf1c0${firm === "q" ? "a" : "b"}0-0000-4000-8000-${String(i).padStart(12, "0")}`;
const QUAL_CASE_IDS = Array.from({ length: 20 }, (_, i) => calCaseId("q", i));
const PLAIN_CASE_IDS = Array.from({ length: 20 }, (_, i) => calCaseId("p", i));

const HEADER_FIELDS = [
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "supplierName",
  "supplierTin",
  "buyerName",
  "buyerTin",
  "subtotal",
  "vatTotal",
  "grandTotal",
] as const;

// One approved, corrected case whose 11 header fields all sit in the
// "0.8-1.0" band; `changedFields` of them were overridden at approval.
function calibrationCase(
  id: string,
  firmId: string,
  changedFields: number,
): typeof clerkCasesTable.$inferInsert {
  const extraction: ClerkExtraction = {
    fields: HEADER_FIELDS.map((field) => ({
      field,
      value: "x",
      confidence: 0.9,
      sourceSnippet: null,
      critical: true,
      flagged: true,
    })),
    lines: [],
    promptVersion: "extract.test",
    model: "calibration-seed",
  };
  const corrections: ClerkCorrection[] = HEADER_FIELDS.map((field, i) => ({
    field,
    extracted: "x",
    final: i < changedFields ? "y" : "x",
    changed: i < changedFields,
  }));
  return {
    id,
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    sourceText: `calibration seed ${id}`,
    firmId,
    createdBy: operatorId,
    extraction,
    corrections,
  };
}

// Lagos-safe recent issue date (test-helpers/fixtures' shared helper).
const ISSUE_DATE = lagosDateOffset(-2);

// A clean, internally consistent extraction whose supplierTin sits at 0.85 —
// above the floor, below the default. Names deliberately share no meaningful
// token with the register parties so no identity preflight fires.
function midConfidenceOutput(invoiceNumber: string): ExtractionOutput {
  const base: Record<string, string | null> = {
    invoiceNumber,
    issueDate: ISSUE_DATE,
    currency: "NGN",
    supplierName: `Zenith Quantum Trading ${SALT}`,
    supplierTin: "12345678",
    buyerName: `Harbour Crest Logistics ${SALT}`,
    buyerTin: "87654321",
    subtotal: "1000.00",
    vatTotal: "75.00",
    grandTotal: "1075.00",
  };
  return {
    fields: Object.entries(base).map(([field, value]) => ({
      field: field as ExtractionOutput["fields"][number]["field"],
      value,
      confidence: field === "supplierTin" ? 0.85 : 0.95,
      sourceSnippet: null,
    })),
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
}

function approval(
  invoiceNumber: string,
  firmId: string,
  supplierPartyId: string,
  buyerPartyId: string,
): CaseDecisionInput {
  return {
    action: "approve",
    firmId,
    supplierPartyId,
    buyerPartyId,
    invoiceNumber,
    issueDate: ISSUE_DATE,
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
  };
}

before(async () => {
  await saveAndEnableClerkFlag();
  await ensureClerkFixtures({
    users: [{ id: operatorId, email: "adaptive-fast-lane@test.local" }],
    firmId: qualFirmId,
    firmName: "Adaptive Lane Qualifying Firm",
    supplierId: qualSupplierId,
    supplierName: "Adaptive Lane Register Supplier",
    buyerId: qualBuyerId,
    buyerName: "Adaptive Lane Register Buyer",
    engagementTitle: "adaptive-fast-lane test",
  });
  await ensureClerkFixtures({
    users: [{ id: operatorId, email: "adaptive-fast-lane@test.local" }],
    firmId: plainFirmId,
    firmName: "Adaptive Lane Plain Firm",
    supplierId: plainSupplierId,
    supplierName: "Plain Lane Register Supplier",
    buyerId: plainBuyerId,
    buyerName: "Plain Lane Register Buyer",
    engagementTitle: "adaptive-fast-lane test",
  });

  // Reseed the calibration exhaust: the qualifying firm kept every value
  // (220 fields in band, keptRate 1.0); the plain firm's operators changed 3
  // of 11 per case (keptRate ~0.73 — plenty of sample, nowhere near 0.97).
  const allIds = [...QUAL_CASE_IDS, ...PLAIN_CASE_IDS];
  // A prior ABORTED run can leave these fixed-id cases behind, and the
  // eval-growth sweep (platform-wide) may then have minted eval fixtures
  // from them — those FK rows must go first or this reseed delete fails.
  await getDb()
    .delete(clerkEvalFixturesTable)
    .where(inArray(clerkEvalFixturesTable.caseId, allIds));
  await getDb()
    .delete(clerkCasesTable)
    .where(inArray(clerkCasesTable.id, allIds));
  await getDb()
    .insert(clerkCasesTable)
    .values([
      ...QUAL_CASE_IDS.map((id) => calibrationCase(id, qualFirmId, 0)),
      ...PLAIN_CASE_IDS.map((id) => calibrationCase(id, plainFirmId, 3)),
    ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("firmFastLaneThreshold: floor for the calibrated firm, default otherwise", async () => {
  assert.equal(FAST_LANE_DEFAULT, 0.9);
  assert.equal(FAST_LANE_FLOOR, 0.8);
  assert.equal(await firmFastLaneThreshold(qualFirmId), FAST_LANE_FLOOR);
  assert.equal(await firmFastLaneThreshold(plainFirmId), FAST_LANE_DEFAULT);
  assert.equal(
    await firmFastLaneThreshold(null),
    FAST_LANE_DEFAULT,
    "no firm, no exhaust — never relaxes",
  );
});

test("fastLaneBlocker judges the same case differently under the two thresholds", () => {
  const kase = {
    status: "extracted" as const,
    preflight: [],
    extraction: {
      fields: [
        {
          field: "supplierTin",
          value: "12345678",
          confidence: 0.85,
          sourceSnippet: null,
          critical: true,
          flagged: true,
        },
      ],
      lines: [],
      promptVersion: "t",
      model: "t",
    },
  };
  assert.equal(fastLaneBlocker(kase, FAST_LANE_FLOOR), null);
  assert.match(
    fastLaneBlocker(kase, FAST_LANE_DEFAULT) ?? "",
    /below the fast-lane confidence bar/,
  );
  assert.match(
    fastLaneBlocker(kase) ?? "",
    /below the fast-lane confidence bar/,
    "the default parameter stays the conservative 0.9",
  );
});

test("bulk approval accepts a 0.85-confidence critical field only for the qualifying firm", async () => {
  const qualNum = `ADF-Q-${SALT}`;
  const qualCase = await createExtractionCase(
    { sourceType: "text", text: `Adaptive lane qualifying ${SALT}` },
    operatorId,
    fakeGateway(() => JSON.stringify(midConfidenceOutput(qualNum))),
    undefined,
    { firmId: qualFirmId },
  );
  assert.equal(qualCase.status, "extracted");
  assert.deepEqual(qualCase.preflight, [], "fixture must be preflight-clean");

  const plainNum = `ADF-P-${SALT}`;
  const plainCase = await createExtractionCase(
    { sourceType: "text", text: `Adaptive lane plain ${SALT}` },
    operatorId,
    fakeGateway(() => JSON.stringify(midConfidenceOutput(plainNum))),
    undefined,
    { firmId: plainFirmId },
  );
  assert.equal(plainCase.status, "extracted");
  assert.deepEqual(plainCase.preflight, []);

  const { results } = await bulkApproveCases(
    [
      {
        caseId: qualCase.id,
        decision: approval(qualNum, qualFirmId, qualSupplierId, qualBuyerId),
      },
      {
        caseId: plainCase.id,
        decision: approval(
          plainNum,
          plainFirmId,
          plainSupplierId,
          plainBuyerId,
        ),
      },
    ],
    operatorId,
  );

  assert.equal(results[0].outcome, "approved", "0.85 >= the firm's 0.8 floor");
  assert.equal(results[1].outcome, "skipped");
  assert.match(
    results[1].reason ?? "",
    /critical field 'supplierTin' is below the fast-lane confidence bar/,
    "the same confidence fails the unqualified firm's 0.9 default",
  );
});
