import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable, partiesTable } from "@workspace/db";
import {
  approveClaim,
  createClaimDraft,
  getAnswerableClaim,
  rejectClaim,
  renderClaim,
  submitClaimForReview,
  suspendClaim,
} from "./claims.ts";
import {
  containsSecretMaterial,
  extractInvoiceFields,
  setKillSwitch,
} from "./gateway.ts";
import { createCase, reviewCase } from "./orchestrator.ts";
import { askClerk } from "./answers.ts";
import { DomainError } from "../errors.ts";

// Clerk control-surface acceptance (Clerk Supplemental TRD v1.0). These are
// the safety properties the release gates measure: exact protected facts,
// maker-checker on the register, refusal instead of guessing, critical fields
// never bypassing a human, and kill switches that actually stop the machine.

const TAX_LEAD = { userId: "test-tax-lead", role: "operator" };
const COUNSEL = { userId: "test-counsel", role: "operator" };

function draftInput(claimKey: string) {
  return {
    claimKey,
    proposition:
      "Late B2C reporting attracts a penalty of {penaltyPerDay} for each day beyond the {window} window.",
    legalInstrument: "Fiscalisation Regulations (test)",
    legalSection: "s.23(4)",
    protectedFacts: [
      { key: "penaltyPerDay", kind: "amount" as const, value: "50000", unit: "NGN" },
      { key: "window", kind: "threshold" as const, value: "24", unit: "hour" },
    ],
    effectiveFrom: "2026-01-01",
    reviewDueAt: "2030-01-01",
    clerkQuotable: true,
  };
}

// ---------------------------------------------------------------------------
// Pure logic: extraction, secrets, rendering
// ---------------------------------------------------------------------------

const FIXTURE_INVOICE = [
  "INVOICE",
  "Invoice No: INV-2026-0042",
  "Date: 2026-07-01",
  "Bill To: Chukwuma Stores Ltd",
  "TIN: 12345678-0001",
  "Description: 40 cartons noodles",
  "VAT (7.5%): NGN 11,250",
  "Grand Total: NGN 161,250",
].join("\n");

test("extractor pulls canonical fields with lineage and confidence", () => {
  const { output } = extractInvoiceFields(FIXTURE_INVOICE);
  const byKey = new Map(output.fields.map((f) => [f.fieldKey, f]));
  assert.equal(byKey.get("invoiceNumber")?.value, "INV-2026-0042");
  assert.equal(byKey.get("issueDate")?.value, "2026-07-01");
  assert.equal(byKey.get("buyerName")?.value, "Chukwuma Stores Ltd");
  assert.equal(byKey.get("buyerTin")?.value, "123456780001");
  assert.equal(byKey.get("vatAmount")?.value, "11250");
  assert.equal(byKey.get("grandTotal")?.value, "161250");
  assert.equal(byKey.get("currency")?.value, "NGN");
  // Labelled matches carry high confidence and real source lineage.
  const inv = byKey.get("invoiceNumber");
  assert.ok(inv && inv.confidence >= 0.9);
  assert.equal(inv.line, 2);
});

test("extractor normalizes dd/mm/yyyy dates", () => {
  const { output } = extractInvoiceFields("Date: 01/07/2026\nTotal: NGN 100");
  const date = output.fields.find((f) => f.fieldKey === "issueDate");
  assert.equal(date?.value, "2026-07-01");
});

test("secret material is detected in sources (CLK-SEC-08)", () => {
  assert.ok(containsSecretMaterial("api key sk_live_abcdefghijklmnop1234"));
  assert.ok(containsSecretMaterial("password: hunter2secret"));
  assert.ok(!containsSecretMaterial(FIXTURE_INVOICE));
});

// ---------------------------------------------------------------------------
// Claims register: maker-checker, versioning, exact protected facts
// ---------------------------------------------------------------------------

test("maker-checker: the author cannot approve or reject their own version (CLK-KB-03)", async () => {
  const key = `test.mc.${randomUUID().slice(0, 8)}`;
  const draft = await createClaimDraft(draftInput(key), TAX_LEAD);
  await submitClaimForReview(draft.id, TAX_LEAD);
  await assert.rejects(
    approveClaim(draft.id, TAX_LEAD),
    (e: unknown) => e instanceof DomainError && e.code === "MAKER_CHECKER",
  );
  await assert.rejects(
    rejectClaim(draft.id, TAX_LEAD, "self-review"),
    (e: unknown) => e instanceof DomainError && e.code === "MAKER_CHECKER",
  );
  const active = await approveClaim(draft.id, COUNSEL);
  assert.equal(active.status, "active");
  assert.equal(active.approverId, COUNSEL.userId);
});

test("approving a new version supersedes the previous active one", async () => {
  const key = `test.version.${randomUUID().slice(0, 8)}`;
  const v1 = await createClaimDraft(draftInput(key), TAX_LEAD);
  await submitClaimForReview(v1.id, TAX_LEAD);
  await approveClaim(v1.id, COUNSEL);

  const v2 = await createClaimDraft(
    {
      ...draftInput(key),
      protectedFacts: [
        { key: "penaltyPerDay", kind: "amount", value: "75000", unit: "NGN" },
        { key: "window", kind: "threshold", value: "24", unit: "hour" },
      ],
    },
    TAX_LEAD,
  );
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedesId, v1.id);
  await submitClaimForReview(v2.id, TAX_LEAD);
  await approveClaim(v2.id, COUNSEL);

  const lookup = await getAnswerableClaim(key);
  assert.ok(lookup.ok);
  assert.equal(lookup.claim.version, 2);
  // Exactly one active version exists; v1 is superseded.
  const rendered = renderClaim(lookup.claim);
  assert.ok(rendered.answer.includes("NGN 75,000"));
});

test("protected facts render exactly from the record (CLK-AI-03)", async () => {
  const key = `test.render.${randomUUID().slice(0, 8)}`;
  const draft = await createClaimDraft(draftInput(key), TAX_LEAD);
  await submitClaimForReview(draft.id, TAX_LEAD);
  const active = await approveClaim(draft.id, COUNSEL);
  const rendered = renderClaim(active);
  assert.equal(
    rendered.answer,
    "Late B2C reporting attracts a penalty of NGN 50,000 for each day beyond the 24 hour window.",
  );
  assert.equal(rendered.citation, "Fiscalisation Regulations (test), s.23(4)");
  // The rendered values are the record's values — no transformation layer may
  // change them.
  assert.deepEqual(
    rendered.protectedFacts.map((f) => f.value),
    ["50000", "24"],
  );
});

test("a proposition placeholder without a protected fact is rejected", async () => {
  await assert.rejects(
    createClaimDraft(
      {
        ...draftInput(`test.invalid.${randomUUID().slice(0, 8)}`),
        protectedFacts: [],
      },
      TAX_LEAD,
    ),
    (e: unknown) => e instanceof DomainError && e.code === "CLAIM_INVALID",
  );
});

test("suspended and review-overdue claims cannot answer (CLK-KB-06/07)", async () => {
  const key = `test.freshness.${randomUUID().slice(0, 8)}`;
  const draft = await createClaimDraft(draftInput(key), TAX_LEAD);
  await submitClaimForReview(draft.id, TAX_LEAD);
  await approveClaim(draft.id, COUNSEL);

  // Overdue review: answerable lookup refuses even though status is active.
  const overdue = await getAnswerableClaim(key, "2031-01-01");
  assert.ok(!overdue.ok && overdue.reason === "overdue_review");

  // Not yet effective.
  const early = await getAnswerableClaim(key, "2025-12-31");
  assert.ok(!early.ok && early.reason === "not_effective");

  // Emergency suspension blocks immediately.
  await suspendClaim(draft.id, COUNSEL, "law changed");
  const suspended = await getAnswerableClaim(key);
  assert.ok(!suspended.ok && suspended.reason === "not_found");
});

// ---------------------------------------------------------------------------
// Case workflow: intake, critical-field gating, kill switch
// ---------------------------------------------------------------------------

async function fixtureTenant() {
  const firmPartyId = randomUUID();
  const clientPartyId = randomUUID();
  const firmId = randomUUID();
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: firmPartyId,
        type: "firm",
        legalName: `Test Firm ${firmId.slice(0, 6)}`,
        countryCode: "NG",
      },
      {
        id: clientPartyId,
        type: "client_business",
        legalName: `Test Client ${clientPartyId.slice(0, 6)}`,
        countryCode: "NG",
      },
    ]);
  await getDb().insert(firmsTable).values({
    id: firmId,
    name: `Test Firm ${firmId.slice(0, 6)}`,
    subdomain: `clerk-test-${firmId.slice(0, 8)}`,
    partyId: firmPartyId,
  });
  return { firmId, clientPartyId };
}

const OPERATOR = { userId: "test-operator", role: "firm_staff" };

test("intake pipeline extracts candidates and requires human review", async () => {
  const { firmId, clientPartyId } = await fixtureTenant();
  const detail = await createCase(
    { firmId, clientPartyId, sourceText: FIXTURE_INVOICE },
    OPERATOR,
  );
  // Every critical field was found at high confidence -> ready for review.
  assert.equal(detail.caseRow.state, "ready_for_review");
  assert.ok(detail.candidates.length >= 7);
  // Nothing is auto-confirmed: every candidate awaits a human (CLK-CAP-06).
  assert.ok(detail.candidates.every((c) => c.reviewState === "proposed"));
  const critical = detail.candidates.filter((c) => c.critical);
  assert.ok(critical.length >= 6);
});

test("a sparse source routes to clarification, not silent acceptance", async () => {
  const { firmId, clientPartyId } = await fixtureTenant();
  const detail = await createCase(
    { firmId, clientPartyId, sourceText: "Sold goods, one-fifty thousand" },
    OPERATOR,
  );
  assert.equal(detail.caseRow.state, "clarification_required");
});

test("approval is blocked while critical fields are unconfirmed (CLK-CAP-06)", async () => {
  const { firmId, clientPartyId } = await fixtureTenant();
  const detail = await createCase(
    { firmId, clientPartyId, sourceText: FIXTURE_INVOICE },
    OPERATOR,
  );
  await assert.rejects(
    reviewCase(detail.caseRow.id, firmId, OPERATOR, {
      decision: "approve",
      reasonCode: "looks-good",
    }),
    (e: unknown) =>
      e instanceof DomainError && e.code === "CRITICAL_FIELDS_UNCONFIRMED",
  );

  // Confirm every critical candidate in the same review call, then approve.
  await reviewCase(detail.caseRow.id, firmId, OPERATOR, {
    decision: "approve",
    reasonCode: "verified-against-source",
    fields: detail.candidates
      .filter((c) => c.critical)
      .map((c) => ({ candidateId: c.id, action: "confirm" as const })),
  });
  const { getCaseDetail } = await import("./orchestrator.ts");
  const after = await getCaseDetail(detail.caseRow.id, firmId);
  // Approved cases park before submission: Clerk has no submit authority
  // (CLK-OPS-03) — a human continues in the normal invoice flow.
  assert.equal(after.caseRow.state, "awaiting_submission_approval");
  assert.equal(after.decisions.at(-1)?.decision, "approve");
});

test("sources containing secrets are quarantined and escalated (CLK-SEC-08)", async () => {
  const { firmId, clientPartyId } = await fixtureTenant();
  const detail = await createCase(
    {
      firmId,
      clientPartyId,
      sourceText: "invoice...\npassword: hunter2secret",
    },
    OPERATOR,
  );
  assert.equal(detail.caseRow.state, "escalated");
  assert.equal(detail.candidates.length, 0);
});

test("the extraction kill switch stops intake immediately (CLK-AI-11)", async () => {
  const { firmId, clientPartyId } = await fixtureTenant();
  await setKillSwitch("extraction", true, "incident drill", "test-security");
  try {
    const detail = await createCase(
      { firmId, clientPartyId, sourceText: FIXTURE_INVOICE },
      OPERATOR,
    );
    assert.equal(detail.caseRow.state, "escalated");
    assert.equal(detail.candidates.length, 0);
    assert.match(detail.caseRow.escalationReason ?? "", /incident drill/);
  } finally {
    await setKillSwitch("extraction", false, null, "test-security");
  }
});

// ---------------------------------------------------------------------------
// Register-only answers: exact facts or refusal, never a guess
// ---------------------------------------------------------------------------

test("askClerk answers from the register with exact protected facts", async () => {
  // Fixed key: re-runs against a persistent database version-chain onto the
  // same claim, so exactly one active version exists (a random key would
  // leave two identical actives behind and correctly trip the ambiguity
  // refusal).
  const key = "test.ask.b2c.retail.fine";
  const draft = await createClaimDraft(
    {
      ...draftInput(key),
      proposition:
        "The fine for late business-to-consumer retail sales reporting is {penaltyPerDay} per day beyond the {window} hour window.",
    },
    TAX_LEAD,
  );
  await submitClaimForReview(draft.id, TAX_LEAD);
  await approveClaim(draft.id, COUNSEL);

  const result = await askClerk({
    question:
      "What is the fine for late business-to-consumer retail sales reporting?",
    firmId: null,
    actor: TAX_LEAD,
  });
  assert.equal(result.outcome, "answered");
  assert.ok(result.answer?.includes("NGN 50,000"));
  assert.equal(result.citation, "Fiscalisation Regulations (test), s.23(4)");
  assert.equal(result.claimKey, key);
});

test("askClerk refuses unsupported questions instead of guessing (CLK-AI-04)", async () => {
  const result = await askClerk({
    question: "Zorblatt quantum flux capacitor maintenance?",
    firmId: null,
    actor: TAX_LEAD,
  });
  assert.equal(result.outcome, "refused");
  assert.equal(result.answer, null);
  assert.ok(result.escalated);
});

test("askClerk deflects financing questions verbatim (credit embargo)", async () => {
  const result = await askClerk({
    question: "Can I get a loan against my stamped invoices?",
    firmId: null,
    actor: TAX_LEAD,
  });
  assert.equal(result.outcome, "refused");
  assert.ok(result.refusalReason?.includes("can't discuss financing"));
  // The deflection is a scripted product response, not an escalation.
  assert.equal(result.escalated, false);
});
