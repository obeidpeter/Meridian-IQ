import { Router, type IRouter } from "express";
import {
  GetAutomationEvidenceResponse,
  GetAutomationRollupResponse,
  GetPlanPoliciesQueryParams,
  GetPlanPoliciesResponse,
  GrantPlanPolicyBody,
  GrantPlanPolicyResponse,
  PausePlanPolicyParams,
  PausePlanPolicyResponse,
  ResumePlanPolicyParams,
  ResumePlanPolicyResponse,
  RevokePlanPolicyParams,
  RevokePlanPolicyResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
} from "../../modules/auth/rbac";
import { resolveClientAnalyticsScope } from "../../lib/client-scope";
import {
  grantPlanPolicy,
  listPlanPolicies,
  pausePlanPolicy,
  resumePlanPolicy,
  revokePlanPolicy,
} from "../../modules/clerk/plan-policies";
import { computeAutomationRollup } from "../../modules/clerk/automation-rollup";
import { computeAutomationEvidence } from "../../modules/clerk/automation-evidence";

const router: IRouter = Router();

// ---- Do with Clerk Phase 3 (round 33): recurring plan policies ----
// The action-policy routes' exact posture: reads on invoice.read, grants and
// lifecycle mutations on invoice.submit (granting a template that also
// drafts is still, at its heart, a standing SUBMISSION authorization),
// client resolution via resolveClientAnalyticsScope, the IDOR wall
// in-transaction on the grant, and the SEC-03 wall in the module.

router.get("/clerk/plan-policies", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetPlanPoliciesQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const result = await listPlanPolicies(firmId, clientPartyId);
  res.json(GetPlanPoliciesResponse.parse(result));
});

router.post("/clerk/plan-policies", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const body = parseOrThrow(GrantPlanPolicyBody, req.body);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    body.clientPartyId,
  );
  await assertPartyAccess(req.principal, clientPartyId);
  const policy = await grantPlanPolicy(
    firmId,
    clientPartyId,
    req.principal,
    body.templateKey,
  );
  res.json(GrantPlanPolicyResponse.parse(policy));
});

router.post(
  "/clerk/plan-policies/:id/pause",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(PausePlanPolicyParams, req.params);
    const policy = await pausePlanPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(PausePlanPolicyResponse.parse(policy));
  },
);

router.post(
  "/clerk/plan-policies/:id/resume",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(ResumePlanPolicyParams, req.params);
    const policy = await resumePlanPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(ResumePlanPolicyResponse.parse(policy));
  },
);

router.post(
  "/clerk/plan-policies/:id/revoke",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(RevokePlanPolicyParams, req.params);
    const policy = await revokePlanPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(RevokePlanPolicyResponse.parse(policy));
  },
);

// The firm-wide automation posture in one read: live/paused policy counts
// (both kinds, pauses by reason), plan runs and decisions over 30 days.
// Gated on console.portfolio.read, NOT invoice.read: client_users hold
// invoice.read but must never see the firm's cross-client automation
// footprint (the GET /clerk/digest refusal rule), and the consuming
// surface is the firm-staff portfolio page, which carries this exact
// capability.
router.get("/clerk/automation-rollup", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const rollup = await computeAutomationRollup(
    requireFirmScope(req.principal),
  );
  res.json(GetAutomationRollupResponse.parse(rollup));
});

// Prove with Clerk Phase 1 (round 36): the backtest evidence behind the
// dark automation flags — per-kind agreement between what each automation
// kind would have done and what humans later did, plus the act-now counts.
// Same posture as the rollup above and for the same reason: a firm-internal
// cross-client aggregate on console.portfolio.read, firm resolved from the
// principal with no client param to widen. Deterministic ledger SQL + pure
// replay; zero model calls; nothing stored.
router.get("/clerk/automation-evidence", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const evidence = await computeAutomationEvidence(
    requireFirmScope(req.principal),
  );
  res.json(GetAutomationEvidenceResponse.parse(evidence));
});

export default router;
