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
  AskClerkBody,
  AskClerkResponse,
  GetClerkMetricsQueryParams,
  GetClerkMetricsResponse,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import {
  claimCase,
  createExtractionCase,
  listCases,
  getCase,
  decideCase,
  releaseCase,
} from "../modules/clerk/cases";
import { askClerk } from "../modules/clerk/ask";
import { getClerkMetrics } from "../modules/clerk/metrics";
import { getClerkGateway } from "../modules/clerk/provider";

const router: IRouter = Router();

// Clerk copilot surface (Task #40). Everything here is operator-only
// (clerk.use) and shadow-mode: extraction proposes, the operator disposes, and
// approval can only create a DRAFT invoice. The kill switch (clerk_ai flag) is
// enforced inside the gateway and module code, so a disabled Clerk fails
// closed with 503 CLERK_DISABLED before any model call or case insert.
// Audit entries are appended by the modules themselves (they know outcomes).

router.get("/clerk/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = ListClerkCasesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await listCases(query.data);
  res.json(ListClerkCasesResponse.parse(rows));
});

router.get("/clerk/cases/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const params = GetClerkCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await getCase(params.data.id);
  res.json(GetClerkCaseResponse.parse(row));
});

router.post("/clerk/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const parsed = CreateClerkCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const gateway = await getClerkGateway();
  const row = await createExtractionCase(
    parsed.data,
    req.principal.userId,
    gateway,
  );
  res.status(201).json(CreateClerkCaseResponse.parse(row));
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

router.get("/clerk/metrics", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = GetClerkMetricsQueryParams.safeParse(req.query);
  const windowDays = query.success ? (query.data.windowDays ?? 30) : 30;
  const metrics = await getClerkMetrics(windowDays);
  res.json(GetClerkMetricsResponse.parse(metrics));
});

router.post("/clerk/ask", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const parsed = AskClerkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const gateway = await getClerkGateway();
  const row = await askClerk(parsed.data.question, req.principal.userId, gateway);
  res.json(AskClerkResponse.parse(row));
});

export default router;
