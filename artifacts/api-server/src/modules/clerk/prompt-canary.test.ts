import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, usersTable } from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  canaryVerdict,
  runPromptCanary,
  selectCanaryCorpus,
} from "./prompt-canary.ts";
import type { EvalFixture } from "./eval-fixtures.ts";
import { EXTRACT_SYSTEM } from "./prompts.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Prompt canary (round-5 idea #2). Pinned invariants:
//  - both sides run the SAME corpus through the live gateway; scoring and
//  the verdict are deterministic — the model never judges itself;
//  - injection resistance may NEVER drop: that alone is a regression, even
//  with better accuracy;
//  - accuracy changes inside the noise band are comparable;
//  - a candidate outside the length bounds is refused before any call.

const SALT = makeRunSalt();
const actorId = randomUUID();

const side = (over: Partial<Parameters<typeof canaryVerdict>[0]> = {}) => ({
  promptVersion: "x",
  fieldsCompared: 100,
  fieldsCorrect: 90,
  accuracy: 0.9,
  injectionFixtures: 4,
  injectionResisted: 4,
  failures: 0,
  ...over,
});

const CANDIDATE = `You extract invoice fields for a canary test. ${"pad ".repeat(30)}${SALT}`;

before(async () => {
  await saveAndEnableClerkFlag();
  await getDb()
    .insert(usersTable)
    .values({ id: actorId, email: `canary-${SALT}@test.local` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("canaryVerdict: the fixed rule, in priority order", () => {
  // 1. Resistance drop = regression, even with a big accuracy gain.
  assert.equal(
    canaryVerdict(side(), side({ accuracy: 0.99, injectionResisted: 3 })).verdict,
    "regression",
  );
  // 2. Accuracy beyond the band down = regression.
  assert.equal(canaryVerdict(side(), side({ accuracy: 0.87 })).verdict, "regression");
  // 3. Accuracy beyond the band up = improvement.
  assert.equal(canaryVerdict(side(), side({ accuracy: 0.93 })).verdict, "improvement");
  // Better resistance at comparable accuracy = improvement.
  assert.equal(
    canaryVerdict(side({ injectionResisted: 3 }), side({ accuracy: 0.89 })).verdict,
    "improvement",
  );
  // 4. Inside the band, equal resistance = comparable.
  assert.equal(canaryVerdict(side(), side({ accuracy: 0.91 })).verdict, "comparable");
});

test("the corpus cap can never evict the injection fixtures", () => {
  const fx = (key: string, riskLabel: EvalFixture["riskLabel"]): EvalFixture => ({
    key,
    label: key,
    riskLabel,
    sourceText: "x",
    expected: {} as EvalFixture["expected"],
  });
  // 38 grown/clean fixtures ahead of 4 injections: a head-slice at 10 would
  // drop every injection; stratification keeps them all.
  const full = [
    ...Array.from({ length: 38 }, (_, i) => fx(`clean.${i}`, "clean")),
    ...Array.from({ length: 4 }, (_, i) => fx(`inj.${i}`, "injection")),
  ];
  const { fixtures, truncated } = selectCanaryCorpus(full, 10);
  assert.equal(fixtures.length, 10);
  assert.equal(truncated, true);
  assert.equal(
    fixtures.filter((f) => f.riskLabel === "injection").length,
    4,
    "every injection fixture survives the cap",
  );
  // No truncation when the corpus fits.
  const small = selectCanaryCorpus(full.slice(0, 5), 10);
  assert.equal(small.truncated, false);
  assert.equal(small.fixtures.length, 5);
});

test("identical behaviour on both sides is comparable", async () => {
  const ok = () => JSON.stringify({ fields: [], lines: [] });
  const report = await runPromptCanary(actorId, CANDIDATE, fakeGateway(ok));
  assert.equal(report.verdict, "comparable");
  assert.equal(report.incumbent.fieldsCompared, report.candidate.fieldsCompared);
  assert.equal(report.incumbent.fieldsCorrect, report.candidate.fieldsCorrect);
  assert.equal(report.fixtures.some((f) => f.regressed), false);
  assert.ok(report.fixtureCount > 0);
});

test("a candidate that breaks the model regresses; per-fixture diffs say where", async () => {
  const report = await runPromptCanary(
    actorId,
    CANDIDATE,
    // The provider only sees the system text — the incumbent side answers
    // validly, the candidate side returns garbage that fails schema.
    fakeGateway((req) =>
      req.system === EXTRACT_SYSTEM
        ? JSON.stringify({ fields: [], lines: [] })
        : "not json",
    ),
  );
  assert.equal(report.candidate.failures, report.fixtureCount);
  assert.equal(report.incumbent.failures, 0);
  assert.equal(report.verdict, "regression");
  assert.ok(
    report.incumbent.fieldsCorrect > 0,
    "the incumbent's null-expectation matches keep its accuracy above the band",
  );
});

test("candidate length bounds are checked before any model call", async () => {
  let calls = 0;
  const counting = fakeGateway(() => {
    calls += 1;
    return "{}";
  });
  await assert.rejects(
    runPromptCanary(actorId, "too short", counting),
    (err: unknown) => err instanceof DomainError && err.code === "BAD_CANDIDATE",
  );
  await assert.rejects(
    runPromptCanary(actorId, "x".repeat(20_001), counting),
    (err: unknown) => err instanceof DomainError && err.code === "BAD_CANDIDATE",
  );
  assert.equal(calls, 0, "no tokens spent on an unusable candidate");
});
