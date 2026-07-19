import { DomainError } from "../errors";
import { assertClerkEnabled, type ClerkGateway } from "./gateway";
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM } from "./prompts";
import {
  buildGatewayForModel,
  parseModelTiers,
  modelForPurpose,
} from "./provider";
import {
  aggregate,
  canaryVerdict,
  computeFixtureDiffs,
  loadCanaryCorpus,
  runSide,
  type CanaryFixtureDiff,
  type PromptCanaryReport,
} from "./prompt-canary";
import type { scoreFixture } from "./eval";
import { appendAudit } from "../audit/audit";

// Model canary. The prompt canary answers "is this prompt edit safe?"; this
// answers the provider-evaluation question next to it — "is this MODEL safe?"
// — with the exact same machinery: same stratified corpus, same incumbent
// EXTRACT_SYSTEM on BOTH sides (only the model differs, so the diff measures
// the model and nothing else), same deterministic scoring and the same fixed
// verdict rule (injection resistance may never drop; accuracy is judged
// outside the noise band). Decision support only: nothing is stored — the
// model id lives in env config (CLERK_MODEL / CLERK_MODEL_TIERS), promotion
// is a config change the operator makes with this evidence in hand. Every
// call lands in the append-only ledger under purpose eval_canary, and the
// candidate gateway's provider pins the candidate model id, so the ledger
// cohorts the two sides by served model automatically.

const MAX_MODEL_CHARS = 120;

export interface ModelCanarySide {
  model: string;
  fieldsCompared: number;
  fieldsCorrect: number;
  accuracy: number | null;
  injectionFixtures: number;
  injectionResisted: number;
  failures: number;
}

export interface ModelCanaryReport {
  fixtureCount: number;
  truncated: boolean;
  candidateModel: string;
  incumbent: ModelCanarySide;
  candidate: ModelCanarySide;
  fixtures: CanaryFixtureDiff[];
  verdict: PromptCanaryReport["verdict"];
  verdictReason: string;
}

export async function runModelCanary(
  actorId: string,
  candidateModel: string,
  incumbentGateway: ClerkGateway,
  // Injectable for tests (like every gateway seam); production builds the
  // fixed-model gateway from the candidate id.
  candidateGateway?: ClerkGateway,
): Promise<ModelCanaryReport> {
  await assertClerkEnabled();
  const model = candidateModel.trim();
  if (
    model.length < 1 ||
    model.length > MAX_MODEL_CHARS ||
    /\s/.test(model)
  ) {
    throw new DomainError(
      "BAD_CANDIDATE_MODEL",
      `The candidate model must be a single identifier of 1 to ${MAX_MODEL_CHARS} characters with no whitespace.`,
      400,
    );
  }

  const candGateway = candidateGateway ?? (await buildGatewayForModel(model));
  const { fixtures, truncated } = await loadCanaryCorpus();

  const incumbentResults: Array<ReturnType<typeof scoreFixture>> = [];
  const candidateResults: Array<ReturnType<typeof scoreFixture>> = [];
  for (const fixture of fixtures) {
    // BOTH sides run the incumbent system prompt and prompt version — the
    // candidate model is the only variable under test.
    incumbentResults.push(
      await runSide(
        fixture,
        EXTRACT_SYSTEM,
        EXTRACT_PROMPT_VERSION,
        incumbentGateway,
      ),
    );
    candidateResults.push(
      await runSide(
        fixture,
        EXTRACT_SYSTEM,
        EXTRACT_PROMPT_VERSION,
        candGateway,
      ),
    );
  }

  // The incumbent side's label is the model the incumbent gateway would route
  // for this purpose: eval_canary follows the extract_invoice tier unless
  // explicitly overridden (provider.ts), so under tiering the label names the
  // model that ACTUALLY served the incumbent side, not the gateway default.
  const incumbentModel = modelForPurpose(
    "eval_canary",
    parseModelTiers(process.env.CLERK_MODEL_TIERS),
    incumbentGateway.model,
  );
  const incumbent: ModelCanarySide = {
    model: incumbentModel,
    ...aggregate(incumbentResults),
  };
  const candidate: ModelCanarySide = {
    model,
    ...aggregate(candidateResults),
  };
  const { verdict, verdictReason } = canaryVerdict(incumbent, candidate);
  const diffs = computeFixtureDiffs(fixtures, incumbentResults, candidateResults);

  await appendAudit({
    actorId,
    action: "clerk.eval.model_canary",
    entityType: "clerk_eval_run",
    entityId: "model-canary",
    after: {
      fixtureCount: fixtures.length,
      verdict,
      candidateModel: model,
      incumbentModel,
      incumbentAccuracy: incumbent.accuracy,
      candidateAccuracy: candidate.accuracy,
      incumbentResisted: incumbent.injectionResisted,
      candidateResisted: candidate.injectionResisted,
    },
  });

  return {
    fixtureCount: fixtures.length,
    truncated,
    candidateModel: model,
    incumbent,
    candidate,
    fixtures: diffs,
    verdict,
    verdictReason,
  };
}
