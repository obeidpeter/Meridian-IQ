import { Router, type IRouter } from "express";
import {
  ListClerkCasesQueryParams,
  ListClerkCasesResponse,
  CreateClerkCaseBody,
  CreateClerkCaseResponse,
  GetClerkCaseParams,
  GetClerkCaseResponse,
  DecideClerkCaseParams,
  DecideClerkCaseBody,
  DecideClerkCaseResponse,
  ClaimClerkCaseParams,
  ClaimClerkCaseResponse,
  ReleaseClerkCaseParams,
  ReleaseClerkCaseResponse,
  RetryClerkCaseParams,
  RetryClerkCaseResponse,
  GetClerkPartySuggestionsParams,
  GetClerkPartySuggestionsResponse,
  RunClerkEvalResponse,
  ListClerkEvalRunsQueryParams,
  ListClerkEvalRunsResponse,
  AskClerkBody,
  AskClerkResponse,
  GetClerkMetricsQueryParams,
  GetClerkMetricsResponse,
  GetClerkUsageResponse,
  ExplainInvoiceFailureBody,
  ExplainInvoiceFailureResponse,
  CreateClerkCaseBatchBody,
  CreateClerkCaseBatchResponse,
  GetClerkDigestResponse,
  DraftClaimWithClerkBody,
  DraftClaimWithClerkResponse,
} from "@workspace/api-zod";
import { assertCan, tenantFirmId } from "../modules/auth/rbac";
import {
  assertFirmClerkBudget,
  firmClerkUsage,
} from "../modules/clerk/budget";
import {
  claimCase,
  createExtractionCase,
  listCases,
  getCase,
  decideCase,
  releaseCase,
  retryExtraction,
} from "../modules/clerk/cases";
import { askClerk } from "../modules/clerk/ask";
import { createBatchCases } from "../modules/clerk/batch";
import { latestDigestForFirm } from "../modules/clerk/digest";
import { draftClaimWithClerk } from "../modules/clerk/draft-claim";
import { explainInvoiceFailure } from "../modules/clerk/explain";
import { getClerkMetrics } from "../modules/clerk/metrics";
import { getClerkGateway } from "../modules/clerk/provider";
import { suggestPartiesForCase } from "../modules/clerk/party-match";
import {
  listEvalRuns,
  runEvalCorpus,
  withAccuracy,
} from "../modules/clerk/eval";

const router: IRouter = Router();

// Clerk copilot surface (Task #40 + expansion A). Shadow-mode throughout:
// extraction proposes, a human disposes, and approval can only create a DRAFT
// invoice. Capture (clerk.capture) and Ask (clerk.ask) are open to firm
// principals — pinned to their firm (route filters + the 0009 RLS policy),
// with a client_user further narrowed to cases it submitted itself — and are
// budget-capped per firm BEFORE any provider work. Review/decide/claim/retry,
// evals, metrics and party suggestions stay operator-only (clerk.use). The
// kill switch (clerk_ai flag) is enforced inside the gateway and module code,
// so a disabled Clerk fails closed with 503 CLERK_DISABLED before any model
// call or case insert. Audit entries are appended by the modules themselves.

router.get("/clerk/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const query = ListClerkCasesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const tenant = tenantFirmId(req.principal);
  const rows = await listCases({
    ...query.data,
    ...(tenant ? { firmId: tenant } : {}),
    ...(req.principal.role === "client_user"
      ? { createdBy: req.principal.userId }
      : {}),
  });
  res.json(ListClerkCasesResponse.parse(rows));
});

router.get("/clerk/cases/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const params = GetClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await getCase(params.data.id);
  // Firm principals only see their firm's cases; a client_user only its own
  // submissions. Same 404 as not-found so existence is not disclosed.
  const tenant = tenantFirmId(req.principal);
  if (
    (tenant && row.firmId !== tenant) ||
    (req.principal.role === "client_user" &&
      row.createdBy !== req.principal.userId)
  ) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  res.json(GetClerkCaseResponse.parse(row));
});

router.post("/clerk/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = CreateClerkCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Budget gate BEFORE the provider is touched: an exhausted firm gets a clean
  // 429 without any model call. Operators (no tenant) are uncapped.
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const row = await createExtractionCase(
    parsed.data,
    req.principal.userId,
    gateway,
    undefined,
    { firmId: tenant },
  );
  res.status(201).json(CreateClerkCaseResponse.parse(row));
});

// Batch intake (power S): one upload with several invoices → one case per
// invoice, via the same createExtractionCase path as single capture (same
// duplicate guard, extraction, pre-flight and human review).
router.post("/clerk/cases/batch", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = CreateClerkCaseBatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Budget gate up front like single capture; batch.ts re-checks between
  // segments so a firm can't blow far past its allowance in one upload.
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const result = await createBatchCases(parsed.data, req.principal.userId, gateway, {
    firmId: tenant,
  });
  res.status(201).json(CreateClerkCaseBatchResponse.parse(result));
});

router.post("/clerk/cases/:id/decision", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = DecideClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DecideClerkCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const row = await decideCase(params.data.id, parsed.data, req.principal.userId);
  res.json(DecideClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/claim", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = ClaimClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await claimCase(params.data.id, req.principal.userId);
  res.json(ClaimClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/release", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = ReleaseClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await releaseCase(params.data.id, req.principal.userId);
  res.json(ReleaseClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/retry", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = RetryClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const gateway = await getClerkGateway();
  const row = await retryExtraction(
    params.data.id,
    req.principal.userId,
    gateway,
  );
  res.json(RetryClerkCaseResponse.parse(row));
});

router.get(
  "/clerk/cases/:id/party-suggestions",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "clerk.use");
    const params = GetClerkPartySuggestionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const suggestions = await suggestPartiesForCase(params.data.id);
    res.json(GetClerkPartySuggestionsResponse.parse(suggestions));
  },
);

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

router.get("/clerk/metrics", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = GetClerkMetricsQueryParams.safeParse(req.query);
  const windowDays = query.success ? (query.data.windowDays ?? 30) : 30;
  const metrics = await getClerkMetrics(windowDays);
  res.json(GetClerkMetricsResponse.parse(metrics));
});

router.post("/clerk/ask", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.ask");
  const parsed = AskClerkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const row = await askClerk(parsed.data.question, req.principal.userId, gateway, {
    firmId: tenant,
  });
  res.json(AskClerkResponse.parse(row));
});

// Grounded failure explainer (expansion C): catalogue cause/fix for the
// invoice's latest failed attempt, Clerk-phrased when available. Falls back to
// the catalogue text itself when the kill switch or budget says no, so this
// never errors for AI-availability reasons.
router.post("/clerk/explain-failure", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.ask");
  const parsed = ExplainInvoiceFailureBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const gateway = await getClerkGateway();
  const explanation = await explainInvoiceFailure(
    parsed.data.invoiceId,
    req.principal,
    gateway,
  );
  res.json(ExplainInvoiceFailureResponse.parse(explanation));
});

// The firm's latest weekly digest (power D). Facts are SQL-computed; the
// narrative is Clerk-phrased or template text (see modules/clerk/digest).
// Generation happens on the sweep (opt-in clerk_digest flag) — this endpoint
// only reads, so it never spends tokens.
router.get("/clerk/digest", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.ask");
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    res.status(400).json({ error: "A firm scope is required for the digest" });
    return;
  }
  const digest = await latestDigestForFirm(tenant);
  if (!digest) {
    res.status(404).json({ error: "No digest has been generated yet" });
    return;
  }
  res.json(GetClerkDigestResponse.parse(digest));
});

// Claims drafting assistant (power C5): operator pastes a statutory excerpt,
// Clerk structures a DRAFT register entry. Maker-checker is untouched — the
// caller is the maker and can never approve the version it drafted.
router.post("/clerk/claims/draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const parsed = DraftClaimWithClerkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const gateway = await getClerkGateway();
  const row = await draftClaimWithClerk(
    parsed.data.sourceText,
    req.principal.userId,
    gateway,
  );
  res.status(201).json(DraftClaimWithClerkResponse.parse(row));
});

// The firm's month-to-date Clerk consumption against its allowance, for the
// usage meter on the client-facing surfaces. Firm-scoped by construction.
router.get("/clerk/usage", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    res.status(400).json({ error: "A firm scope is required for Clerk usage" });
    return;
  }
  res.json(GetClerkUsageResponse.parse(await firmClerkUsage(tenant)));
});

export default router;
