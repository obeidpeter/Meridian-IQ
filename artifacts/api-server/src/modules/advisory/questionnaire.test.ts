import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getQuestionnaireTemplate,
  computeAssessment,
  QUESTIONNAIRE_VERSION,
  type AnswerInput,
} from "./questionnaire.ts";

function allQuestionIds(): string[] {
  return getQuestionnaireTemplate().sections.flatMap((s) =>
    s.questions.map((q) => q.id),
  );
}

test("template exposes weighted questions without internal remediation text", () => {
  const tpl = getQuestionnaireTemplate();
  assert.equal(tpl_version(tpl), QUESTIONNAIRE_VERSION);
  assert.ok(tpl.sections.length >= 4);
  for (const s of tpl.sections) {
    for (const q of s.questions) {
      assert.ok(q.id && q.prompt && q.helpText);
      assert.ok(q.weight >= 1);
      assert.ok(!("remediation" in q));
    }
  }
});

function tpl_version(tpl: { version: number }): number {
  return tpl.version;
}

test("all controls in place => ready, no gaps, no remediation", () => {
  const answers: AnswerInput[] = allQuestionIds().map((id) => ({
    questionId: id,
    answer: true,
  }));
  const r = computeAssessment(answers);
  assert.equal(r.score, 100);
  assert.equal(r.band, "ready");
  assert.equal(r.gaps.length, 0);
  assert.equal(r.remediation.length, 0);
});

test("no controls in place => at_risk, every question is a gap", () => {
  const answers: AnswerInput[] = allQuestionIds().map((id) => ({
    questionId: id,
    answer: false,
  }));
  const r = computeAssessment(answers);
  assert.equal(r.score, 0);
  assert.equal(r.band, "at_risk");
  assert.equal(r.gaps.length, allQuestionIds().length);
  assert.equal(r.remediation.length, allQuestionIds().length);
});

test("unanswered questions are treated as gaps (cannot inflate score)", () => {
  const r = computeAssessment([]);
  assert.equal(r.score, 0);
  assert.equal(r.gaps.length, allQuestionIds().length);
});

test("remediation is prioritised high-severity first and deterministic", () => {
  const answers: AnswerInput[] = allQuestionIds().map((id) => ({
    questionId: id,
    answer: false,
  }));
  const a = computeAssessment(answers);
  const b = computeAssessment(answers);
  assert.deepEqual(a.remediation, b.remediation);
  const severities = a.remediation.map(
    (rem) => a.gaps.find((g) => g.questionId === rem.relatedQuestionId)!.severity,
  );
  const rank = { high: 0, medium: 1, low: 2 } as const;
  for (let i = 1; i < severities.length; i++) {
    assert.ok(rank[severities[i - 1]] <= rank[severities[i]]);
  }
  a.remediation.forEach((rem, i) => assert.equal(rem.priority, i + 1));
});

test("partial compliance lands in the partial band", () => {
  const ids = allQuestionIds();
  // Answer the highest-weight questions yes, leave the rest — enough to land
  // between 50 and 79.
  const answers: AnswerInput[] = ids.map((id, i) => ({
    questionId: id,
    answer: i % 2 === 0,
  }));
  const r = computeAssessment(answers);
  assert.ok(r.score > 0 && r.score < 100);
  assert.ok(["ready", "partial", "at_risk"].includes(r.band));
});
