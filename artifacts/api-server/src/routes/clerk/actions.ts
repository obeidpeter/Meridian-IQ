import { Router, type IRouter } from "express";
import { runRequestContext } from "@workspace/db";
import {
  GetActionProposalsQueryParams,
  GetActionProposalsResponse,
  ExecuteActionBody,
  ExecuteActionResponse,
  GetActionDecisionsQueryParams,
  GetActionDecisionsResponse,
  GetActionEffectivenessQueryParams,
  GetClientAutomationEvidenceQueryParams,
  GetClientAutomationEvidenceResponse,
  GetActionEffectivenessResponse,
  GetActionPoliciesQueryParams,
  GetActionPoliciesResponse,
  GrantActionPolicyBody,
  GrantActionPolicyResponse,
  PauseActionPolicyParams,
  PauseActionPolicyResponse,
  ResumeActionPolicyParams,
  ResumeActionPolicyResponse,
  RevokeActionPolicyParams,
  RevokeActionPolicyResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { resolveClientAnalyticsScope } from "../../lib/client-scope";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
} from "../../modules/auth/rbac";
import {
  executeAction,
  listActionDecisions,
  listActionProposals,
} from "../../modules/clerk/actions";
import {
  grantActionPolicy,
  listActionPolicies,
  pauseActionPolicy,
  resumeActionPolicy,
  revokeActionPolicy,
} from "../../modules/clerk/action-policies";
import { computeActionEffectiveness } from "../../modules/clerk/action-effectiveness";
import { computeAutomationEvidence } from "../../modules/clerk/automation-evidence";

// Proposed actions (rounds 21-22): Clerk assembles a batch, a HUMAN
// approves it, and approval executes through the platform's existing
// per-invoice machinery. The authz choices:
//  - proposals and decisions are READ surfaces (invoice.read) — they reveal
//    nothing the invoice list doesn't already show;
//  - executing a SUBMIT kind requires invoice.submit — approving a Clerk
//    batch IS submitting, so it carries exactly the capability a manual
//    submit does (and maker-checker still bites per invoice inside
//    submitInvoice); a draft_chasers batch submits nothing and carries the
//    chaser surface's own capability, clerk.capture;
//  - all three resolve the client through resolveClientAnalyticsScope
//    (SEC-03): a client_user is pinned to its own party, a firm principal
//    names the client.
// The execute route runs OUTSIDE the request transaction (app.ts
// NO_CONTEXT_ROUTES — a chaser batch makes sequential model calls, and the
// per-target commits keep the global audit lock short); the module manages
// its own short firm-bound transactions.
// The opt-in clerk_actions flag is enforced inside the module (dark →
// proposals answer empty, execution refuses 503).

const router: IRouter = Router();

router.get("/clerk/action-proposals", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetActionProposalsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const proposals = await listActionProposals(firmId, clientPartyId);
  res.json(GetActionProposalsResponse.parse(proposals));
});

router.post(
  "/clerk/action-proposals/execute",
  async (req, res): Promise<void> => {
    const body = parseOrThrow(ExecuteActionBody, req.body);
    // The capability matches what the batch DOES: submitting paper needs
    // invoice.submit; drafting reminder text needs clerk.capture (the
    // single draft-chaser route's own gate).
    assertCan(
      req.principal,
      body.kind === "draft_chasers" ? "clerk.capture" : "invoice.submit",
    );
    const { firmId, clientPartyId } = resolveClientAnalyticsScope(
      req.principal,
      body.clientPartyId,
    );
    // Parity with the manual bulk-submit route: the party must be reachable
    // by this principal (cross-tenant IDOR wall), not just consent-refused.
    // This route runs OUTSIDE the request transaction, so the lookup gets
    // its own short firm-bound context (the raw pool has no GUCs — RLS
    // would blank the engagement read and false-deny).
    await runRequestContext({ bypass: false, firmId }, () =>
      assertPartyAccess(req.principal, clientPartyId),
    );
    const result = await executeAction(
      firmId,
      clientPartyId,
      req.principal.userId,
      body.kind,
      body.invoiceIds,
      req.principal,
    );
    res.json(ExecuteActionResponse.parse(result));
  },
);

router.get("/clerk/action-decisions", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetActionDecisionsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const decisions = await listActionDecisions(firmId, clientPartyId);
  res.json(GetActionDecisionsResponse.parse({ decisions }));
});

// Standing approvals (round 28). Unlike execute, these run INSIDE the
// ordinary request transaction — no model calls, single-row writes. The
// authz choices: reading grants is invoice.read (they reveal less than the
// proposals themselves); granting/pausing/resuming/revoking is
// invoice.submit — a standing approval IS a submission authorization, and
// the automatable kinds are exactly the submit kinds (draft_chasers cannot
// be automated, so clerk.capture never enters). The module re-validates the
// grantor's rights on every sweep run, so authz here is necessary but not
// durable by itself.

// Round 29: the accountability read — whether the client's approved batches
// WORKED. Pure ledger SQL (invoice.read, the decisions surface's own gate),
// in-transaction, nothing stored.
router.get(
  "/clerk/action-effectiveness",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    const query = parseOrThrow(GetActionEffectivenessQueryParams, req.query);
    const { firmId, clientPartyId } = resolveClientAnalyticsScope(
      req.principal,
      query.clientPartyId,
    );
    const report = await computeActionEffectiveness(
      firmId,
      clientPartyId,
      query.windowDays,
    );
    res.json(GetActionEffectivenessResponse.parse(report));
  },
);

// Phase 2 (round 37): the evidence backtest narrowed to ONE client — the
// grant dialogs' consent-quality read. Same resolver, same gate, same
// nothing-stored posture as the effectiveness read above; the firm-wide
// twin stays behind console.portfolio.read on the portfolio page.
router.get(
  "/clerk/client-automation-evidence",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    const query = parseOrThrow(
      GetClientAutomationEvidenceQueryParams,
      req.query,
    );
    const { firmId, clientPartyId } = resolveClientAnalyticsScope(
      req.principal,
      query.clientPartyId,
    );
    const evidence = await computeAutomationEvidence(
      firmId,
      new Date(),
      clientPartyId,
    );
    res.json(GetClientAutomationEvidenceResponse.parse(evidence));
  },
);

router.get("/clerk/action-policies", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetActionPoliciesQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const result = await listActionPolicies(firmId, clientPartyId);
  res.json(GetActionPoliciesResponse.parse(result));
});

router.post("/clerk/action-policies", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const body = parseOrThrow(GrantActionPolicyBody, req.body);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    body.clientPartyId,
  );
  // The execute route's IDOR wall, same reason: the party must be reachable
  // by this principal, not just consent-refused. In-transaction here, so
  // the ambient context serves the engagement read.
  await assertPartyAccess(req.principal, clientPartyId);
  const policy = await grantActionPolicy(
    firmId,
    clientPartyId,
    req.principal,
    body.kind,
    body.maxTargetsPerRun,
  );
  res.json(GrantActionPolicyResponse.parse(policy));
});

// The lifecycle mutations resolve the client through the POLICY ROW itself
// (the module loads it under ambient RLS and applies the SEC-03 wall), so
// they take no clientPartyId — the id names the grant.
router.post(
  "/clerk/action-policies/:id/pause",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(PauseActionPolicyParams, req.params);
    const policy = await pauseActionPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(PauseActionPolicyResponse.parse(policy));
  },
);

router.post(
  "/clerk/action-policies/:id/resume",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(ResumeActionPolicyParams, req.params);
    const policy = await resumeActionPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(ResumeActionPolicyResponse.parse(policy));
  },
);

router.post(
  "/clerk/action-policies/:id/revoke",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const params = parseOrThrow(RevokeActionPolicyParams, req.params);
    const policy = await revokeActionPolicy(
      requireFirmScope(req.principal),
      params.id,
      req.principal,
    );
    res.json(RevokeActionPolicyResponse.parse(policy));
  },
);

export default router;
