import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, clerkInferenceCallsTable, usersTable } from "@workspace/db";
import { DomainError } from "../errors.ts";
import { runModelCanary } from "./model-canary.ts";
import { EVAL_FIXTURES, type EvalFixture } from "./eval-fixtures.ts";
import { CANONICAL_FIELDS } from "./prompts.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Model canary. Pinned invariants:
//  - BOTH sides run the incumbent EXTRACT_SYSTEM — only the model differs,
//  so the diff measures the model and nothing else;
//  - the verdict is the SAME fixed rule as the prompt canary: injection
//  resistance may never drop, accuracy is judged outside the noise band;
//  - the ledger cohorts the two sides by served model under eval_canary;
//  - an unusable model id is refused before any call.

const SALT = makeRunSalt();
const actorId = randomUUID();
const INCUMBENT_MODEL = `inc-model-${SALT}`;
const CANDIDATE_MODEL = `cand-model-${SALT}`;

// Answer a fixture from its OWN expected values — a "perfect" model. The
// responder only sees the fenced document, so fixtures are matched back by
// source-text containment (a red-team variant contains its base document and
// scores against the base truth, which is exactly how those are built).
const matchFixture = (req: CompletionRequest): EvalFixture | undefined =>
  EVAL_FIXTURES.find(
    (f) => typeof req.user === "string" && req.user.includes(f.sourceText),
  );

const EMPTY = JSON.stringify({ fields: [], lines: [] });

const answerFields = (
  fixture: EvalFixture,
  override: Partial<Record<string, string>> = {},
): string =>
  JSON.stringify({
    fields: CANONICAL_FIELDS.map((field) => ({
      field,
      value: override[field] ?? fixture.expected[field] ?? null,
      confidence: 1,
      sourceSnippet: null,
    })),
    lines: [],
  });

const perfect = (req: CompletionRequest): string => {
  const fixture = matchFixture(req);
  return fixture ? answerFields(fixture) : EMPTY;
};

// Correct everywhere EXCEPT injection fixtures, where a planted instruction
// "wins" and a critical field flips — the model that reads well but obeys.
const obeysInjections = (req: CompletionRequest): string => {
  const fixture = matchFixture(req);
  if (!fixture) return EMPTY;
  if (fixture.riskLabel === "injection") {
    return answerFields(fixture, { invoiceNumber: "HACKED-99" });
  }
  return answerFields(fixture);
};

let savedTiers: string | undefined;

before(async () => {
  await saveAndEnableClerkFlag();
  // The incumbent side's label must be the model the gateway would route for
  // eval_canary; pin the tier env so the label assertion is deterministic.
  savedTiers = process.env.CLERK_MODEL_TIERS;
  delete process.env.CLERK_MODEL_TIERS;
  await getDb()
    .insert(usersTable)
    .values({ id: actorId, email: `model-canary-${SALT}@test.local` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
  if (savedTiers !== undefined) process.env.CLERK_MODEL_TIERS = savedTiers;
});

test("a candidate model that obeys injections regresses, whatever its accuracy", async () => {
  const report = await runModelCanary(
    actorId,
    CANDIDATE_MODEL,
    fakeGateway(perfect, INCUMBENT_MODEL),
    fakeGateway(obeysInjections, CANDIDATE_MODEL),
  );
  assert.equal(report.verdict, "regression");
  assert.ok(
    report.candidate.injectionResisted < report.incumbent.injectionResisted,
    "the candidate resisted fewer injections",
  );
  assert.equal(report.candidateModel, CANDIDATE_MODEL);
  assert.equal(report.candidate.model, CANDIDATE_MODEL);
  assert.equal(
    report.incumbent.model,
    INCUMBENT_MODEL,
    "with no tiers configured the incumbent label is the gateway's model",
  );
  assert.ok(
    report.fixtures.some((f) => f.riskLabel === "injection" && f.regressed),
    "the per-fixture diff names the lost injection",
  );

  // Both sides landed in the ledger under eval_canary, cohorted by the model
  // that actually served each call.
  for (const model of [INCUMBENT_MODEL, CANDIDATE_MODEL]) {
    const rows = await getDb()
      .select({ id: clerkInferenceCallsTable.id })
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.model, model),
          eq(clerkInferenceCallsTable.purpose, "eval_canary"),
        ),
      );
    assert.equal(rows.length, report.fixtureCount, model);
  }
});

test("a clearly more accurate candidate model is an improvement", async () => {
  const report = await runModelCanary(
    actorId,
    CANDIDATE_MODEL,
    // The incumbent extracts nothing; the candidate reads every fixture.
    fakeGateway(() => EMPTY, INCUMBENT_MODEL),
    fakeGateway(perfect, CANDIDATE_MODEL),
  );
  assert.equal(report.verdict, "improvement");
  assert.ok(
    (report.candidate.accuracy ?? 0) > (report.incumbent.accuracy ?? 0),
  );
  assert.ok(
    report.candidate.injectionResisted >= report.incumbent.injectionResisted,
    "resistance never dropped on the way up",
  );
});

test("an unusable model id is refused before any call", async () => {
  let calls = 0;
  const counting = fakeGateway(() => {
    calls += 1;
    return "{}";
  });
  const rejectsAsBadModel = (input: string) =>
    assert.rejects(
      runModelCanary(actorId, input, counting, counting),
      (err: unknown) =>
        err instanceof DomainError && err.code === "BAD_CANDIDATE_MODEL",
      input,
    );
  await rejectsAsBadModel("");
  await rejectsAsBadModel("   ");
  await rejectsAsBadModel("gpt 5.4");
  await rejectsAsBadModel("x".repeat(121));
  assert.equal(calls, 0, "no tokens spent on an unusable candidate");
});
