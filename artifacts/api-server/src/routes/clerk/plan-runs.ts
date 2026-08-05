import { Router, type IRouter } from "express";
import {
  CreatePlanRunBody,
  CreatePlanRunResponse,
  GetPlanRunParams,
  GetPlanRunResponse,
  ListPlanRunsResponse,
} from "@workspace/api-zod";
import type { ClerkPlanRun } from "@workspace/db";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { DomainError } from "../../modules/errors";
import {
  createPlanRunFromCase,
  createPlanRunFromTemplate,
  getPlanRun,
  listPlanRuns,
} from "../../modules/clerk/plan-runs";

const router: IRouter = Router();

// ---- Do with Clerk Phase 2 (round 32): plan runs ----
// The route only QUEUES (202): the whole-plan approval freezes the steps
// server-side and the pipeline worker executes them, one decision-ledger
// row per step; the UI polls the run row. Per-kind capabilities are
// asserted by the module (the same gates the execute route enforces), and
// creation runs OUTSIDE the request transaction (NO_CONTEXT_ROUTES) — the
// module manages its own short scopes, exactly like the actions execute
// route.

const stripRun = (r: ClerkPlanRun) => ({
  id: r.id,
  firmId: r.firmId,
  caseId: r.caseId,
  templateKey: r.templateKey,
  status: r.status,
  steps: r.steps.map((s) => ({
    kind: s.kind,
    clientPartyId: s.clientPartyId,
    clientName: s.clientName,
    targetCount: s.invoiceIds.length,
    status: s.status,
    decisionId: s.decisionId,
    executedCount: s.executedCount,
    failedCount: s.failedCount,
    skippedCount: s.skippedCount,
  })),
  processedSteps: r.processedSteps,
  haltReason: r.haltReason,
  approvedBy: r.approvedBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

router.post("/clerk/plan-runs", async (req, res): Promise<void> => {
  // The floor gate: every plan step's kind re-asserts its own execute
  // capability in the module; clerk.ask is what every approver holds and
  // marks this as a Clerk surface.
  assertCan(req.principal, "clerk.ask");
  const parsed = parseOrThrow(CreatePlanRunBody, req.body);
  // Exactly one origin: an Ask case, or a template + client.
  if (parsed.caseId && (parsed.templateKey || parsed.clientPartyId)) {
    throw new DomainError(
      "BAD_ORIGIN",
      "Pass either caseId or templateKey+clientPartyId, not both",
      400,
    );
  }
  if (!parsed.caseId && !(parsed.templateKey && parsed.clientPartyId)) {
    throw new DomainError(
      "BAD_ORIGIN",
      "Pass caseId, or templateKey with clientPartyId",
      400,
    );
  }
  const run = parsed.caseId
    ? await createPlanRunFromCase(parsed.caseId, req.principal)
    : await createPlanRunFromTemplate(
        parsed.templateKey!,
        parsed.clientPartyId!,
        req.principal,
      );
  res.status(202).json(CreatePlanRunResponse.parse(stripRun(run)));
});

router.get("/clerk/plan-runs", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const runs = await listPlanRuns(req.principal);
  res.json(ListPlanRunsResponse.parse({ runs: runs.map(stripRun) }));
});

router.get("/clerk/plan-runs/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetPlanRunParams, req.params);
  const run = await getPlanRun(params.id, req.principal);
  // 404, not 403: a cross-tenant (or sibling-client) id must be
  // indistinguishable from a nonexistent one.
  if (!run) throw new DomainError("NOT_FOUND", "Plan run not found", 404);
  res.json(GetPlanRunResponse.parse(stripRun(run)));
});

export default router;
