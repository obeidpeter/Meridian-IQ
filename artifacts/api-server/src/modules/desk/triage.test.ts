import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  escalationsTable,
  errorCatalogueTable,
  operatorCasesTable,
  featureFlagsTable,
} from "@workspace/db";
import { runTriagePass, sweepEscalationTriage, triageCase } from "./triage.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Escalation triage: Clerk proposes routing (closed category set, priority,
// catalogue code re-verified against the codes that exist); the proposal is
// stored on the case for the operator to accept or override — never applied.
// The fail-closed behaviours are pinned like every other Clerk surface.

const SALT = makeRunSalt();
const KNOWN_CODE = `TRIAGE_KNOWN_${SALT.toUpperCase()}`;

const firmId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();
const caseId = randomUUID();

const proposal = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: "submission_failure",
    priority: "high",
    catalogueCode: KNOWN_CODE,
    rationale: "The client reports a blocked submission with this code.",
    ...over,
  });

const candidate = (reason: string | null) => ({
  caseId: randomUUID(),
  title: `INV-${SALT} escalated by client`,
  errorCode: KNOWN_CODE,
  reason,
});

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Triage Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Triage Party ${SALT}`,
  });
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: partyId,
    buyerPartyId: partyId,
    invoiceNumber: `TRIAGE-${SALT}`,
    issueDate: "2026-07-01",
  });
  await db.insert(escalationsTable).values({
    invoiceId,
    firmId,
    clientPartyId: partyId,
    reason: `My submission keeps failing with ${KNOWN_CODE}, deadline is tomorrow! ${SALT}`,
  });
  await db
    .insert(errorCatalogueTable)
    .values({
      code: KNOWN_CODE,
      cause: "test cause",
      fix: "test fix",
      retriable: false,
    })
    .onConflictDoNothing();
  await db.insert(operatorCasesTable).values({
    id: caseId,
    firmId,
    clientPartyId: partyId,
    invoiceId,
    title: `TRIAGE-${SALT} escalated by client`,
    errorCode: KNOWN_CODE,
    priority: "high",
    status: "open",
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("triageCase: a valid classification keeps a known catalogue code", async () => {
  const triage = await triageCase(
    candidate("Submission is blocked."),
    new Set([KNOWN_CODE]),
    fakeGateway(() => proposal()),
  );
  assert.equal(triage.status, "proposed");
  assert.equal(triage.category, "submission_failure");
  assert.equal(triage.priority, "high");
  assert.equal(triage.catalogueCode, KNOWN_CODE);
  assert.ok(triage.rationale);
});

test("triageCase: a code the model invented is nulled — the app decides what exists", async () => {
  const triage = await triageCase(
    candidate("Submission is blocked."),
    new Set([KNOWN_CODE]),
    fakeGateway(() => proposal({ catalogueCode: "MBS_MADE_UP" })),
  );
  assert.equal(triage.status, "proposed");
  assert.equal(triage.catalogueCode, null);
});

test("triageCase: discarded model output fails closed, category invented fails closed", async () => {
  const garbage = await triageCase(
    candidate("Help!"),
    new Set(),
    fakeGateway(() => "not json"),
  );
  assert.equal(garbage.status, "failed");

  const badEnum = await triageCase(
    candidate("Help!"),
    new Set(),
    fakeGateway(() => proposal({ category: "not_a_category" })),
  );
  assert.equal(badEnum.status, "failed");
});

test("triageCase: nothing to classify means no provider call at all", async () => {
  let calls = 0;
  const triage = await triageCase(
    candidate(null),
    new Set(),
    fakeGateway(() => {
      calls += 1;
      return proposal();
    }),
  );
  assert.equal(triage.status, "failed");
  assert.equal(calls, 0);
});

test("runTriagePass stores the proposal once; a second pass never re-classifies", async () => {
  await runTriagePass(fakeGateway(() => proposal()));

  const [row] = await getDb()
    .select({ triage: operatorCasesTable.triage })
    .from(operatorCasesTable)
    .where(eq(operatorCasesTable.id, caseId));
  assert.equal(row.triage?.status, "proposed");
  assert.equal(row.triage?.catalogueCode, KNOWN_CODE);
  assert.equal(row.triage?.promptVersion, "triage.v1");

  // Second pass: the case is no longer a candidate (triage IS NULL filter),
  // so a different fake proposal cannot overwrite the stored one.
  await runTriagePass(fakeGateway(() => proposal({ priority: "low" })));
  const [again] = await getDb()
    .select({ triage: operatorCasesTable.triage })
    .from(operatorCasesTable)
    .where(eq(operatorCasesTable.id, caseId));
  assert.equal(again.triage?.priority, "high", "stored proposal is immutable");
});

test("the sweep is dark without the opt-in clerk_triage flag", async () => {
  // A fresh untriaged case; the flag is absent (or off), so the sweep must
  // not touch it — triage spends platform tokens and is opt-in.
  const darkCaseId = randomUUID();
  await getDb().insert(operatorCasesTable).values({
    id: darkCaseId,
    firmId,
    clientPartyId: partyId,
    invoiceId,
    title: `TRIAGE-DARK-${SALT}`,
    priority: "medium",
    status: "open",
  });
  await getDb()
    .delete(featureFlagsTable)
    .where(eq(featureFlagsTable.key, "clerk_triage"));

  await sweepEscalationTriage();

  const [row] = await getDb()
    .select({ triage: operatorCasesTable.triage })
    .from(operatorCasesTable)
    .where(eq(operatorCasesTable.id, darkCaseId));
  assert.equal(row.triage, null, "flag off/missing = no triage at all");
});
