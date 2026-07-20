import { Router, type IRouter } from "express";
import {
  RunClerkEvalResponse,
  ListClerkEvalRunsQueryParams,
  ListClerkEvalRunsResponse,
  ListEvalFixturesResponse,
  RetireEvalFixtureParams,
  RetireEvalFixtureResponse,
  RestoreEvalFixtureParams,
  RestoreEvalFixtureResponse,
  GetExtractionPromptResponse,
  RunPromptCanaryBody,
  RunPromptCanaryResponse,
  RunModelCanaryBody,
  RunModelCanaryResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { getClerkGateway } from "../../modules/clerk/provider";
import {
  listEvalRuns,
  runEvalCorpus,
  withAccuracy,
} from "../../modules/clerk/eval";
import {
  listEvalFixtures,
  restoreFixture,
  retireFixture,
} from "../../modules/clerk/eval-curation";
import { runPromptCanary } from "../../modules/clerk/prompt-canary";
import { runModelCanary } from "../../modules/clerk/model-canary";
import {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM,
} from "../../modules/clerk/prompts";

const router: IRouter = Router();

router.post("/clerk/eval/run", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const gateway = await getClerkGateway();
  const run = await runEvalCorpus(req.principal.userId, gateway);
  res.json(RunClerkEvalResponse.parse(withAccuracy(run)));
});

router.get("/clerk/eval/runs", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = ListClerkEvalRunsQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 20) : 20;
  const runs = await listEvalRuns(limit);
  res.json(ListClerkEvalRunsResponse.parse(runs.map(withAccuracy)));
});

// Corpus curation (round 15): the inventory of every fixture the eval run
// measures — static, corrections-grown and red-team — with per-fixture pass
// history reconstructed from the stored runs (deterministic, zero model
// calls, nothing new stored). Operator-gated like the runs it summarises.
router.get("/clerk/eval/fixtures", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const report = await listEvalFixtures();
  res.json(ListEvalFixturesResponse.parse(report));
});

// Retire/restore a grown or red-team fixture. The row survives (past runs
// keep their meaning); the loaders exclude retired rows before their caps,
// so retirement frees a corpus slot. Static fixtures 400 (the module
// enforces it); an unknown key 404s. Audited per action.
router.post(
  "/clerk/eval/fixtures/:key/retire",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "clerk.use");
    const params = parseOrThrow(RetireEvalFixtureParams, req.params);
    const row = await retireFixture(params.key, req.principal.userId);
    res.json(RetireEvalFixtureResponse.parse(row));
  },
);

router.post(
  "/clerk/eval/fixtures/:key/restore",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "clerk.use");
    const params = parseOrThrow(RestoreEvalFixtureParams, req.params);
    const row = await restoreFixture(params.key, req.principal.userId);
    res.json(RestoreEvalFixtureResponse.parse(row));
  },
);

// Prompt canary (round-5 idea #2). The incumbent extraction prompt, so the
// operator can start a candidate from what actually runs today...
router.get("/clerk/eval/prompt", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  res.json(
    GetExtractionPromptResponse.parse({
      promptVersion: EXTRACT_PROMPT_VERSION,
      system: EXTRACT_SYSTEM,
    }),
  );
});

// ...and the canary itself: candidate vs incumbent over the eval corpus,
// deterministic scoring and verdict, nothing stored — decision support for
// a prompt change the operator makes in code. Spends tokens (2× a corpus
// pass); operator-gated like the eval run.
router.post("/clerk/eval/canary", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const parsed = parseOrThrow(RunPromptCanaryBody, req.body);
  const gateway = await getClerkGateway();
  const report = await runPromptCanary(
    req.principal.userId,
    parsed.candidateSystem,
    gateway,
  );
  res.json(RunPromptCanaryResponse.parse(report));
});

// Model canary: the same corpus and verdict rule, but the candidate is a
// MODEL id run under the incumbent prompt — the provider-evaluation
// counterpart to the prompt canary. Spends 2× a corpus pass; nothing stored
// (promotion is an env-config change the operator makes with the evidence).
router.post("/clerk/eval/model-canary", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const parsed = parseOrThrow(RunModelCanaryBody, req.body);
  const gateway = await getClerkGateway();
  const report = await runModelCanary(
    req.principal.userId,
    parsed.candidateModel,
    gateway,
  );
  res.json(RunModelCanaryResponse.parse(report));
});

export default router;
