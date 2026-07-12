import { Router, type IRouter } from "express";
import {
  ListClaimRecordsQueryParams,
  ListClaimRecordsResponse,
  CreateClaimRecordBody,
  CreateClaimRecordResponse,
  SubmitClaimRecordParams,
  SubmitClaimRecordResponse,
  ApproveClaimRecordParams,
  ApproveClaimRecordBody,
  ApproveClaimRecordResponse,
  RejectClaimRecordParams,
  RejectClaimRecordBody,
  RejectClaimRecordResponse,
  SuspendClaimRecordParams,
  SuspendClaimRecordBody,
  SuspendClaimRecordResponse,
  ListClerkCasesQueryParams,
  ListClerkCasesResponse,
  CreateClerkCaseBody,
  CreateClerkCaseResponse,
  GetClerkCaseParams,
  GetClerkCaseResponse,
  ReviewClerkCaseParams,
  ReviewClerkCaseBody,
  ReviewClerkCaseResponse,
  AskClerkBody,
  AskClerkResponse,
  ExplainRejectionBody,
  ExplainRejectionResponse,
  ListClerkKillSwitchesResponse,
  SetClerkKillSwitchParams,
  SetClerkKillSwitchBody,
  SetClerkKillSwitchResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertClientPartyScope,
  assertPartyAccess,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { isFeatureEnabled } from "../modules/flags/flags";
import {
  approveClaim,
  createClaimDraft,
  listClaims,
  rejectClaim,
  submitClaimForReview,
  suspendClaim,
} from "../modules/clerk/claims";
import {
  createCase,
  getCaseDetail,
  listCases,
  reviewCase,
} from "../modules/clerk/orchestrator";
import { askClerk, explainRejection } from "../modules/clerk/answers";
import { listKillSwitches, setKillSwitch } from "../modules/clerk/gateway";
import { appendAudit } from "../modules/audit/audit";

// Clerk routes (Clerk Supplemental TRD). Everything is gated by the `clerk`
// feature flag — the whole surface is unreachable while dark (PL-02), which is
// exactly the C0/C1 posture: foundation and operator shadow work only, no
// client-visible AI before its gate.

const router: IRouter = Router();

// A pasted source has the same resource-exhaustion profile as a statement CSV;
// the OpenAPI schema also enforces this, but the check must not depend on it.
const MAX_SOURCE_CHARS = 20_000;

async function gate(req: {
  principal: import("../modules/auth/rbac").Principal;
}): Promise<boolean> {
  return isFeatureEnabled("clerk", req.principal.firmId ?? null);
}

// ---- claims register ----

router.get("/clerk/claims", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const query = ListClaimRecordsQueryParams.safeParse(req.query);
  const rows = await listClaims({
    status: query.success ? query.data.status : undefined,
    claimKey: query.success ? query.data.claimKey : undefined,
  });
  res.json(ListClaimRecordsResponse.parse(rows));
});

router.post("/clerk/claims", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "claims.write");
  const parsed = CreateClaimRecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const row = await createClaimDraft(parsed.data, {
    userId: req.principal.userId,
    role: req.principal.role,
  });
  res.json(CreateClaimRecordResponse.parse(row));
});

router.post("/clerk/claims/:id/submit", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "claims.write");
  const params = SubmitClaimRecordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await submitClaimForReview(params.data.id, {
    userId: req.principal.userId,
    role: req.principal.role,
  });
  res.json(SubmitClaimRecordResponse.parse(row));
});

router.post("/clerk/claims/:id/approve", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "claims.approve");
  const params = ApproveClaimRecordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ApproveClaimRecordBody.safeParse(req.body ?? {});
  const row = await approveClaim(
    params.data.id,
    { userId: req.principal.userId, role: req.principal.role },
    body.success ? body.data.approvalEvidence : undefined,
  );
  res.json(ApproveClaimRecordResponse.parse(row));
});

router.post("/clerk/claims/:id/reject", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "claims.approve");
  const params = RejectClaimRecordParams.safeParse(req.params);
  const body = RejectClaimRecordBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const row = await rejectClaim(
    params.data.id,
    { userId: req.principal.userId, role: req.principal.role },
    body.data.reason,
  );
  res.json(RejectClaimRecordResponse.parse(row));
});

router.post("/clerk/claims/:id/suspend", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "claims.approve");
  const params = SuspendClaimRecordParams.safeParse(req.params);
  const body = SuspendClaimRecordBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const row = await suspendClaim(
    params.data.id,
    { userId: req.principal.userId, role: req.principal.role },
    body.data.reason,
  );
  res.json(SuspendClaimRecordResponse.parse(row));
});

// ---- cases ----

function toCaseDetailView(detail: {
  caseRow: unknown;
  sources: unknown[];
  candidates: unknown[];
  decisions: unknown[];
  runs?: unknown[];
}) {
  return {
    case: detail.caseRow,
    sources: detail.sources,
    candidates: detail.candidates,
    runs: detail.runs ?? [],
    decisions: detail.decisions,
  };
}

router.post("/clerk/cases", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.case.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = CreateClerkCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.sourceText.length > MAX_SOURCE_CHARS) {
    res.status(413).json({ error: "Source is too large to process" });
    return;
  }
  await assertPartyAccess(req.principal, parsed.data.clientPartyId);
  const detail = await createCase(
    {
      firmId,
      clientPartyId: parsed.data.clientPartyId,
      sourceText: parsed.data.sourceText,
      filename: parsed.data.filename,
      language: parsed.data.language,
      priority: parsed.data.priority,
    },
    { userId: req.principal.userId, role: req.principal.role },
  );
  res.json(CreateClerkCaseResponse.parse(toCaseDetailView(detail)));
});

router.get("/clerk/cases", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const query = ListClerkCasesQueryParams.safeParse(req.query);
  let clientPartyId = query.success ? query.data.clientPartyId : undefined;
  // A client_user is confined to its own client party (SEC-03).
  if (clientPartyId) assertClientPartyScope(req.principal, clientPartyId);
  const scope = clientPartyScope(req.principal);
  if (scope) clientPartyId = scope;
  const rows = await listCases({
    firmId: tenantFirmId(req.principal),
    clientPartyId,
    state: query.success ? query.data.state : undefined,
  });
  res.json(ListClerkCasesResponse.parse(rows));
});

router.get("/clerk/cases/:id", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const params = GetClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const detail = await getCaseDetail(
    params.data.id,
    tenantFirmId(req.principal),
  );
  // A client_user only reaches its own client party's cases (SEC-03).
  assertClientPartyScope(req.principal, detail.caseRow.clientPartyId);
  res.json(GetClerkCaseResponse.parse(toCaseDetailView(detail)));
});

router.post("/clerk/cases/:id/review", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.review");
  const params = ReviewClerkCaseParams.safeParse(req.params);
  const body = ReviewClerkCaseBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const firmId = tenantFirmId(req.principal);
  await reviewCase(
    params.data.id,
    firmId,
    { userId: req.principal.userId, role: req.principal.role },
    body.data,
  );
  const detail = await getCaseDetail(params.data.id, firmId);
  res.json(ReviewClerkCaseResponse.parse(toCaseDetailView(detail)));
});

// ---- register-only answers and catalogue-grounded explanations ----

router.post("/clerk/answers", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const parsed = AskClerkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await askClerk({
    question: parsed.data.question,
    firmId: req.principal.firmId ?? null,
    actor: { userId: req.principal.userId, role: req.principal.role },
  });
  res.json(AskClerkResponse.parse(result));
});

router.post("/clerk/explain", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const parsed = ExplainRejectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await explainRejection({
    errorCode: parsed.data.errorCode,
    firmId: req.principal.firmId ?? null,
  });
  res.json(ExplainRejectionResponse.parse(result));
});

// ---- kill switches (CLK-AI-11) ----

router.get("/clerk/kill-switches", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clerk.read");
  const rows = await listKillSwitches();
  res.json(ListClerkKillSwitchesResponse.parse(rows));
});

router.post(
  "/clerk/kill-switches/:capability",
  async (req, res): Promise<void> => {
    if (!(await gate(req))) {
      res.sendStatus(404);
      return;
    }
    assertCan(req.principal, "clerk.kill");
    const params = SetClerkKillSwitchParams.safeParse(req.params);
    const body = SetClerkKillSwitchBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const allowed = ["global", "extraction", "answers", "explanation"];
    if (!allowed.includes(params.data.capability)) {
      res.status(400).json({ error: "Unknown Clerk capability" });
      return;
    }
    const row = await setKillSwitch(
      params.data.capability,
      body.data.disabled,
      body.data.reason ?? null,
      req.principal.userId,
    );
    await appendAudit({
      actorId: req.principal.userId,
      actorRole: req.principal.role,
      action: "clerk.kill_switch.changed",
      entityType: "clerk_kill_switch",
      entityId: params.data.capability,
      after: { disabled: body.data.disabled, reason: body.data.reason ?? null },
    });
    res.json(SetClerkKillSwitchResponse.parse(row));
  },
);

export default router;
