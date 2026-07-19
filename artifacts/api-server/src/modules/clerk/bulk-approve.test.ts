import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { desc, and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  invoicesTable,
  type ClerkCase,
} from "@workspace/db";
import {
  saveAndEnableClerkFlag,
  restoreClerkFlag,
  ensureClerkFixtures,
  fakeGateway,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import type { ExtractionOutput } from "./prompts.ts";
import {
  createExtractionCase,
  decideCase,
  getCase,
  type CaseDecisionInput,
} from "./cases.ts";
import {
  bulkApproveCases,
  fastLaneBlocker,
  FAST_LANE_CONFIDENCE,
} from "./bulk-approve.ts";

// Fast-lane bulk approval. The invariants pinned here:
//  - eligibility is enforced SERVER-SIDE before any decision: only extracted
//    cases with a clean (present, no-blocking-issue) pre-flight and confident
//    critical fields may be bulk-approved — the console's fast-lane predicate
//    is a display hint, never the wall;
//  - each approved item runs the EXISTING decideCase machinery, so approval
//    still stops at a DRAFT invoice;
//  - one bad row (ineligible, already decided, incomplete values) is reported
//    and never aborts the batch;
//  - only approvals may be bulked — reject/escalate stay single-case;
//  - one summary audit event carries the batch counts.

const SALT = makeRunSalt();

// Fixed fixtures (clerk cases + the inference ledger are append-only, so the
// referenced users/firm/parties must persist across runs — same posture as
// clerk.test.ts).
const operatorId = "ba1b0001-0000-4000-8000-0000000000b1";
const firmId = "ba1b0002-0000-4000-8000-0000000000b2";
const supplierId = "ba1b0003-0000-4000-8000-0000000000b3";
const buyerId = "ba1b0004-0000-4000-8000-0000000000b4";

// A recent Lagos-safe issue date (WAT is fixed UTC+1): two days ago is never
// "overdue on arrival" and never future-dated, so the date-sanity advisory
// stays silent and the pre-flight list can be empty.
function lagosDateOffset(days: number): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const ISSUE_DATE = lagosDateOffset(-2);

// A fully clean, fully confident extraction: every critical field present at
// 0.95, internally consistent totals, one valid line — an empty pre-flight
// list and a fast-lane case by construction.
function cleanOutput(
  invoiceNumber: string,
  overrides: Partial<Record<string, { value: string | null; confidence?: number }>> = {},
): ExtractionOutput {
  const base: Record<string, string | null> = {
    invoiceNumber,
    issueDate: ISSUE_DATE,
    currency: "NGN",
    supplierName: `Bulk Approve Supplier ${SALT}`,
    supplierTin: "12345678",
    buyerName: `Bulk Approve Buyer ${SALT}`,
    buyerTin: "87654321",
    subtotal: "1000.00",
    vatTotal: "75.00",
    grandTotal: "1075.00",
  };
  return {
    fields: Object.entries(base).map(([field, value]) => ({
      field: field as ExtractionOutput["fields"][number]["field"],
      value: overrides[field] ? overrides[field].value : value,
      confidence: overrides[field]?.confidence ?? 0.95,
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

async function makeCase(output: ExtractionOutput | (() => never), name: string): Promise<ClerkCase> {
  const gateway = fakeGateway(() =>
    typeof output === "function" ? output() : JSON.stringify(output),
  );
  return createExtractionCase(
    { sourceType: "text", text: `Bulk approve ${name} ${SALT}` },
    operatorId,
    gateway,
  );
}

function approval(invoiceNumber: string): CaseDecisionInput {
  return {
    action: "approve",
    firmId,
    supplierPartyId: supplierId,
    buyerPartyId: buyerId,
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
    users: [{ id: operatorId, email: "bulk-approve-operator@test.local" }],
    firmId,
    firmName: "Bulk Approve Test Firm",
    supplierId,
    supplierName: "Bulk Approve Supplier Co",
    buyerId,
    buyerName: "Bulk Approve Buyer Co",
    engagementTitle: "bulk-approve test",
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("fastLaneBlocker mirrors the console predicate (clerk-shared isReadyToApprove)", () => {
  const clean = {
    status: "extracted" as const,
    preflight: [],
    extraction: {
      fields: [
        {
          field: "invoiceNumber",
          value: "X",
          confidence: FAST_LANE_CONFIDENCE,
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
  assert.equal(fastLaneBlocker(clean), null);
  assert.match(
    fastLaneBlocker({ ...clean, status: "in_review" }) ?? "",
    /status is 'in_review'/,
  );
  assert.match(
    fastLaneBlocker({ ...clean, preflight: null }) ?? "",
    /pre-flight has not run/,
    "a null pre-flight list means it never ran — not the same as clear",
  );
  assert.match(
    fastLaneBlocker({
      ...clean,
      preflight: [{ field: "subtotal", message: "totals do not add up" }],
    }) ?? "",
    /blocking issue/,
  );
  assert.equal(
    fastLaneBlocker({
      ...clean,
      preflight: [
        { field: "supplierTin", message: "confirm", severity: "advisory" },
      ],
    }),
    null,
    "advisory issues do not cost the fast lane",
  );
  const weak = {
    ...clean,
    extraction: {
      ...clean.extraction,
      fields: [
        { ...clean.extraction.fields[0], confidence: 0.89 },
      ],
    },
  };
  assert.match(
    fastLaneBlocker(weak) ?? "",
    /below the fast-lane confidence bar/,
  );
});

test("a fast-lane case bulk-approves and creates a DRAFT invoice only", async () => {
  const num = `BLK-OK-${SALT}`;
  const kase = await makeCase(cleanOutput(num), "ok");
  assert.equal(kase.status, "extracted");
  assert.deepEqual(kase.preflight, [], "the fixture must be fast-lane clean");

  const { results } = await bulkApproveCases(
    [{ caseId: kase.id, decision: approval(num) }],
    operatorId,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "approved");
  assert.equal(results[0].reason, null);

  const decided = await getCase(kase.id);
  assert.equal(decided.status, "approved");
  assert.ok(decided.createdInvoiceId);
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, decided.createdInvoiceId!))
    .limit(1);
  assert.ok(invoice);
  assert.equal(
    invoice.status,
    "draft",
    "bulk approval must stop at a draft, exactly like a single approval",
  );
});

test("a blocking pre-flight issue skips the case with the specific reason", async () => {
  // Missing buyerName: a full (non-advisory) pre-flight issue.
  const num = `BLK-PF-${SALT}`;
  const kase = await makeCase(
    cleanOutput(num, { buyerName: { value: null } }),
    "preflight-blocked",
  );
  assert.equal(kase.status, "extracted");
  assert.ok(
    (kase.preflight ?? []).some((i) => i.severity !== "advisory"),
    "the fixture must carry a blocking issue",
  );

  const { results } = await bulkApproveCases(
    [{ caseId: kase.id, decision: approval(num) }],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.match(results[0].reason ?? "", /pre-flight found a blocking issue/);
  assert.equal((await getCase(kase.id)).status, "extracted", "undecided");
});

test("a low-confidence critical field skips the case", async () => {
  const num = `BLK-CONF-${SALT}`;
  const kase = await makeCase(
    cleanOutput(num, { supplierTin: { value: "12345678", confidence: 0.5 } }),
    "low-confidence",
  );
  assert.equal(kase.status, "extracted");
  assert.deepEqual(kase.preflight, []);

  const { results } = await bulkApproveCases(
    [{ caseId: kase.id, decision: approval(num) }],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.match(
    results[0].reason ?? "",
    /critical field 'supplierTin' is below the fast-lane confidence bar/,
  );
});

test("a non-extracted case skips without aborting the batch", async () => {
  const failed = await makeCase(() => {
    throw new Error("upstream 500");
  }, "provider-error");
  assert.equal(failed.status, "failed");

  const okNum = `BLK-MIX-${SALT}`;
  const ok = await makeCase(cleanOutput(okNum), "mix-ok");

  const { results } = await bulkApproveCases(
    [
      { caseId: failed.id, decision: approval(`BLK-FAIL-${SALT}`) },
      { caseId: ok.id, decision: approval(okNum) },
    ],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.match(results[0].reason ?? "", /status is 'failed'/);
  assert.equal(
    results[1].outcome,
    "approved",
    "one ineligible row must not abort the batch",
  );
});

test("a decided-elsewhere case skips on the state check without failing the batch", async () => {
  const num = `BLK-RACE-${SALT}`;
  const kase = await makeCase(cleanOutput(num), "race");
  // Another operator decides first (the CAS in decideCase is what makes the
  // concurrent version of this safe; here the re-read catches it earlier).
  await decideCase(kase.id, approval(num), operatorId);
  assert.equal((await getCase(kase.id)).status, "approved");

  const okNum = `BLK-RACE-OK-${SALT}`;
  const ok = await makeCase(cleanOutput(okNum), "race-ok");
  const { results } = await bulkApproveCases(
    [
      { caseId: kase.id, decision: approval(num) },
      { caseId: ok.id, decision: approval(okNum) },
    ],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.match(results[0].reason ?? "", /status is 'approved'/);
  assert.equal(results[1].outcome, "approved");
});

test("a domain refusal from decideCase is reported per-row, batch continues", async () => {
  const num = `BLK-INC-${SALT}`;
  const kase = await makeCase(cleanOutput(num), "incomplete");
  // Approval without operator-confirmed lines: DECISION_INCOMPLETE.
  const { results } = await bulkApproveCases(
    [
      {
        caseId: kase.id,
        decision: { ...approval(num), lines: [] },
      },
    ],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.match(results[0].reason ?? "", /operator-confirmed values/);
  assert.equal(
    (await getCase(kase.id)).status,
    "extracted",
    "a refused approval must leave the case undecided",
  );
});

test("reject and escalate actions are refused — only approvals may be bulked", async () => {
  const num = `BLK-REJ-${SALT}`;
  const kase = await makeCase(cleanOutput(num), "reject");
  const { results } = await bulkApproveCases(
    [
      { caseId: kase.id, decision: { action: "reject", reason: "no" } },
      { caseId: kase.id, decision: { action: "escalate", reason: "up" } },
    ],
    operatorId,
  );
  assert.equal(results[0].outcome, "skipped");
  assert.equal(results[0].reason, "only approvals may be bulked");
  assert.equal(results[1].outcome, "skipped");
  assert.equal(results[1].reason, "only approvals may be bulked");
  assert.equal(
    (await getCase(kase.id)).status,
    "extracted",
    "no decision may be applied through the bulk path for non-approvals",
  );
});

test("the summary audit event carries the batch counts", async () => {
  const okNum = `BLK-AUD-${SALT}`;
  const ok = await makeCase(cleanOutput(okNum), "audit-ok");
  const blocked = await makeCase(
    cleanOutput(`BLK-AUD-PF-${SALT}`, { buyerName: { value: null } }),
    "audit-blocked",
  );

  await bulkApproveCases(
    [
      { caseId: ok.id, decision: approval(okNum) },
      { caseId: blocked.id, decision: approval(`BLK-AUD-PF-${SALT}`) },
      { caseId: blocked.id, decision: { action: "reject" } },
    ],
    operatorId,
  );

  const [event] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "clerk.bulk.approve"),
        eq(auditEventsTable.entityId, ok.id),
      ),
    )
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  assert.ok(event, "one summary event per batch");
  assert.deepEqual(event.after, { requested: 3, approved: 1, skipped: 2 });
});
