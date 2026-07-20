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
  CreateClerkCaseBatchBody,
  CreateClerkCaseBatchResponse,
  BulkApproveClerkCasesBody,
  BulkApproveClerkCasesResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  clientPartyScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { assertFirmClerkBudget } from "../../modules/clerk/budget";
import {
  claimCase,
  createExtractionCase,
  listCases,
  getCase,
  decideCase,
  releaseCase,
  retryExtraction,
} from "../../modules/clerk/cases";
import { bulkApproveCases } from "../../modules/clerk/bulk-approve";
import { createBatchCases } from "../../modules/clerk/batch";
import { getClerkGateway } from "../../modules/clerk/provider";
import { suggestPartiesForCase } from "../../modules/clerk/party-match";

const router: IRouter = Router();

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
    {
      firmId: tenant,
      clientScoped: req.principal.role === "client_user",
      clientPartyId: clientPartyScope(req.principal),
    },
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
    clientScoped: req.principal.role === "client_user",
    clientPartyId: clientPartyScope(req.principal),
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

// Fast-lane bulk approval: a human-initiated batch of APPROVALS over cases
// the server re-verifies as fast-lane eligible (extracted, clean pre-flight,
// confident critical fields) — the per-case machinery (decideCase's CAS,
// audit rows, draft-only invariant) runs unchanged per item; the batch adds
// iteration and per-row outcomes only. Operator-gated like single decisions.
// No model call, but the batch runs OUTSIDE the request transaction
// (NO_CONTEXT_ROUTES): each item commits in its own short bypass transaction
// (bulk-approve.ts), so the global audit advisory lock is held per item —
// never across a 50-item batch — and a decided item stays decided even if a
// later item fails, exactly like bulk-submit.
router.post("/clerk/cases/bulk-approve", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const parsed = parseOrThrow(BulkApproveClerkCasesBody, req.body);
  const report = await bulkApproveCases(parsed.items, req.principal.userId);
  res.json(BulkApproveClerkCasesResponse.parse(report));
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

// Retry re-runs a FULL extraction (up to a 4-page vision call) on the stored
// source, so like first-time capture it runs outside the request transaction
// (app.ts NO_CONTEXT_ROUTE_PATTERNS — the parameterized-path variant of
// NO_CONTEXT_ROUTES): the module's writes commit in their own short
// transactions and the audit row on the raw pool.
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

export default router;
