import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  type ClerkExtraction,
  type ExtractionLine,
} from "@workspace/db";
import { preflightChecks } from "./preflight.ts";
import { createExtractionCase } from "./cases.ts";
import { createBatchCases } from "./batch.ts";
import {
  buildTemplateDigest,
  computeDigestFacts,
  digestWeekStart,
  generateFirmDigest,
  latestDigestForFirm,
  vatReturnInDays,
} from "./digest.ts";
import { draftClaimWithClerk } from "./draft-claim.ts";
import { createDraft } from "../invoice/service.ts";
import {
  fakeGateway,
  saveAndEnableClerkFlag,
  restoreClerkFlag,
  ensureClerkFixtures,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Clerk power pack (R/S/D/C5): deterministic pre-flight checks, batch
// multi-invoice intake, the weekly firm digest, and the claims drafting
// assistant.

const SALT = makeRunSalt();
const userId = randomUUID();
const firmId = randomUUID();
const digestFirmId = randomUUID();
const clerkDigestFirmId = randomUUID();
const supplierId = randomUUID();
const buyerId = randomUUID();
const digestVendorId = randomUUID();

before(async () => {
  await saveAndEnableClerkFlag();
  await ensureClerkFixtures({
    users: [{ id: userId, email: `clerk-power-${SALT}@test.local` }],
    firmId,
    firmName: `Power Firm ${SALT}`,
    supplierId,
    supplierName: `Power Supplier ${SALT}`,
    buyerId,
    buyerName: `Power Buyer ${SALT}`,
    engagementTitle: `Power engagement ${SALT}`,
  });
  await getDb().insert(firmsTable).values([
    { id: digestFirmId, name: `Digest Firm ${SALT}` },
    { id: clerkDigestFirmId, name: `Clerk Digest Firm ${SALT}` },
  ]);
  // The digest facts are RECEIVABLE-oriented (payables round): the counted
  // supplier must be an engaged client of the digest firm, or every count
  // below reads zero.
  await getDb().insert(engagementsTable).values({
    firmId: digestFirmId,
    clientPartyId: supplierId,
    type: "readiness_assessment",
    title: `Digest engagement ${SALT}`,
  });
  // A captured supplier BILL in the digest firm (the engaged client is the
  // BUYER): draft forever, so it must NOT pollute the unsubmitted counters —
  // it surfaces only through the payables fact (due within 7 days).
  await getDb().insert(partiesTable).values({
    id: digestVendorId,
    type: "buyer",
    legalName: `Digest Vendor ${SALT}`,
  });
  const billDue = new Date();
  billDue.setUTCDate(billDue.getUTCDate() + 3);
  await getDb().insert(invoicesTable).values({
    firmId: digestFirmId,
    supplierPartyId: digestVendorId,
    buyerPartyId: supplierId,
    invoiceNumber: `DIG-BILL-${SALT}`,
    status: "draft",
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: billDue.toISOString().slice(0, 10),
    grandTotal: "500.00",
  });
});

after(async () => {
  await restoreClerkFlag();
});

// ---------------------------------------------------------------------------
// R — pre-flight checks (pure)
// ---------------------------------------------------------------------------

const CLEAN_LINE: ExtractionLine = {
  description: "Consulting services",
  quantity: "2",
  unitPrice: "500.00",
  vatRate: "7.5",
  confidence: 0.9,
};

function extractionWith(
  values: Record<string, string | null>,
  lines: ExtractionLine[],
): ClerkExtraction {
  return {
    fields: Object.entries(values).map(([field, value]) => ({
      field,
      value,
      confidence: value === null ? 0 : 0.95,
      sourceSnippet: null,
      critical: true,
      flagged: true,
    })),
    lines,
    promptVersion: "extract.v1",
    model: "fake-model-test",
  };
}

// Dates are RELATIVE so the clean fixture stays genuinely clean: a hardcoded
// issue date drifts stale and eventually trips the register-preflight
// overdue-on-arrival advisory (history-based anomaly flags, idea #1).
const daysFromNow = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const CLEAN_VALUES: Record<string, string | null> = {
  invoiceNumber: "INV-100",
  issueDate: daysFromNow(-1),
  dueDate: daysFromNow(13),
  currency: "NGN",
  buyerName: "Northstar Ltd",
  subtotal: "1000.00",
  vatTotal: "75.00",
  grandTotal: "1075.00",
};

test("preflightChecks passes a clean extraction", () => {
  const issues = preflightChecks(extractionWith(CLEAN_VALUES, [CLEAN_LINE]));
  assert.deepEqual(issues, []);
});

test("preflightChecks flags missing and malformed header fields", () => {
  const issues = preflightChecks(
    extractionWith(
      {
        ...CLEAN_VALUES,
        invoiceNumber: null,
        issueDate: "01/07/2026",
        dueDate: "2026-02-31",
        currency: "NAIRA",
        buyerName: "  ",
      },
      [CLEAN_LINE],
    ),
  );
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("invoiceNumber"), "missing invoice number");
  assert.ok(fields.includes("issueDate"), "non-ISO issue date");
  assert.ok(fields.includes("dueDate"), "impossible due date");
  assert.ok(fields.includes("currency"), "non-ISO currency");
  assert.ok(fields.includes("buyerName"), "blank buyer name");
});

test("preflightChecks flags a due date before the issue date", () => {
  const issues = preflightChecks(
    extractionWith({ ...CLEAN_VALUES, dueDate: daysFromNow(-2) }, [CLEAN_LINE]),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "dueDate");
  assert.match(issues[0].message, /before the issue date/);
});

test("preflightChecks flags line problems and accepts both VAT dialects", () => {
  const issues = preflightChecks(
    extractionWith(CLEAN_VALUES, [
      // Fraction dialect is as valid as the percent dialect on the clean line.
      { ...CLEAN_LINE, vatRate: "0.075" },
      { ...CLEAN_LINE, description: null, quantity: "0", vatRate: "750" },
    ]),
  );
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("lines.1.description"));
  assert.ok(fields.includes("lines.1.quantity"));
  assert.ok(fields.includes("lines.1.vatRate"));
  assert.ok(!fields.some((f) => f.startsWith("lines.0.")), "clean line passes");
});

test("preflightChecks flags totals that don't add up", () => {
  const issues = preflightChecks(
    extractionWith(
      { ...CLEAN_VALUES, subtotal: "900.00", grandTotal: "2000.00" },
      [CLEAN_LINE],
    ),
  );
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("subtotal"), "subtotal vs line sum");
  assert.ok(fields.includes("grandTotal"), "grand total vs subtotal + VAT");
  assert.ok(!fields.includes("vatTotal"), "VAT total matches the lines");
});

test("preflightChecks requires at least one line", () => {
  const issues = preflightChecks(extractionWith(CLEAN_VALUES, []));
  assert.deepEqual(
    issues.map((i) => i.field),
    ["lines"],
  );
});

// ---------------------------------------------------------------------------
// R — pre-flight is computed and stored on extraction
// ---------------------------------------------------------------------------

function extractionJson(values: Record<string, string | null>): string {
  return JSON.stringify({
    fields: Object.entries(values).map(([field, value]) => ({
      field,
      value,
      confidence: 0.95,
      sourceSnippet: null,
    })),
    lines: [
      {
        description: "Consulting services",
        quantity: "2",
        unitPrice: "500.00",
        vatRate: "7.5",
        confidence: 0.9,
      },
    ],
  });
}

test("a successful extraction stores its pre-flight verdict on the case", async () => {
  const clean = await createExtractionCase(
    {
      sourceType: "text",
      name: `preflight-clean-${SALT}.txt`,
      text: `INVOICE PF-CLEAN-${SALT}`,
    },
    userId,
    fakeGateway(() => extractionJson(CLEAN_VALUES)),
    undefined,
    { firmId },
  );
  assert.equal(clean.status, "extracted");
  assert.deepEqual(clean.preflight, [], "clean case is fast-lane ready");

  const dirty = await createExtractionCase(
    {
      sourceType: "text",
      name: `preflight-dirty-${SALT}.txt`,
      text: `INVOICE PF-DIRTY-${SALT}`,
    },
    userId,
    fakeGateway(() =>
      extractionJson({ ...CLEAN_VALUES, invoiceNumber: null }),
    ),
    undefined,
    { firmId },
  );
  assert.equal(dirty.status, "extracted");
  assert.ok(dirty.preflight);
  assert.equal(dirty.preflight.length, 1);
  assert.equal(dirty.preflight[0].field, "invoiceNumber");
});

// ---------------------------------------------------------------------------
// S — batch intake
// ---------------------------------------------------------------------------

function batchGateway() {
  return fakeGateway((req) => {
    if (req.schemaName === "invoice_segmentation") {
      return JSON.stringify({
        invoices: [
          { text: `INVOICE BATCH-A-${SALT} total 100`, label: `BATCH-A-${SALT}` },
          { text: `INVOICE BATCH-B-${SALT} total 200`, label: null },
        ],
      });
    }
    return extractionJson(CLEAN_VALUES);
  });
}

test("createBatchCases opens one case per segmented invoice", async () => {
  const result = await createBatchCases(
    {
      sourceType: "text",
      name: `July bundle ${SALT}`,
      text: `INVOICE BATCH-A-${SALT} ... INVOICE BATCH-B-${SALT} ...`,
    },
    userId,
    batchGateway(),
    { firmId },
  );
  assert.equal(result.segments, 2);
  assert.equal(result.skippedDuplicates, 0);
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].sourceName, `BATCH-A-${SALT}`);
  assert.equal(result.cases[1].sourceName, `July bundle ${SALT} (2/2)`);
  for (const kase of result.cases) {
    assert.equal(kase.status, "extracted");
    assert.equal(kase.firmId, firmId, "batch cases carry the firm");
    assert.ok(kase.preflight, "batch cases go through pre-flight too");
  }
});

test("createBatchCases counts duplicates instead of failing the batch", async () => {
  // Same segments as the previous test: both already have live cases.
  const rerun = await createBatchCases(
    {
      sourceType: "text",
      name: `July bundle rerun ${SALT}`,
      text: `INVOICE BATCH-A-${SALT} ... INVOICE BATCH-B-${SALT} ... (rerun)`,
    },
    userId,
    batchGateway(),
    { firmId },
  );
  assert.equal(rerun.segments, 2);
  assert.equal(rerun.cases.length, 0);
  assert.equal(rerun.skippedDuplicates, 2);
});

test("createBatchCases fails closed when segmentation output is discarded", async () => {
  await assert.rejects(
    createBatchCases(
      { sourceType: "text", text: `INVOICE SEGFAIL-${SALT}` },
      userId,
      fakeGateway(() => "this is not json"),
      { firmId },
    ),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "BATCH_SEGMENTATION_FAILED" && err.status === 502,
  );
});

// ---------------------------------------------------------------------------
// D — weekly digest
// ---------------------------------------------------------------------------

test("buildTemplateDigest phrases the facts deterministically", () => {
  const quiet = buildTemplateDigest({
    unsubmittedCount: 0,
    dueSoonCount: 0,
    overdueCount: 0,
    failedCount: 0,
    receivablesOver60Count: 0,
    unbilledCount: 0,
    unbilledClients: 0,
    expectedWeekCount: 0,
    expectedWeekTotalNgn: "0.00",
    chaseWorthyCount: 0,
    unmatchedCreditCount: 0,
    unmatchedCreditClients: 0,
    chasedTwiceCount: 0,
    payablesDueCount: 0,
    vatReturnInDays: null,
    approvalsPendingCount: null,
    approvalsPendingOldestDays: null,
    unmatchedCollectionsCount: 0,
    penaltyExposureFloorNgn: null,
    missingBillsCount: 0,
    missingBillsClients: 0,
  });
  assert.match(quiet.headline, /on track/);
  assert.equal(quiet.bullets.length, 1);

  const busy = buildTemplateDigest({
    unsubmittedCount: 3,
    dueSoonCount: 1,
    overdueCount: 2,
    failedCount: 1,
    receivablesOver60Count: 4,
    unbilledCount: 2,
    unbilledClients: 1,
    expectedWeekCount: 2,
    expectedWeekTotalNgn: "150000.00",
    chaseWorthyCount: 1,
    unmatchedCreditCount: 2,
    unmatchedCreditClients: 1,
    chasedTwiceCount: 1,
    payablesDueCount: 2,
    vatReturnInDays: 3,
    approvalsPendingCount: 2,
    approvalsPendingOldestDays: 4,
    unmatchedCollectionsCount: 1,
    penaltyExposureFloorNgn: "50000",
    missingBillsCount: 2,
    missingBillsClients: 1,
  });
  assert.equal(busy.headline, "3 invoices need attention this week.");
  assert.equal(busy.bullets.length, 16);
  assert.match(busy.bullets[0], /2 invoices are past the 7-day submission window/);
  assert.match(busy.bullets[5], /2 regular invoices look unraised across 1 client/);
  assert.match(
    busy.bullets[6],
    /2 invoices \(NGN 150000\.00\) are expected to be paid in the coming week/,
  );
  assert.match(busy.bullets[7], /1 receivable looks worth chasing/);
  assert.match(
    busy.bullets[8],
    /2 bank credits across 1 client match no invoice on the platform/,
  );
  assert.match(
    busy.bullets[9],
    /1 invoice has taken 2 or more payment reminders and is still unpaid/,
  );
  assert.match(
    busy.bullets[10],
    /2 supplier bills are due within the next 7 days or already overdue/,
  );
  assert.match(
    busy.bullets[11],
    /Monthly VAT return due in 3 days — VAT returns fall due on the 21st/,
  );
  assert.match(
    busy.bullets[12],
    /2 invoices are waiting for a colleague's approval before submission — the oldest has waited 4 days/,
  );
  assert.match(
    busy.bullets[13],
    /1 payment arrived on your collection accounts this week that matched no invoice/,
  );
  assert.match(
    busy.bullets[14],
    /at least NGN 50000 of s\.104 penalty exposure/,
  );
  assert.match(
    busy.bullets[15],
    /2 regular vendor bills look uncaptured this cycle across 1 client/,
  );

  // Deadline day itself reads "today"; a null countdown adds no bullet (the
  // quiet case above already pins that).
  const dueToday = buildTemplateDigest({
    unsubmittedCount: 0,
    dueSoonCount: 0,
    overdueCount: 0,
    failedCount: 0,
    receivablesOver60Count: 0,
    unbilledCount: 0,
    unbilledClients: 0,
    expectedWeekCount: 0,
    expectedWeekTotalNgn: "0.00",
    chaseWorthyCount: 0,
    unmatchedCreditCount: 0,
    unmatchedCreditClients: 0,
    chasedTwiceCount: 0,
    payablesDueCount: 0,
    vatReturnInDays: 0,
    approvalsPendingCount: 0,
    approvalsPendingOldestDays: null,
    unmatchedCollectionsCount: 0,
    penaltyExposureFloorNgn: null,
    missingBillsCount: 0,
    missingBillsClients: 0,
  });
  assert.equal(dueToday.bullets.length, 1);
  assert.match(dueToday.bullets[0], /Monthly VAT return due today/);
});

test("vatReturnInDays counts to the Lagos 21st and goes quiet beyond a week", () => {
  // 5 July: 16 days out — quiet.
  assert.equal(vatReturnInDays(new Date("2026-07-05T12:00:00Z")), null);
  // 14 July: exactly 7 days out — the first day it speaks.
  assert.equal(vatReturnInDays(new Date("2026-07-14T12:00:00Z")), 7);
  // 20 July 23:30 UTC is ALREADY 21 July in Lagos (WAT +01:00): due today.
  assert.equal(vatReturnInDays(new Date("2026-07-20T23:30:00Z")), 0);
  assert.equal(vatReturnInDays(new Date("2026-07-21T12:00:00Z")), 0);
  // Past the 21st the clock re-arms on NEXT month's 21st — 30 days out, quiet.
  assert.equal(vatReturnInDays(new Date("2026-07-22T12:00:00Z")), null);
  // Year rollover: 15 December -> 21 December is 6 days out.
  assert.equal(vatReturnInDays(new Date("2026-12-15T12:00:00Z")), 6);
  assert.equal(vatReturnInDays(new Date("2026-12-31T12:00:00Z")), null);
});

test("digestWeekStart anchors to Monday 00:00 UTC", () => {
  // 2026-07-14 is a Tuesday; its week starts Monday 2026-07-13.
  const ws = digestWeekStart(new Date("2026-07-14T15:30:00Z"));
  assert.equal(ws.toISOString(), "2026-07-13T00:00:00.000Z");
  // A Monday maps to itself; a Sunday maps back six days.
  assert.equal(
    digestWeekStart(new Date("2026-07-13T00:00:00Z")).toISOString(),
    "2026-07-13T00:00:00.000Z",
  );
  assert.equal(
    digestWeekStart(new Date("2026-07-19T23:59:00Z")).toISOString(),
    "2026-07-13T00:00:00.000Z",
  );
});

test("computeDigestFacts counts from the firm's invoices via SQL", async () => {
  const past = new Date();
  past.setUTCDate(past.getUTCDate() - 30);
  await createDraft(
    {
      firmId: digestFirmId,
      supplierPartyId: supplierId,
      buyerPartyId: buyerId,
      invoiceNumber: `DIG-OVERDUE-${SALT}`,
      issueDate: past.toISOString().slice(0, 10),
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  // Issued 3 days ago: its submission deadline (issue + 7) lands 4 days from
  // now — inside the digest's "next 7 days" window, not yet overdue.
  const recent = new Date();
  recent.setUTCDate(recent.getUTCDate() - 3);
  await createDraft(
    {
      firmId: digestFirmId,
      supplierPartyId: supplierId,
      buyerPartyId: buyerId,
      invoiceNumber: `DIG-DUESOON-${SALT}`,
      issueDate: recent.toISOString().slice(0, 10),
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "500", vatRate: "0.075" },
      ],
    },
    userId,
  );
  const facts = await computeDigestFacts(digestFirmId);
  assert.equal(
    facts.unsubmittedCount,
    2,
    "the captured supplier bill (draft forever) must not pollute unsubmitted",
  );
  assert.equal(facts.overdueCount, 1);
  assert.equal(facts.dueSoonCount, 1);
  assert.equal(facts.failedCount, 0);
  assert.equal(facts.receivablesOver60Count, 0);
  assert.equal(
    facts.payablesDueCount,
    1,
    "the unpaid bill due in 3 days is the payables fact",
  );
  // The VAT-return countdown rides along as a pure Lagos-calendar fact —
  // same clock as the exported helper, no SQL involved.
  assert.equal(facts.vatReturnInDays, vatReturnInDays());
});

test("generateFirmDigest without a gateway stores the template narrative once", async () => {
  const first = await generateFirmDigest(digestFirmId, null);
  assert.equal(first.source, "template");
  assert.equal(first.headline, "1 invoice needs attention this week.");
  assert.equal(first.weekStart.toISOString(), digestWeekStart().toISOString());

  // Idempotent per (firm, week): a second pass returns the same row.
  const second = await generateFirmDigest(digestFirmId, null);
  assert.equal(second.id, first.id);

  const latest = await latestDigestForFirm(digestFirmId);
  assert.equal(latest?.id, first.id);
});

test("generateFirmDigest uses Clerk phrasing when the gateway delivers", async () => {
  const digest = await generateFirmDigest(
    clerkDigestFirmId,
    fakeGateway(() =>
      JSON.stringify({
        headline: "A quiet week — nothing needs attention.",
        bullets: ["No unsubmitted invoices and no failures."],
      }),
    ),
  );
  assert.equal(digest.source, "clerk");
  assert.equal(digest.headline, "A quiet week — nothing needs attention.");
});

test("generateFirmDigest falls back to the template on invalid model output", async () => {
  // Fresh firm so no digest exists yet for this week.
  const fallbackFirmId = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: fallbackFirmId, name: `Fallback Firm ${SALT}` });
  const digest = await generateFirmDigest(
    fallbackFirmId,
    fakeGateway(() => "garbage, not json"),
  );
  assert.equal(digest.source, "template");
  assert.match(digest.headline, /on track/);
});

// ---------------------------------------------------------------------------
// C5 — claims drafting assistant
// ---------------------------------------------------------------------------

const DRAFT_KEY = `test.power_${SALT.toLowerCase()}`;

test("draftClaimWithClerk structures a source excerpt into a DRAFT claim", async () => {
  const row = await draftClaimWithClerk(
    `Section 4 of the VAT Act prescribes a standard rate of 7.5% for taxable supplies, effective 1 February 2020. (${SALT})`,
    userId,
    fakeGateway(() =>
      JSON.stringify({
        claimKey: DRAFT_KEY,
        title: "Standard VAT rate is 7.5%",
        proposition:
          "The standard VAT rate for taxable supplies is 7.5 per cent.",
        protectedFacts: [
          {
            key: "standard_rate",
            label: "Standard VAT rate",
            kind: "rate",
            value: "7.5",
            unit: "%",
          },
        ],
        citation: "VAT Act s.4 (Finance Act 2019 amendment)",
        category: "b2b",
        effectiveFrom: "2020-02-01",
        effectiveTo: null,
      }),
    ),
  );
  assert.equal(row.state, "draft");
  assert.equal(row.claimKey, DRAFT_KEY);
  assert.equal(row.version, 1);
  assert.equal(row.effectiveFrom, "2020-02-01");
  assert.equal(row.protectedFacts.length, 1);
  assert.equal(row.protectedFacts[0].unit, "%");
  assert.deepEqual(row.applicability, { category: "b2b" });
  assert.equal(row.createdBy, userId, "the drafting operator is the maker");
});

test("draftClaimWithClerk defaults a missing effective date to today", async () => {
  const row = await draftClaimWithClerk(
    `E-invoices must be submitted for stamping within 7 days of issue. (${SALT})`,
    userId,
    fakeGateway(() =>
      JSON.stringify({
        claimKey: `${DRAFT_KEY}.window`,
        title: "Submission window is 7 days",
        proposition: "Invoices must be submitted within 7 days of issue.",
        protectedFacts: [
          {
            key: "window_days",
            label: "Submission window",
            kind: "duration",
            value: "7",
            unit: "days",
          },
        ],
        citation: "E-invoicing guidelines para 12",
        category: null,
        effectiveFrom: null,
        effectiveTo: null,
      }),
    ),
  );
  assert.equal(row.effectiveFrom, new Date().toISOString().slice(0, 10));
  assert.deepEqual(row.applicability, {});
});

test("draftClaimWithClerk fails closed on discarded model output", async () => {
  await assert.rejects(
    draftClaimWithClerk(
      `Some statute text ${SALT}`,
      userId,
      fakeGateway(() => JSON.stringify({ claimKey: "UPPER CASE BAD" })),
    ),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_DRAFT_FAILED" && err.status === 502,
  );
});
