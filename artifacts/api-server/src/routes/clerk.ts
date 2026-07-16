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
  DraftCatalogueEntryWithClerkBody,
  DraftCatalogueEntryWithClerkResponse,
  AssistMatchProposalsBody,
  AssistMatchProposalsResponse,
  DraftInvoiceWithClerkBody,
  DraftInvoiceWithClerkResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
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
import { draftCatalogueEntryWithClerk } from "../modules/clerk/draft-catalogue";
import { draftClaimWithClerk } from "../modules/clerk/draft-claim";
import { draftInvoiceWithClerk } from "../modules/clerk/draft-invoice";
import { explainInvoiceFailure } from "../modules/clerk/explain";
import { assistMatch } from "../modules/clerk/reconcile-assist";
import { requireFlag } from "../modules/flags/flags";
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
  const query = parseOrThrow(ListClerkCasesQueryParams, req.query);
  const tenant = tenantFirmId(req.principal);
  const rows = await listCases({
    ...query,
    ...(tenant ? { firmId: tenant } : {}),
    ...(req.principal.role === "client_user"
      ? { createdBy: req.principal.userId }
      : {}),
  });
  res.json(ListClerkCasesResponse.parse(rows));
});

router.get("/clerk/cases/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const params = parseOrThrow(GetClerkCaseParams, req.params);
  const row = await getCase(params.id);
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
  const parsed = parseOrThrow(CreateClerkCaseBody, req.body);
  // Budget gate BEFORE the provider is touched: an exhausted firm gets a clean
  // 429 without any model call. Operators (no tenant) are uncapped.
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const row = await createExtractionCase(
    parsed,
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
  const parsed = parseOrThrow(CreateClerkCaseBatchBody, req.body);
  // Budget gate up front like single capture; batch.ts re-checks between
  // segments so a firm can't blow far past its allowance in one upload.
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const result = await createBatchCases(parsed, req.principal.userId, gateway, {
    firmId: tenant,
  });
  res.status(201).json(CreateClerkCaseBatchResponse.parse(result));
});

router.post("/clerk/cases/:id/decision", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = parseOrThrow(DecideClerkCaseParams, req.params);
  const parsed = parseOrThrow(DecideClerkCaseBody, req.body);
  const row = await decideCase(params.id, parsed, req.principal.userId);
  res.json(DecideClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/claim", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = parseOrThrow(ClaimClerkCaseParams, req.params);
  const row = await claimCase(params.id, req.principal.userId);
  res.json(ClaimClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/release", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = parseOrThrow(ReleaseClerkCaseParams, req.params);
  const row = await releaseCase(params.id, req.principal.userId);
  res.json(ReleaseClerkCaseResponse.parse(row));
});

router.post("/clerk/cases/:id/retry", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = parseOrThrow(RetryClerkCaseParams, req.params);
  const gateway = await getClerkGateway();
  const row = await retryExtraction(
    params.id,
    req.principal.userId,
    gateway,
  );
  res.json(RetryClerkCaseResponse.parse(row));
});

router.get(
  "/clerk/cases/:id/party-suggestions",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "clerk.use");
    const params = parseOrThrow(GetClerkPartySuggestionsParams, req.params);
    const suggestions = await suggestPartiesForCase(params.id);
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
  const parsed = parseOrThrow(AskClerkBody, req.body);
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const row = await askClerk(parsed.question, req.principal.userId, gateway, {
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
  const parsed = parseOrThrow(ExplainInvoiceFailureBody, req.body);
  const gateway = await getClerkGateway();
  const explanation = await explainInvoiceFailure(
    parsed.invoiceId,
    req.principal,
    gateway,
  );
  res.json(ExplainInvoiceFailureResponse.parse(explanation));
});

// Reconciliation match assist (idea #2): explains one statement line's
// pending candidates. Ranking and highlights are computed from the matcher's
// recorded features; Clerk only phrases the comparison and the deterministic
// template text answers whenever it can't — this never errors for
// AI-availability reasons.
router.post(
  "/clerk/reconciliation-assist",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.read");
    const parsed = parseOrThrow(AssistMatchProposalsBody, req.body);
    // Best-effort gateway: no provider configured still explains via the
    // template path (digest posture), unlike the fail-closed capture routes.
    let gateway = null;
    try {
      gateway = await getClerkGateway();
    } catch {
      gateway = null;
    }
    const result = await assistMatch(
      parsed.statementLineId,
      req.principal,
      gateway,
    );
    res.json(AssistMatchProposalsResponse.parse(result));
  },
);

// Natural-language invoice drafting (idea #7): one sentence in, a prefilled
// draft-form proposal out. Nothing is stored and no invoice is created — the
// client reviews the form and saves through the ordinary createDraft path.
router.post("/clerk/draft-invoice", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = parseOrThrow(DraftInvoiceWithClerkBody, req.body);
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const result = await draftInvoiceWithClerk(
    parsed.text,
    req.principal,
    gateway,
  );
  res.json(DraftInvoiceWithClerkResponse.parse(result));
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
  const parsed = parseOrThrow(DraftClaimWithClerkBody, req.body);
  const gateway = await getClerkGateway();
  const row = await draftClaimWithClerk(
    parsed.sourceText,
    req.principal.userId,
    gateway,
  );
  res.status(201).json(DraftClaimWithClerkResponse.parse(row));
});

// Catalogue drafting assistant (idea #3): Clerk proposes an error-catalogue
// entry grounded in the raw rail rejections observed for the code. The draft
// is RETURNED for the operator to edit — saving still goes through the
// ordinary catalogue.write routes, so the human disposes and the audit trail
// is theirs. Runs outside the request transaction (NO_CONTEXT_ROUTES) like
// every model-calling Clerk path.
router.post("/clerk/catalogue-draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const parsed = parseOrThrow(DraftCatalogueEntryWithClerkBody, req.body);
  const gateway = await getClerkGateway();
  const draft = await draftCatalogueEntryWithClerk(parsed.code, gateway);
  res.json(DraftCatalogueEntryWithClerkResponse.parse(draft));
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
