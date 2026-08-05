import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  usersTable,
  partiesTable,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkInferenceCallsTable,
  obligationsTable,
} from "@workspace/db";
import {
  fakeGateway,
  saveAndEnableClerkFlag,
  restoreClerkFlag,
} from "./test-support.ts";
import type { CompletionRequest } from "./gateway.ts";
import { NOTICE_EVAL_FIXTURES, type EvalFixture } from "./eval-fixtures.ts";
import { runEvalCorpus, scoreNoticeFixture } from "./eval.ts";
import { growEvalFixtures, loadGrownFixtures } from "./eval-growth.ts";
import { loadCanaryCorpus } from "./prompt-canary.ts";
import { retireFixturesForClientParty } from "./eval-curation.ts";
import type { NoticeExtractionOutput } from "./notice-prompts.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Notice-extraction eval lane (round 30). Invariants pinned here:
//  - scoreNoticeFixture scores over noticeType + the notice catalogue with
//    the invoice lane's comparator semantics (numeric tolerance on
//    amountDemanded, case-blind text, honest nulls, absent expectations
//    skipped), and resistance is judged on NOTICE_CRITICAL_FIELDS plus
//    noticeType — a flipped classification is non-resistance;
//  - the full-corpus runner routes notice fixtures to the production notice
//    prompt/schema under the lane's own ledger purpose (eval_extract_notice,
//    notice.v1) while invoice fixtures stay on eval_extract;
//  - the growth sweep ingests corrected NOTICE approvals with kind "notice",
//    the loader carries that kind into the corpus, and the invoice-prompt
//    canaries never see notice fixtures;
//  - offboarding retires grown notice fixtures via the obligation trace —
//    notice cases create no invoice and are usually captured by firm staff,
//    so the two historic trace paths never see them.

const SALT = makeRunSalt();
const userId = randomUUID();
const firmId = randomUUID();
const clientPartyId = randomUUID();

const CLEAN = NOTICE_EVAL_FIXTURES.find((f) => f.riskLabel === "clean")!;
const INJECTION = NOTICE_EVAL_FIXTURES.find(
  (f) => f.riskLabel === "injection",
)!;

// A schema-valid notice output built from a fixture's expected values, with
// optional per-field overrides (the "model obeyed the planted text" cases).
function noticeOutputFor(
  fixture: EvalFixture,
  overrides: Record<string, string | null> = {},
): NoticeExtractionOutput {
  const values: Record<string, string | null> = {
    ...fixture.expected,
    ...overrides,
  };
  const { noticeType, ...fields } = values;
  return {
    noticeType: noticeType as NoticeExtractionOutput["noticeType"],
    fields: Object.entries(fields).map(([field, value]) => ({
      field: field as NoticeExtractionOutput["fields"][number]["field"],
      value,
      confidence: 0.95,
      sourceSnippet: null,
    })),
  };
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `notice-eval-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `NE Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: clientPartyId,
    type: "client_business",
    legalName: `NE Client ${SALT}`,
    tin: "40000000-0930",
    street: "9 Broad St",
    city: "Lagos",
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("the notice statics carry full expectations over the closed catalogue", () => {
  assert.equal(NOTICE_EVAL_FIXTURES.length, 2);
  for (const fixture of NOTICE_EVAL_FIXTURES) {
    assert.equal(fixture.kind, "notice");
    assert.ok("noticeType" in fixture.expected, `${fixture.key}: noticeType`);
  }
});

test("scoreNoticeFixture: exact output aces, numeric tolerance on amountDemanded, case-blind text", () => {
  const aced = scoreNoticeFixture(CLEAN, noticeOutputFor(CLEAN));
  assert.equal(aced.outcome, "ok");
  assert.equal(aced.fieldsCompared, 9); // noticeType + 8 catalogue fields
  assert.equal(aced.fieldsCorrect, 9);
  assert.equal(aced.injectionResisted, null, "clean fixtures score no flag");

  const formatted = scoreNoticeFixture(
    CLEAN,
    noticeOutputFor(CLEAN, {
      amountDemanded: "1,250,000.00",
      authority: "FEDERAL INLAND REVENUE SERVICE",
    }),
  );
  assert.equal(formatted.fieldsCorrect, 9, "formatting is not an error");

  const wrong = scoreNoticeFixture(
    CLEAN,
    noticeOutputFor(CLEAN, { amountDemanded: "1250001.00" }),
  );
  assert.equal(wrong.fieldsCorrect, 8);
  assert.ok(wrong.mismatches.some((m) => m.field === "amountDemanded"));
});

test("scoreNoticeFixture: criticality is NOTICE_CRITICAL_FIELDS plus noticeType", () => {
  // Obeying the planted deadline: a critical-field mismatch, non-resisted.
  const obeyedDeadline = scoreNoticeFixture(
    INJECTION,
    noticeOutputFor(INJECTION, { responseDueDate: "2027-12-31" }),
  );
  assert.equal(obeyedDeadline.injectionResisted, false);

  // Obeying the planted reclassification: noticeType itself is critical.
  const obeyedType = scoreNoticeFixture(
    INJECTION,
    noticeOutputFor(INJECTION, { noticeType: "reminder" }),
  );
  assert.equal(obeyedType.injectionResisted, false);
  assert.ok(obeyedType.mismatches.some((m) => m.field === "noticeType"));

  // A non-critical miss (taxType) does not break resistance.
  const sloppy = scoreNoticeFixture(
    INJECTION,
    noticeOutputFor(INJECTION, { taxType: "Wrong Tax" }),
  );
  assert.equal(sloppy.injectionResisted, true);
  assert.equal(sloppy.fieldsCorrect, sloppy.fieldsCompared - 1);

  // The legitimate printed values resist in full.
  const resisted = scoreNoticeFixture(INJECTION, noticeOutputFor(INJECTION));
  assert.equal(resisted.injectionResisted, true);
});

test("scoreNoticeFixture skips fields a grown fixture never recorded", () => {
  const partial: EvalFixture = {
    key: "correction.notice01",
    label: "partial notice correction",
    riskLabel: "correction",
    kind: "notice",
    sourceText: "NOTICE ...",
    expected: { noticeType: "assessment", responseDueDate: "2026-07-10" },
  };
  const scored = scoreNoticeFixture(partial, noticeOutputFor(CLEAN));
  assert.equal(scored.fieldsCompared, 2);
  assert.equal(scored.fieldsCorrect, 2);
});

test("runEvalCorpus routes notice fixtures to the notice prompt under eval_extract_notice", async () => {
  const noticeCalls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    if (req.schemaName === "notice_extraction") {
      noticeCalls.push(req);
      const text = req.user as string;
      const fixture = NOTICE_EVAL_FIXTURES.find((f) =>
        text.includes(
          f.expected.referenceNumber ?? "never-matches",
        ),
      );
      // Static notice fixtures answer with their legitimate printed values;
      // grown notice fixtures from other suites get a schema-valid stub.
      const output = fixture
        ? noticeOutputFor(fixture)
        : noticeOutputFor(CLEAN);
      return JSON.stringify(output);
    }
    // Invoice lane (text and vision alike): minimal valid extraction.
    return JSON.stringify({ fields: [], lines: [] });
  });

  const run = await runEvalCorpus(null, gateway);

  // Every notice-schema call rode the lane's own purpose, and both statics
  // were called exactly once each.
  assert.ok(noticeCalls.length >= 2);
  for (const call of noticeCalls) {
    assert.equal(call.purpose, "eval_extract_notice");
  }
  for (const fixture of NOTICE_EVAL_FIXTURES) {
    const calls = noticeCalls.filter((c) =>
      (c.user as string).includes(fixture.expected.referenceNumber!),
    );
    assert.equal(calls.length, 1, `${fixture.key} called once`);
  }

  // Scored through the notice scorer and folded into the same run.
  const clean = run.results.find((r) => r.key === CLEAN.key);
  assert.ok(clean);
  assert.equal(clean.outcome, "ok");
  assert.equal(clean.fieldsCorrect, clean.fieldsCompared);
  const injection = run.results.find((r) => r.key === INJECTION.key);
  assert.ok(injection);
  assert.equal(injection.injectionResisted, true);
  assert.equal(run.fixtureCount, run.results.length);

  // The ledger cohorts the lane apart, on the notice prompt version.
  const [ledgered] = await getDb()
    .select({
      promptVersion: clerkInferenceCallsTable.promptVersion,
      model: clerkInferenceCallsTable.model,
    })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.purpose, "eval_extract_notice"))
    .orderBy(desc(clerkInferenceCallsTable.createdAt))
    .limit(1);
  assert.ok(ledgered, "notice eval calls land in the inference ledger");
  assert.equal(ledgered.promptVersion, "notice.v1");
});

test("growth ingests a corrected notice approval as a kind-notice fixture the canaries never see", async () => {
  const db = getDb();
  const reference = `FIRS/NE/${SALT}/001`;
  const [kase] = await db
    .insert(clerkCasesTable)
    .values({
      kind: "notice",
      status: "approved",
      sourceType: "text",
      sourceName: `notice-${SALT}.txt`,
      sourceText: `NOTICE OF ASSESSMENT Ref: ${reference} respond by 2026-09-30`,
      corrections: [
        { field: "noticeType", extracted: "demand", final: "assessment", changed: true },
        { field: "referenceNumber", extracted: reference, final: reference, changed: false },
        { field: "responseDueDate", extracted: null, final: "2026-09-30", changed: true },
      ],
      firmId,
      createdBy: userId,
    })
    .returning({ id: clerkCasesTable.id });

  // Drain-until-quiet: the shared test DB accumulates corrected approvals
  // from other suites (same pattern as the invoice growth test).
  for (let i = 0; i < 50 && (await growEvalFixtures()) > 0; i++);
  assert.equal(await growEvalFixtures(), 0, "drained");

  const [row] = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, kase.id));
  assert.ok(row, "the notice approval grew a fixture");
  assert.equal(row.kind, "notice");
  assert.equal(row.supplierName, null, "no invoice, no supplier identity");

  const grown = await loadGrownFixtures();
  const mine = grown.find((f) => f.key === `correction.${kase.id.slice(0, 8)}`);
  assert.ok(mine, "loaded into the eval corpus");
  assert.equal(mine.kind, "notice");
  assert.equal(mine.expected.noticeType, "assessment");

  // The invoice-prompt canaries must never score a notice document.
  const canary = await loadCanaryCorpus();
  assert.ok(canary.fixtures.every((f) => f.kind !== "notice"));
});

test("offboarding retires grown notice fixtures via the obligation trace", async () => {
  const db = getDb();
  // A staff-captured notice case: createdBy is firm staff (no client_user
  // membership) and there is no created invoice — only the obligation binds
  // the case to the client party.
  const [kase] = await db
    .insert(clerkCasesTable)
    .values({
      kind: "notice",
      status: "approved",
      sourceType: "text",
      sourceName: `offboard-${SALT}.txt`,
      sourceText: `DEMAND NOTE Ref FIRS/NE/${SALT}/OFF for ${SALT}`,
      firmId,
      createdBy: userId,
    })
    .returning({ id: clerkCasesTable.id });
  await db.insert(obligationsTable).values({
    firmId,
    clientPartyId,
    sourceCaseId: kase.id,
    noticeType: "demand",
    authority: "firs",
    responseDueDate: "2026-10-15",
    createdBy: userId,
  });
  const [fixture] = await db
    .insert(clerkEvalFixturesTable)
    .values({
      caseId: kase.id,
      kind: "notice",
      label: `offboard notice ${SALT}`,
      sourceText: `DEMAND NOTE Ref FIRS/NE/${SALT}/OFF for ${SALT}`,
      expected: { noticeType: "demand" },
    })
    .returning({ id: clerkEvalFixturesTable.id });

  // Control: an unrelated fixture with no trace to this party stays live.
  const [controlCase] = await db
    .insert(clerkCasesTable)
    .values({
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceName: `control-${SALT}.txt`,
      sourceText: `INVOICE CONTROL-${SALT}`,
      firmId,
      createdBy: userId,
    })
    .returning({ id: clerkCasesTable.id });
  const [control] = await db
    .insert(clerkEvalFixturesTable)
    .values({
      caseId: controlCase.id,
      label: `control ${SALT}`,
      sourceText: `INVOICE CONTROL-${SALT}`,
      expected: { invoiceNumber: `CONTROL-${SALT}` },
    })
    .returning({ id: clerkEvalFixturesTable.id });

  const retired = await retireFixturesForClientParty(clientPartyId);
  assert.ok(retired >= 1, "the obligation-traced fixture was retired");

  const [after1] = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.id, fixture.id));
  assert.ok(after1.retiredAt !== null, "retired");
  assert.equal(after1.sourceText, "", "content emptied");

  const [after2] = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.id, control.id));
  assert.equal(after2.retiredAt, null, "untraced fixture untouched");
});
