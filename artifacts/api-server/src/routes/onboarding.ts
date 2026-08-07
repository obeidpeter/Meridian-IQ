import { Router, type IRouter } from "express";
import {
  AbandonOnboardingRunParams,
  AbandonOnboardingRunResponse,
  CreateOnboardingRunBody,
  CreateOnboardingRunResponse,
  GetOnboardingOpeningPositionParams,
  GetOnboardingOpeningPositionResponse,
  GetOnboardingRunParams,
  GetOnboardingRunResponse,
  ListOnboardingRunsQueryParams,
  ListOnboardingRunsResponse,
  RefreshOnboardingRunParams,
  RefreshOnboardingRunResponse,
  SkipOnboardingStepBody,
  SkipOnboardingStepParams,
  SkipOnboardingStepResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  narrowToClientPartyScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import {
  abandonOnboardingRun,
  createOnboardingRun,
  getOnboardingRun,
  listOnboardingRuns,
  onboardingRunView,
  refreshOnboardingRun,
  skipOnboardingStep,
  type OnboardingStepKey,
} from "../modules/onboarding/onboarding";
import { computeOpeningPosition } from "../modules/onboarding/opening-position";
import type { ClientOnboardingRun } from "@workspace/db";

// Onboard with Clerk (contract 0.70.0): the evidence-based onboarding
// checklist. Authz posture (the filings register's shape):
//  - reads are engagement.read; firm staff list firm-wide, a client_user is
//    always pinned to its own party (SEC-03: narrowToClientPartyScope on the
//    list, assertClientPartyScope on the detail — firm-keyed RLS alone would
//    share siblings);
//  - writes are engagement.write (firm staff only — a client cannot open,
//    skip or abandon its own onboarding): every module write carries the
//    firm predicate, so a foreign tenant's id updates zero rows and 404s
//    without disclosure.
// Zero model calls anywhere — every route runs deterministic SQL inside the
// ambient request transaction (never NO_CONTEXT).

const router: IRouter = Router();

async function detailFor(
  req: { principal: Parameters<typeof assertClientPartyScope>[0] },
  run: ClientOnboardingRun,
) {
  // SEC-03: a client_user may read only its own party's run.
  assertClientPartyScope(req.principal, run.clientPartyId);
  return onboardingRunView(run);
}

router.get("/onboarding/runs", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const query = parseOrThrow(ListOnboardingRunsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.clientPartyId,
  );
  const runs = await listOnboardingRuns(firmId, clientPartyId);
  res.json(
    ListOnboardingRunsResponse.parse({
      runs: await Promise.all(runs.map((r) => onboardingRunView(r))),
    }),
  );
});

router.post("/onboarding/runs", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const body = parseOrThrow(CreateOnboardingRunBody, req.body);
  const firmId = requireFirmScope(req.principal);
  const run = await createOnboardingRun(
    firmId,
    body.clientPartyId,
    req.principal.userId,
  );
  res
    .status(201)
    .json(CreateOnboardingRunResponse.parse(await detailFor(req, run)));
});

router.get("/onboarding/runs/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const params = parseOrThrow(GetOnboardingRunParams, req.params);
  const firmId = requireFirmScope(req.principal);
  const run = await getOnboardingRun(params.id, firmId);
  res.json(GetOnboardingRunResponse.parse(await detailFor(req, run)));
});

router.post(
  "/onboarding/runs/:id/refresh",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "engagement.write");
    const params = parseOrThrow(RefreshOnboardingRunParams, req.params);
    const firmId = requireFirmScope(req.principal);
    const run = await refreshOnboardingRun(params.id, firmId);
    res.json(RefreshOnboardingRunResponse.parse(await detailFor(req, run)));
  },
);

router.post(
  "/onboarding/runs/:id/steps/:stepKey/skip",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "engagement.write");
    const params = parseOrThrow(SkipOnboardingStepParams, req.params);
    const body = parseOrThrow(SkipOnboardingStepBody, req.body);
    const firmId = requireFirmScope(req.principal);
    const run = await skipOnboardingStep(
      params.id,
      firmId,
      // The zod enum has already pinned the closed catalogue.
      params.stepKey as OnboardingStepKey,
      body.reason,
      req.principal.userId,
    );
    res.json(SkipOnboardingStepResponse.parse(await detailFor(req, run)));
  },
);

// The day-one opening position (Phase 2): a completed run serves its FROZEN
// baseline (written by the completion CAS); an active or abandoned run
// computes a live PROVISIONAL picture on request. Read-only — same
// engagement.read + SEC-03 posture as the run detail.
router.get(
  "/onboarding/runs/:id/opening-position",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "engagement.read");
    const params = parseOrThrow(GetOnboardingOpeningPositionParams, req.params);
    const firmId = requireFirmScope(req.principal);
    const run = await getOnboardingRun(params.id, firmId);
    assertClientPartyScope(req.principal, run.clientPartyId);
    const position =
      run.status === "completed" && run.openingPosition
        ? run.openingPosition
        : await computeOpeningPosition(firmId, run.clientPartyId, {
            provisional: true,
          });
    res.json(GetOnboardingOpeningPositionResponse.parse(position));
  },
);

router.post(
  "/onboarding/runs/:id/abandon",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "engagement.write");
    const params = parseOrThrow(AbandonOnboardingRunParams, req.params);
    const firmId = requireFirmScope(req.principal);
    const run = await abandonOnboardingRun(
      params.id,
      firmId,
      req.principal.userId,
    );
    res.json(AbandonOnboardingRunResponse.parse(await detailFor(req, run)));
  },
);

export default router;
