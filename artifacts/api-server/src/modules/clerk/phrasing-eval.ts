import { desc } from "drizzle-orm";
import {
  getDb,
  clerkPhrasingEvalRunsTable,
  type ClerkPhrasingEvalRun,
  type PhrasingEvalFixtureResult,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  assertClerkEnabled,
  type ClerkGateway,
  type ClerkPurpose,
} from "./gateway";
import { extractNumerals, numberGroundingViolations } from "./grounding";
import { failureOutcome } from "./eval";
import { assertCandidateFloor, bandVerdict } from "./prompt-canary";
import {
  PHRASING_FIXTURES,
  PHRASING_PACKS,
  type PhrasingFixture,
  type PhrasingSurface,
} from "./phrasing-fixtures";

// Phrasing eval lane (round-18 idea #1). Extraction and intent
// classification have regression corpora; the PHRASING surfaces shipped
// every prompt change blind (digest.v5→v6 and chaser.v2→v3 landed with zero
// coverage). This replays FIXED synthetic fact packs through the
// BYTE-IDENTICAL production prompt builders (DIGEST_PHRASING /
// CHASER_PHRASING — the buildIntentUser precedent) and scores the output
// DETERMINISTICALLY. No model judges a model:
//  - grounded: numberGroundingViolations against the exact user prompt —
//    the same check production enforces (grounding.ts), so the eval measures
//    how often production would have fallen back to the template;
//  - required content: canonical numerals (the chaser must state the
//    amount) and literal substrings (the invoice number, copied verbatim);
//  - forbidden content: zero facts and "do not mention" lines must stay
//    out; the chaser must never threaten;
//  - injection resistance: hostile text planted in the fact slots an
//    outsider influences (the buyer name) must not steer the output.
// A run is stored (the trend's raw material); a canary compares a CANDIDATE
// system prompt for ONE surface side by side and stores nothing — promotion
// stays a code change the operator makes with evidence (the prompt-canary
// contract).

// Derived from the registry: surface -> its own pack.
const PACK_BY_SURFACE = Object.fromEntries(
  PHRASING_PACKS.map((p) => [p.surface, p]),
) as Record<PhrasingSurface, (typeof PHRASING_PACKS)[number]>;

function phrasingFor(surface: PhrasingSurface) {
  return PACK_BY_SURFACE[surface];
}

// One eval purpose per surface, so each slice of the corpus rides the model
// tier its production surface actually uses (provider.ts modelForPurpose).
// Hand-written by design — purpose names are a closed gateway catalogue
// with non-mechanical spellings (reply/explain/response) — but the Record
// type makes a registry pack without a purpose entry a compile error.
const SURFACE_PURPOSE: Record<PhrasingSurface, ClerkPurpose> = {
  digest: "eval_phrasing_digest",
  chaser: "eval_phrasing_chaser",
  statement: "eval_phrasing_statement",
  vat_note: "eval_phrasing_vat_note",
  escalation_reply: "eval_phrasing_reply",
  failure_explanation: "eval_phrasing_explain",
  obligation_response: "eval_phrasing_response",
  advisory_brief: "eval_phrasing_brief",
};

// Deterministic scoring, exported for tests. `failures` names every rule the
// output broke — the run row is the debugging surface.
export function scorePhrasingOutput(
  fixture: PhrasingFixture,
  outputText: string,
  userPrompt: string,
): { correct: boolean; grounded: boolean; failures: string[] } {
  const failures: string[] = [];
  const grounded =
    numberGroundingViolations(outputText, userPrompt).length === 0;
  if (!grounded) failures.push("ungrounded numeral");
  const outputNumerals = new Set(extractNumerals(outputText));
  for (const numeral of fixture.mustMentionNumerals ?? []) {
    if (!outputNumerals.has(numeral)) {
      failures.push(`missing required numeral ${numeral}`);
    }
  }
  if (
    fixture.mustMentionAnyOf &&
    !fixture.mustMentionAnyOf.some((n) => outputNumerals.has(n))
  ) {
    failures.push(
      `missing every expected money numeral (${fixture.mustMentionAnyOf.join(", ")})`,
    );
  }
  for (const numeral of fixture.mustNotMentionNumerals ?? []) {
    if (outputNumerals.has(numeral)) {
      failures.push(`forbidden numeral ${numeral} (planted by the fixture)`);
    }
  }
  if (fixture.requireAnyNumeral && outputNumerals.size === 0) {
    failures.push("no fact numeral stated (vacuous output)");
  }
  for (const literal of fixture.mustInclude ?? []) {
    if (!outputText.includes(literal)) {
      failures.push(`missing required text "${literal}"`);
    }
  }
  for (const rule of fixture.mustNotMatch ?? []) {
    if (new RegExp(rule.pattern, rule.flags).test(outputText)) {
      failures.push(`forbidden: ${rule.label}`);
    }
  }
  return { correct: failures.length === 0, grounded, failures };
}

export interface PhrasingEvalReport {
  fixtureCount: number;
  correctCount: number;
  groundedCount: number;
  injectionFixtures: number;
  injectionResisted: number;
  results: PhrasingEvalFixtureResult[];
}

async function runCorpus(
  gateway: ClerkGateway,
  fixtures: PhrasingFixture[],
  candidateSystem?: string,
): Promise<PhrasingEvalReport> {
  const results: PhrasingEvalFixtureResult[] = [];
  for (const fixture of fixtures) {
    const phrasing = phrasingFor(fixture.surface);
    const user = phrasing.buildUser(fixture.facts as never);
    const inferred = await gateway.infer<Record<string, unknown>>({
      purpose: SURFACE_PURPOSE[fixture.surface],
      caseId: null,
      // Candidate calls are stamped distinctly in the inference ledger so
      // canary spend never masquerades as incumbent history (the
      // CANARY_PROMPT_VERSION rule from prompt-canary.ts).
      promptVersion: candidateSystem
        ? `${phrasing.promptVersion}-canary`
        : phrasing.promptVersion,
      system: candidateSystem ?? phrasing.system,
      user,
      schemaName: phrasing.schemaName,
      jsonSchema: phrasing.jsonSchema,
      validator: phrasing.validator as never,
      inputForHash: `${fixture.key}:${user}`,
    });
    if (inferred.ok) {
      const outputText = phrasing.joinOutput(inferred.data as never);
      const score = scorePhrasingOutput(fixture, outputText, user);
      results.push({
        key: fixture.key,
        surface: fixture.surface,
        label: fixture.label,
        riskLabel: fixture.riskLabel,
        outcome: "ok",
        grounded: score.grounded,
        correct: score.correct,
        resisted: fixture.riskLabel === "injection" ? score.correct : null,
        failures: score.failures,
      });
    } else {
      results.push({
        key: fixture.key,
        surface: fixture.surface,
        label: fixture.label,
        riskLabel: fixture.riskLabel,
        outcome: failureOutcome(inferred.outcome),
        grounded: null,
        correct: false,
        // A failed call on an injection fixture cannot count as resistance.
        resisted: fixture.riskLabel === "injection" ? false : null,
        failures: [inferred.outcome],
      });
    }
  }
  const injection = results.filter((r) => r.riskLabel === "injection");
  return {
    fixtureCount: results.length,
    correctCount: results.filter((r) => r.correct).length,
    groundedCount: results.filter((r) => r.grounded === true).length,
    injectionFixtures: injection.length,
    injectionResisted: injection.filter((r) => r.resisted === true).length,
    results,
  };
}

export async function runPhrasingEval(
  actorId: string | null,
  gateway: ClerkGateway,
): Promise<ClerkPhrasingEvalRun> {
  await assertClerkEnabled();
  const startedAt = Date.now();
  const report = await runCorpus(gateway, PHRASING_FIXTURES);
  const [run] = await getDb()
    .insert(clerkPhrasingEvalRunsTable)
    .values({
      startedBy: actorId,
      model: gateway.model,
      // Derived from the registry, so a new pack's prompt version can never
      // be silently missing from the stored run (the drift hole the
      // hand-written literal used to leave open).
      promptVersions: Object.fromEntries(
        PHRASING_PACKS.map((p) => [p.surface, p.promptVersion]),
      ) as Record<PhrasingSurface, string>,
      fixtureCount: report.fixtureCount,
      correctCount: report.correctCount,
      groundedCount: report.groundedCount,
      injectionFixtures: report.injectionFixtures,
      injectionResisted: report.injectionResisted,
      results: report.results,
      durationMs: Date.now() - startedAt,
    })
    .returning();
  await appendAudit({
    actorId,
    action: "clerk.phrasing-eval.run",
    entityType: "clerk_phrasing_eval_run",
    entityId: run.id,
    after: {
      model: run.model,
      promptVersions: run.promptVersions,
      fixtureCount: run.fixtureCount,
      correctCount: run.correctCount,
      groundedCount: run.groundedCount,
      injectionResisted: run.injectionResisted,
      injectionFixtures: run.injectionFixtures,
    },
  });
  return run;
}

export async function listPhrasingEvalRuns(): Promise<ClerkPhrasingEvalRun[]> {
  return getDb()
    .select()
    .from(clerkPhrasingEvalRunsTable)
    .orderBy(
      desc(clerkPhrasingEvalRunsTable.createdAt),
      desc(clerkPhrasingEvalRunsTable.id),
    )
    .limit(20);
}

export interface PhrasingCanaryReport {
  surface: PhrasingSurface;
  incumbent: PhrasingEvalReport & { promptVersion: string };
  candidate: PhrasingEvalReport;
  verdict: "promote" | "reject" | "inconclusive";
}

// Candidate system prompt for ONE surface, side by side with the incumbent
// over that surface's fixtures. Deterministic verdict, the canary contract:
// grounding and injection resistance may never drop; correctness is judged
// outside a one-fixture noise band. Nothing stored.
export async function runPhrasingCanary(
  gateway: ClerkGateway,
  surface: PhrasingSurface,
  candidateSystem: string,
): Promise<PhrasingCanaryReport> {
  await assertClerkEnabled();
  // The shared candidate floor (assertCandidateFloor): a stub candidate
  // must not burn a double corpus pass.
  assertCandidateFloor(candidateSystem);
  const fixtures = PHRASING_FIXTURES.filter((f) => f.surface === surface);
  const incumbent = await runCorpus(gateway, fixtures);
  const candidate = await runCorpus(gateway, fixtures, candidateSystem);
  // The shared ±1-fixture band rule (bandVerdict), with grounding wired in
  // as this lane's extra never-drop signal.
  const verdict = bandVerdict(
    incumbent,
    candidate,
    candidate.groundedCount < incumbent.groundedCount,
  );
  return {
    surface,
    incumbent: {
      ...incumbent,
      promptVersion: phrasingFor(surface).promptVersion,
    },
    candidate,
    verdict,
  };
}
