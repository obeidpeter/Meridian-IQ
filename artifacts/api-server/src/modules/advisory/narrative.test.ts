import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  partiesTable,
} from "@workspace/db";
import type { Principal } from "../auth/rbac.ts";
import {
  buildReadinessTemplate,
  buildVatRiskTemplate,
  draftEngagementNarrative,
} from "./narrative.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Advisory narrative drafting (idea #10). Pinned invariants:
//  - every number in the letter comes from the engagement's stored findings;
//  - the template path always answers (no gateway, garbage output — never an
//  AI-availability error) and the model path only rephrases;
//  - tenancy mirrors GET /assessments/:id (firm match + SEC-03 narrowing);
//  - unsupported engagement types refuse rather than inventing a letter.

const SALT = makeRunSalt();
const firmId = randomUUID();
const otherFirmId = randomUUID();
const partyId = randomUUID();
const assessmentId = randomUUID();
const vatId = randomUUID();
const retainerId = randomUUID();

const firmPrincipal: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};

const READINESS_FINDINGS = {
  version: 1,
  score: 62,
  band: "partial",
  gaps: [
    {
      questionId: "q1",
      section: "Invoicing",
      prompt: `Invoices carry sequential numbers (${SALT})`,
      severity: "high",
    },
  ],
  remediation: [
    {
      priority: 1,
      action: "Adopt sequential invoice numbering",
      rationale: "the mandate requires unique, traceable numbers",
      relatedQuestionId: "q1",
    },
  ],
};

const VAT_FINDINGS = {
  rowCount: 12,
  verifiedCount: 9,
  atRiskCount: 3,
  invalidCount: 0,
  totalVatAmount: 90000,
  totalVatAtRisk: 22500,
};

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Narrative Firm ${SALT}` },
    { id: otherFirmId, name: `Narrative Other ${SALT}` },
  ]);
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Narrative Client ${SALT}`,
  });
  await db.insert(engagementsTable).values([
    {
      id: assessmentId,
      firmId,
      clientPartyId: partyId,
      type: "readiness_assessment",
      status: "completed",
      title: `Assessment ${SALT}`,
      findings: READINESS_FINDINGS,
    },
    {
      id: vatId,
      firmId,
      clientPartyId: partyId,
      type: "vat_risk_check",
      status: "completed",
      title: `VAT check ${SALT}`,
      findings: VAT_FINDINGS,
    },
    {
      id: retainerId,
      firmId,
      clientPartyId: partyId,
      type: "retainer",
      status: "open",
      title: `Retainer ${SALT}`,
      findings: { note: "not a scored engagement" },
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("templates carry every platform-computed number verbatim", () => {
  const readiness = buildReadinessTemplate({
    score: 62,
    band: "partial",
    gaps: READINESS_FINDINGS.gaps as never,
    remediation: READINESS_FINDINGS.remediation as never,
  });
  assert.ok(readiness.includes("62%"));
  assert.ok(readiness.includes("1 gap"));
  assert.ok(readiness.includes("Adopt sequential invoice numbering"));

  const vat = buildVatRiskTemplate(VAT_FINDINGS);
  assert.ok(vat.includes("12 ledger rows"));
  assert.ok(vat.includes("NGN 22500"));

  const clean = buildVatRiskTemplate({ ...VAT_FINDINGS, atRiskCount: 0 });
  assert.ok(clean.includes("no action is needed"));
});

test("no gateway: the template answers for both engagement types", async () => {
  const readiness = await draftEngagementNarrative(
    assessmentId,
    firmPrincipal,
    null,
  );
  assert.equal(readiness.source, "template");
  assert.ok(readiness.narrative.includes("62%"));

  const vat = await draftEngagementNarrative(vatId, firmPrincipal, null);
  assert.equal(vat.source, "template");
  assert.ok(vat.narrative.includes("NGN 22500"));
});

test("a valid phrasing is used; garbage output falls back to the template", async () => {
  const phrased = await draftEngagementNarrative(
    assessmentId,
    firmPrincipal,
    fakeGateway(() => JSON.stringify({ narrative: "A warm client letter." })),
  );
  assert.equal(phrased.source, "clerk");
  assert.equal(phrased.narrative, "A warm client letter.");

  const fallback = await draftEngagementNarrative(
    assessmentId,
    firmPrincipal,
    fakeGateway(() => "not json"),
  );
  assert.equal(fallback.source, "template");
  assert.ok(fallback.narrative.includes("62%"));
});

test("unsupported engagement types refuse rather than invent", async () => {
  await assert.rejects(
    draftEngagementNarrative(retainerId, firmPrincipal, null),
    (err: Error & { code?: string }) => err.code === "NARRATIVE_UNSUPPORTED",
  );
});

test("malformed findings refuse — never NaN% letters", async () => {
  // The generic engagement routes let firm staff store arbitrary findings;
  // the narrative validates the shape before grounding anything in it.
  const malformedId = randomUUID();
  await getDb()
    .insert(engagementsTable)
    .values({
      id: malformedId,
      firmId,
      clientPartyId: partyId,
      type: "readiness_assessment",
      status: "completed",
      title: `Malformed ${SALT}`,
      findings: { score: "not a number", band: "sideways" },
    });
  await assert.rejects(
    draftEngagementNarrative(malformedId, firmPrincipal, null),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "FINDINGS_MALFORMED" && err.status === 422,
  );
});

test("firm-authorable findings text travels fenced in the prompt", async () => {
  const calls: import("../clerk/gateway.ts").CompletionRequest[] = [];
  await draftEngagementNarrative(
    assessmentId,
    firmPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ narrative: "ok" });
    }),
  );
  assert.equal(calls.length, 1);
  const user = calls[0].user as string;
  assert.ok(user.includes("-----BEGIN FINDINGS-----"));
  assert.ok(
    user.includes(`Invoices carry sequential numbers (${SALT})`),
    "gap prompts are inside the fence",
  );
});

test("tenancy: foreign firm and sibling client are refused", async () => {
  const foreign: Principal = { ...firmPrincipal, firmId: otherFirmId };
  await assert.rejects(
    draftEngagementNarrative(assessmentId, foreign, null),
    (err: Error & { code?: string }) => err.code === "CROSS_TENANT",
  );
  const sibling: Principal = {
    userId: randomUUID(),
    role: "client_user",
    firmId,
    clientPartyId: randomUUID(),
    buyerPartyId: null,
  };
  await assert.rejects(
    draftEngagementNarrative(assessmentId, sibling, null),
    (err: Error & { code?: string }) => err.code === "CROSS_CLIENT",
  );
});
