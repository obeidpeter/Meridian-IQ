import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  firmsTable,
  obligationsTable,
  partiesTable,
  type ClerkCase,
  type ClerkNoticeExtraction,
} from "@workspace/db";
import {
  saveAndEnableClerkFlag,
  restoreClerkFlag,
  ensureClerkFixtures,
  fakeGateway,
} from "./test-support.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import {
  claimCase,
  createExtractionCase,
  decideCase,
  decideNoticeCase,
  getCase,
  retryExtraction,
  type NoticeDecisionInput,
} from "./cases.ts";
import { fastLaneBlocker } from "./bulk-approve.ts";
import { sweepStuckPendingCases } from "./watchdog.ts";
import { sha256 } from "./gateway.ts";
import {
  EXTRACT_NOTICE_PROMPT_VERSION,
  NOTICE_CRITICAL_FIELDS,
  NOTICE_FIELDS,
  noticePreflightChecks,
  type NoticeExtractionOutput,
  type NoticeField,
} from "./notice-prompts.ts";

// Notice Desk — the notice extraction lane. The invariants pinned here:
//  - documentKind "notice" runs the SAME capture rails (dedup, fail-closed
//    gateway, retry) into a kind "notice" case with its own proposal column
//    and the "extract_notice" ledger purpose;
//  - the proposal is candidate values only: approval (decideNoticeCase)
//    creates an OPEN OBLIGATION — never an invoice — and the
//    obligations.sourceCaseId unique index makes double-approve race-safe;
//  - notices NEVER fast-lane and voice sources are refused (a read-aloud
//    notice has no authoritative text);
//  - the stuck-pending watchdog covers the notice lane too.

const SALT = makeRunSalt();

// Fixed fixtures (clerk cases + the inference ledger are append-only, so the
// referenced users/firms/parties must persist across runs — same posture as
// the sibling clerk test files).
const operatorId = "0b119a01-0000-4000-8000-0000000000a1";
const operator2Id = "0b119a02-0000-4000-8000-0000000000a2";
const firmId = "0b119a03-0000-4000-8000-0000000000b1";
const clientId = "0b119a04-0000-4000-8000-0000000000c1";
const buyerId = "0b119a05-0000-4000-8000-0000000000c2";
const otherFirmId = "0b119a06-0000-4000-8000-0000000000b2";
// A party linked to NOTHING in the firm (no engagement/invoice/provenance).
const strangerPartyId = "0b119a07-0000-4000-8000-0000000000c3";

const ISSUE_DATE = lagosDateOffset(-5);
const DUE_DATE = lagosDateOffset(21);

// A fully clean, fully confident notice reading: every critical field present
// at 0.95 and internally consistent dates — an empty pre-flight list by
// construction.
function noticeOutput(
  overrides: Partial<
    Record<NoticeField, { value: string | null; confidence?: number }>
  > = {},
  noticeType: NoticeExtractionOutput["noticeType"] = "assessment",
): NoticeExtractionOutput {
  const base: Record<NoticeField, string | null> = {
    referenceNumber: `FIRS/ASMT/${SALT}`,
    authority: "Federal Inland Revenue Service",
    taxType: "VAT",
    period: "Jan-Mar 2026",
    amountDemanded: "500000.00",
    currency: "NGN",
    issueDate: ISSUE_DATE,
    responseDueDate: DUE_DATE,
  };
  return {
    noticeType,
    fields: NOTICE_FIELDS.map((field) => ({
      field,
      value: overrides[field] ? overrides[field].value : base[field],
      confidence: overrides[field]?.confidence ?? 0.95,
      sourceSnippet: null,
    })),
  };
}

async function makeNoticeCase(
  name: string,
  output: NoticeExtractionOutput | string | (() => never) = noticeOutput(),
): Promise<ClerkCase> {
  const gateway = fakeGateway(() =>
    typeof output === "function"
      ? output()
      : typeof output === "string"
        ? output
        : JSON.stringify(output),
  );
  return createExtractionCase(
    { sourceType: "text", text: `Notice ${name} ${SALT}`, documentKind: "notice" },
    operatorId,
    gateway,
  );
}

function approval(
  overrides: Partial<NoticeDecisionInput> = {},
): NoticeDecisionInput {
  return {
    action: "approve",
    firmId,
    clientPartyId: clientId,
    noticeType: "assessment",
    authority: "firs",
    reference: `FIRS/ASMT/${SALT}`,
    taxType: "vat",
    period: "Jan-Mar 2026",
    // Deliberately differs from the extracted 500000.00 so the corrections
    // diff records a changed field on every happy-path approval.
    amount: "450000.00",
    currency: "NGN",
    issueDate: ISSUE_DATE,
    responseDueDate: DUE_DATE,
    notes: "Objection being prepared",
    ...overrides,
  };
}

// Build a ClerkNoticeExtraction directly for the pure pre-flight unit tests.
function nx(values: Partial<Record<NoticeField, string | null>>): ClerkNoticeExtraction {
  const base: Record<NoticeField, string | null> = {
    referenceNumber: "FIRS/REF/1",
    authority: "FIRS",
    taxType: "VAT",
    period: "2026 Q1",
    amountDemanded: "1000.00",
    currency: "NGN",
    issueDate: ISSUE_DATE,
    responseDueDate: DUE_DATE,
  };
  return {
    fields: NOTICE_FIELDS.map((field) => ({
      field,
      value: field in values ? (values[field] ?? null) : base[field],
      confidence: 0.9,
      sourceSnippet: null,
      critical: NOTICE_CRITICAL_FIELDS.has(field),
      flagged: false,
    })),
    noticeType: "assessment",
    promptVersion: "t",
    model: "t",
  };
}

async function obligationsForCase(caseId: string) {
  return getDb()
    .select()
    .from(obligationsTable)
    .where(eq(obligationsTable.sourceCaseId, caseId));
}

before(async () => {
  await saveAndEnableClerkFlag();
  await ensureClerkFixtures({
    users: [
      { id: operatorId, email: "notice-operator@test.local" },
      { id: operator2Id, email: "notice-operator-2@test.local" },
    ],
    firmId,
    firmName: "Notice Desk Test Firm",
    supplierId: clientId,
    supplierName: "Notice Desk Client Co",
    buyerId,
    buyerName: "Notice Desk Buyer Co",
    engagementTitle: "notice-desk test",
  });
  await getDb()
    .insert(firmsTable)
    .values({ id: otherFirmId, name: "Notice Desk Other Firm" })
    .onConflictDoNothing();
  await getDb()
    .insert(partiesTable)
    .values({
      id: strangerPartyId,
      type: "buyer",
      legalName: "Notice Desk Stranger Co",
    })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("notice capture creates a kind-notice case: normalized proposal, clean preflight, extract_notice ledger purpose", async () => {
  const kase = await makeNoticeCase("clean-capture");
  assert.equal(kase.kind, "notice");
  assert.equal(kase.status, "extracted");
  assert.equal(kase.extraction, null, "the invoice proposal column stays empty");
  assert.deepEqual(kase.preflight, [], "a clean reading has no pre-flight issues");

  const ne = kase.noticeExtraction;
  assert.ok(ne, "the notice proposal is stored");
  assert.equal(ne.noticeType, "assessment");
  assert.equal(ne.promptVersion, EXTRACT_NOTICE_PROMPT_VERSION);
  assert.equal(ne.model, "fake-model-test");
  assert.deepEqual(
    ne.fields.map((f) => f.field),
    [...NOTICE_FIELDS],
    "exactly one candidate per canonical field, in catalogue order",
  );
  for (const f of ne.fields) {
    assert.equal(
      f.critical,
      NOTICE_CRITICAL_FIELDS.has(f.field as NoticeField),
      `critical marking for ${f.field}`,
    );
    assert.equal(
      f.flagged,
      false,
      `a confident, present field is not flagged (${f.field}) — notices have no fast lane to guard`,
    );
  }

  const calls = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.caseId, kase.id));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "extract_notice");
  assert.equal(calls[0].promptVersion, EXTRACT_NOTICE_PROMPT_VERSION);
  assert.equal(calls[0].outcome, "ok");
});

test("a weak or missing CRITICAL field is flagged; non-critical gaps are not", async () => {
  const kase = await makeNoticeCase(
    "flagging",
    noticeOutput({
      authority: { value: "FIRS", confidence: 0.4 },
      referenceNumber: { value: null },
      taxType: { value: null },
    }),
  );
  const byField = new Map(kase.noticeExtraction!.fields.map((f) => [f.field, f]));
  assert.equal(byField.get("authority")!.flagged, true, "low-confidence critical");
  assert.equal(byField.get("referenceNumber")!.flagged, true, "missing critical");
  assert.equal(
    byField.get("taxType")!.flagged,
    false,
    "a missing NON-critical field needs no flag — the reviewer sees every notice anyway",
  );
  assert.equal(byField.get("responseDueDate")!.flagged, false);
  // The missing reference number is also a blocking pre-flight issue.
  assert.ok(
    (kase.preflight ?? []).some(
      (i) => i.field === "referenceNumber" && i.severity !== "advisory",
    ),
  );
});

test("fail-closed: invalid output escalates (discarded), provider error fails", async () => {
  const notJson = await makeNoticeCase("invalid-json", "this is not json");
  assert.equal(notJson.status, "escalated");
  assert.ok(notJson.failReason);
  assert.equal(notJson.noticeExtraction, null, "discarded output is never stored");

  const badSchema = await makeNoticeCase(
    "bad-schema",
    JSON.stringify({ noticeType: "love_letter", fields: [] }),
  );
  assert.equal(badSchema.status, "escalated", "a type outside the closed catalogue is discarded");

  const errored = await makeNoticeCase("provider-error", () => {
    throw new Error("upstream 500");
  });
  assert.equal(errored.status, "failed");
  assert.ok(errored.failReason);
});

test("voice notices are refused before any transcription or model call", async () => {
  let providerCalled = false;
  const gateway = fakeGateway(() => {
    providerCalled = true;
    return "{}";
  });
  let transcriberCalled = false;
  await assert.rejects(
    createExtractionCase(
      {
        sourceType: "voice",
        documentKind: "notice",
        audioBase64: Buffer.from("audio bytes").toString("base64"),
      },
      operatorId,
      gateway,
      async () => {
        transcriberCalled = true;
        return "read-aloud notice";
      },
    ),
    isDomainError("NOTICE_SOURCE_UNSUPPORTED", 400),
  );
  assert.equal(transcriberCalled, false, "no transcription tokens are spent");
  assert.equal(providerCalled, false, "no extraction call is made");
});

test("the duplicate guard is kind-agnostic: the same content as invoice then notice 409s", async () => {
  const text = `Notice dedup ${SALT}`;
  // Captured first as an INVOICE; invalid output leaves it escalated — a
  // LIVE case for the duplicate probe.
  const asInvoice = await createExtractionCase(
    { sourceType: "text", text },
    operatorId,
    fakeGateway(() => "not json"),
  );
  assert.equal(asInvoice.kind, "extraction");
  assert.equal(asInvoice.status, "escalated");

  await assert.rejects(
    createExtractionCase(
      { sourceType: "text", text, documentKind: "notice" },
      operatorId,
      fakeGateway(() => JSON.stringify(noticeOutput())),
    ),
    isDomainError("DUPLICATE_SOURCE", 409),
  );
});

test("noticePreflightChecks: missing criticals, past due (advisory), date order, bad amount", () => {
  assert.deepEqual(noticePreflightChecks(nx({})), [], "clean reading, no issues");

  const missing = noticePreflightChecks(nx({ referenceNumber: null }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].field, "referenceNumber");
  assert.equal(missing[0].severity, undefined, "missing critical is blocking");

  const blank = noticePreflightChecks(nx({ authority: "   " }));
  assert.ok(
    blank.some((i) => i.field === "authority"),
    "whitespace-only counts as missing",
  );

  const past = noticePreflightChecks(nx({ responseDueDate: lagosDateOffset(-3) }));
  assert.equal(past.length, 1);
  assert.equal(past[0].field, "responseDueDate");
  assert.equal(
    past[0].severity,
    "advisory",
    "overdue on arrival must inform the reviewer, not block the case",
  );
  assert.match(past[0].message, /overdue on arrival/);

  const malformed = noticePreflightChecks(nx({ responseDueDate: "next week" }));
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].field, "responseDueDate");
  assert.equal(malformed[0].severity, undefined, "malformed due date is blocking");

  const impossible = noticePreflightChecks(nx({ responseDueDate: "2026-02-31" }));
  assert.ok(
    impossible.some((i) => i.field === "responseDueDate" && !i.severity),
    "well-formed-but-impossible dates are malformed",
  );

  const order = noticePreflightChecks(
    nx({ issueDate: lagosDateOffset(30), responseDueDate: DUE_DATE }),
  );
  assert.equal(order.length, 1);
  assert.equal(order[0].field, "issueDate");
  assert.match(order[0].message, /after the response due date/);

  const amount = noticePreflightChecks(nx({ amountDemanded: "five hundred" }));
  assert.equal(amount.length, 1);
  assert.equal(amount[0].field, "amountDemanded");
});

test("approve creates the obligation and records corrections (incl. changed fields)", async () => {
  const kase = await makeNoticeCase("approve-happy");
  const result = await decideNoticeCase(kase.id, approval(), operatorId);

  assert.equal(result.case.status, "approved");
  assert.equal(result.case.decisionAction, "approve");
  assert.equal(result.case.decidedBy, operatorId);
  assert.equal(result.case.firmId, firmId);
  assert.equal(result.case.createdInvoiceId, null, "a notice NEVER creates an invoice");

  const ob = result.obligation;
  assert.ok(ob, "the approve result carries the obligation");
  assert.equal(ob.sourceCaseId, kase.id);
  assert.equal(ob.firmId, firmId);
  assert.equal(ob.clientPartyId, clientId);
  assert.equal(ob.noticeType, "assessment");
  assert.equal(ob.authority, "firs");
  assert.equal(ob.reference, `FIRS/ASMT/${SALT}`);
  assert.equal(ob.taxType, "vat");
  assert.equal(ob.period, "Jan-Mar 2026");
  assert.equal(ob.amount, "450000.00");
  assert.equal(ob.currency, "NGN");
  assert.equal(ob.issueDate, ISSUE_DATE);
  assert.equal(ob.responseDueDate, DUE_DATE);
  assert.equal(ob.status, "open");
  assert.equal(ob.createdBy, operatorId);
  assert.equal(ob.notes, "Objection being prepared");

  const rows = await obligationsForCase(kase.id);
  assert.equal(rows.length, 1, "exactly one obligation per case");

  const corrections = result.case.corrections ?? [];
  const byField = new Map(corrections.map((c) => [c.field, c]));
  assert.equal(
    byField.size,
    NOTICE_FIELDS.length + 1,
    "one row per canonical field plus the noticeType classification",
  );
  const amt = byField.get("amountDemanded")!;
  assert.equal(amt.extracted, "500000.00");
  assert.equal(amt.final, "450000.00");
  assert.equal(amt.changed, true, "the operator's amount override is recorded");
  assert.equal(byField.get("responseDueDate")!.changed, false);
  assert.equal(byField.get("referenceNumber")!.changed, false);
  assert.equal(byField.get("noticeType")!.changed, false);
  assert.equal(
    byField.get("authority")!.changed,
    true,
    "verbatim document text vs catalogue key is an honest (recorded) mapping",
  );

  const [audit] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "clerk.notice.approve"),
        eq(auditEventsTable.entityId, kase.id),
      ),
    )
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  assert.ok(audit, "approval is audited");
});

test("approve without confirmed values names every missing field", async () => {
  const kase = await makeNoticeCase("incomplete");
  await assert.rejects(
    decideNoticeCase(kase.id, { action: "approve" }, operatorId),
    (err: unknown) => {
      assert.ok(isDomainError("DECISION_INCOMPLETE", 400)(err));
      const msg = (err as Error).message;
      for (const f of [
        "firmId",
        "clientPartyId",
        "noticeType",
        "authority",
        "responseDueDate",
      ]) {
        assert.ok(msg.includes(f), `names ${f}`);
      }
      return true;
    },
  );
  assert.equal((await getCase(kase.id)).status, "extracted", "undecided");
  assert.equal((await obligationsForCase(kase.id)).length, 0);
});

test("malformed confirmed values are a clean 400, never a row", async () => {
  const kase = await makeNoticeCase("invalid-values");
  await assert.rejects(
    decideNoticeCase(kase.id, approval({ responseDueDate: "31/12/2026" }), operatorId),
    isDomainError("DECISION_INVALID", 400),
  );
  await assert.rejects(
    decideNoticeCase(kase.id, approval({ issueDate: "2026-02-31" }), operatorId),
    isDomainError("DECISION_INVALID", 400),
  );
  await assert.rejects(
    decideNoticeCase(kase.id, approval({ amount: "five hundred" }), operatorId),
    isDomainError("DECISION_INVALID", 400),
  );
  assert.equal((await getCase(kase.id)).status, "extracted");
  assert.equal((await obligationsForCase(kase.id)).length, 0);
});

test("kind walls: notice decisions only on notice cases, and vice versa", async () => {
  const invoiceCase = await createExtractionCase(
    { sourceType: "text", text: `Notice kind-wall invoice ${SALT}` },
    operatorId,
    fakeGateway(() => "not json"),
  );
  assert.equal(invoiceCase.kind, "extraction");
  await assert.rejects(
    decideNoticeCase(invoiceCase.id, approval(), operatorId),
    isDomainError("CASE_BAD_KIND", 409),
  );

  const noticeCase = await makeNoticeCase("kind-wall");
  await assert.rejects(
    decideCase(noticeCase.id, { action: "reject" }, operatorId),
    isDomainError("CASE_BAD_KIND", 409),
  );
});

test("double-approve is race-safe via the sourceCaseId unique index", async () => {
  const kase = await makeNoticeCase("double-approve");
  await decideNoticeCase(kase.id, approval(), operatorId);

  // The ordinary second attempt fails the status pre-read.
  await assert.rejects(
    decideNoticeCase(kase.id, approval(), operator2Id),
    isDomainError("CASE_BAD_STATE", 409),
  );

  // Simulate the CAS race window (both sides passed the status pre-read):
  // flip the status back so the second approve reaches the insert — the
  // unique index is the backstop that must catch it.
  await getDb()
    .update(clerkCasesTable)
    .set({ status: "extracted" })
    .where(eq(clerkCasesTable.id, kase.id));
  await assert.rejects(
    decideNoticeCase(kase.id, approval(), operator2Id),
    isDomainError("CASE_DECIDED_CONFLICT", 409),
  );
  assert.equal(
    (await obligationsForCase(kase.id)).length,
    1,
    "exactly one obligation survives the race",
  );
});

test("reject and escalate mirror the extraction decision path (no obligation)", async () => {
  const rejected = await makeNoticeCase("reject");
  const rejectResult = await decideNoticeCase(
    rejected.id,
    { action: "reject", reason: "unreadable scan" },
    operatorId,
  );
  assert.equal(rejectResult.case.status, "rejected");
  assert.equal(rejectResult.case.decisionAction, "reject");
  assert.equal(rejectResult.case.decisionReason, "unreadable scan");
  assert.equal(rejectResult.obligation, undefined);
  assert.equal((await obligationsForCase(rejected.id)).length, 0);

  const escalated = await makeNoticeCase("escalate");
  const escalateResult = await decideNoticeCase(
    escalated.id,
    { action: "escalate", reason: "needs a partner" },
    operator2Id,
  );
  assert.equal(escalateResult.case.status, "escalated");
  assert.equal(escalateResult.case.decidedBy, operator2Id);
  assert.equal(escalateResult.obligation, undefined);

  const [audit] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "clerk.notice.reject"),
        eq(auditEventsTable.entityId, rejected.id),
      ),
    )
    .limit(1);
  assert.ok(audit, "reject is audited under the notice action");
});

test("a claimed notice case is decided only by its holder", async () => {
  const kase = await makeNoticeCase("claim-holder");
  await claimCase(kase.id, operator2Id);
  await assert.rejects(
    decideNoticeCase(kase.id, approval(), operatorId),
    isDomainError("CASE_CLAIMED", 409),
  );
  const result = await decideNoticeCase(kase.id, approval(), operator2Id);
  assert.equal(result.case.status, "approved");
  assert.equal(result.case.decidedBy, operator2Id);
});

test("firm walls: unknown firm 404, mismatched firm 409, stranger party 400", async () => {
  const kase = await makeNoticeCase("firm-walls");
  await assert.rejects(
    decideNoticeCase(
      kase.id,
      approval({ firmId: "00000000-0000-4000-8000-00000000dead" }),
      operatorId,
    ),
    isDomainError("FIRM_NOT_FOUND", 404),
  );
  await assert.rejects(
    decideNoticeCase(
      kase.id,
      approval({ clientPartyId: strangerPartyId }),
      operatorId,
    ),
    isDomainError("PARTY_NOT_IN_FIRM", 400),
  );

  // A firm-attributed capture cannot be approved into a DIFFERENT firm.
  const pinned = await createExtractionCase(
    {
      sourceType: "text",
      text: `Notice firm-pinned ${SALT}`,
      documentKind: "notice",
    },
    operatorId,
    fakeGateway(() => JSON.stringify(noticeOutput())),
    undefined,
    { firmId },
  );
  assert.equal(pinned.firmId, firmId);
  await assert.rejects(
    decideNoticeCase(pinned.id, approval({ firmId: otherFirmId }), operatorId),
    isDomainError("CASE_FIRM_MISMATCH", 409),
  );
});

test("notices never fast-lane", async () => {
  const kase = await makeNoticeCase("fast-lane");
  assert.equal(kase.status, "extracted");
  assert.deepEqual(kase.preflight, []);
  assert.equal(
    fastLaneBlocker(kase),
    "not an extraction case",
    "even a clean, extracted notice is refused by the bulk fast lane",
  );
  // Extraction-shaped objects without a kind keep the historic meaning.
  assert.equal(
    fastLaneBlocker({
      status: "extracted",
      preflight: [],
      extraction: {
        fields: [],
        lines: [],
        promptVersion: "t",
        model: "t",
      },
    }),
    null,
  );
});

test("retry on a failed notice case re-runs the NOTICE lane", async () => {
  const failed = await makeNoticeCase("retry", () => {
    throw new Error("upstream 500");
  });
  assert.equal(failed.status, "failed");

  const updated = await retryExtraction(
    failed.id,
    operatorId,
    fakeGateway(() => JSON.stringify(noticeOutput())),
  );
  assert.equal(updated.status, "extracted");
  assert.equal(updated.kind, "notice");
  assert.equal(updated.extraction, null);
  assert.equal(
    updated.noticeExtraction?.promptVersion,
    EXTRACT_NOTICE_PROMPT_VERSION,
  );

  const calls = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.caseId, failed.id));
  assert.ok(
    calls.every((c) => c.purpose === "extract_notice"),
    "every ledgered call for the case rode the notice purpose",
  );

  // A successfully extracted notice case is not retryable.
  await assert.rejects(
    retryExtraction(updated.id, operatorId, fakeGateway(() => "{}")),
    isDomainError("CASE_BAD_STATE", 409),
  );
});

test("the stuck-pending watchdog covers the notice lane", async () => {
  const stuckText = `Notice stuck ${SALT}`;
  const [stuck] = await getDb()
    .insert(clerkCasesTable)
    .values({
      kind: "notice",
      status: "pending",
      sourceType: "text",
      sourceName: "stuck-notice.txt",
      sourceText: stuckText,
      sourceHash: sha256(stuckText),
      createdBy: operatorId,
      createdAt: new Date(Date.now() - 16 * 60 * 1000),
    })
    .returning();
  const recovered = await sweepStuckPendingCases();
  assert.ok(recovered >= 1);
  const [flipped] = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, stuck.id));
  assert.equal(flipped.status, "failed", "a stranded notice case fails out too");
  assert.match(flipped.failReason ?? "", /never completed/);
});
