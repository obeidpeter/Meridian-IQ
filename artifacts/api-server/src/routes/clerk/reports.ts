import { Router, type IRouter } from "express";
import {
  GetClerkMetricsQueryParams,
  GetClerkMetricsResponse,
  GetClerkUsageResponse,
  GetClerkTierReportResponse,
  GetClerkDigestResponse,
  ListClientStatementsQueryParams,
  ListClientStatementsResponse,
  GetClerkClaimGapsQueryParams,
  GetClerkClaimGapsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  clientPartyScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import {
  budgetPace,
  firmClerkUsage,
  firmClerkUsageByPurpose,
} from "../../modules/clerk/budget";
import { latestDigestForFirm } from "../../modules/clerk/digest";
import { listClientStatements } from "../../modules/clerk/client-statement";
import { DomainError } from "../../modules/errors";
import { computeTierReport } from "../../modules/clerk/tier-report";
import { getClerkMetrics } from "../../modules/clerk/metrics";
import { computeClaimGaps } from "../../modules/clerk/claim-gaps";

const router: IRouter = Router();

router.get("/clerk/metrics", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = GetClerkMetricsQueryParams.safeParse(req.query);
  const windowDays = query.success ? (query.data.windowDays ?? 30) : 30;
  const metrics = await getClerkMetrics(windowDays);
  res.json(GetClerkMetricsResponse.parse(metrics));
});

// Claim-gap mining: refused Ask Clerk questions clustered by their stored
// refusal cause, plus the newest questions no approved claim covers — the
// register's demand signal. Deterministic (pure SQL + string matching, zero
// model calls); same operator gate and lenient window parse as the metrics.
router.get("/clerk/claim-gaps", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const query = GetClerkClaimGapsQueryParams.safeParse(req.query);
  const windowDays = query.success ? (query.data.windowDays ?? 90) : 90;
  const report = await computeClaimGaps(windowDays);
  res.json(GetClerkClaimGapsResponse.parse(report));
});

// Tier-suggestion report (round-9 idea #3): pure ledger SQL joined with the
// tier map in force — the evidence for (and against) CLERK_MODEL_TIERS
// changes. Operator surface, zero model calls.
router.get("/clerk/tier-report", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.use");
  const report = await computeTierReport();
  res.json(GetClerkTierReportResponse.parse(report));
});

// The firm's latest weekly digest (power D). Facts are SQL-computed; the
// narrative is Clerk-phrased or template text (see modules/clerk/digest).
// Generation happens on the sweep (opt-in clerk_digest flag) — this endpoint
// only reads, so it never spends tokens.
router.get("/clerk/digest", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.ask");
  // The weekly digest is a FIRM-INTERNAL surface: its facts span the whole
  // client book (chase counts, unmatched credits, firm money summary).
  // clerk.ask was widened to client_user for Ask only, NOT for this — a
  // client principal is refused explicitly (SEC-03), capability or not.
  if (req.principal.role === "client_user") {
    throw new DomainError(
      "FORBIDDEN",
      "The weekly digest is a firm-internal surface",
      403,
    );
  }
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    throw new DomainError(
      "NO_TENANT",
      "A firm scope is required for the digest",
      400,
    );
  }
  const digest = await latestDigestForFirm(tenant);
  if (!digest) {
    res.status(404).json({ error: "No digest has been generated yet" });
    return;
  }
  res.json(GetClerkDigestResponse.parse(digest));
});

// Per-client monthly statements (idea #5). Read-only (generation is on the
// opt-in clerk_client_statements sweep), gated on clerk.capture so the CLIENT
// whose month it is can read their own. A client_user is pinned to its own
// party (SEC-03); a firm principal names the client via query and is bounded
// by firm-keyed RLS. Firm RLS is not a sibling wall, so the party is enforced
// here regardless.
router.get("/clerk/client-statements", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const query = parseOrThrow(ListClientStatementsQueryParams, req.query);
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    throw new DomainError(
      "NO_TENANT",
      "A firm scope is required for client statements",
      400,
    );
  }
  // A client_user resolves to its OWN party whatever the query says; a firm
  // principal must name the client. assertClientPartyScope is the SEC-03 wall
  // (no-op for firm principals, 403 for a client_user naming another party).
  const target = clientPartyScope(req.principal) ?? query.clientPartyId;
  if (!target) {
    throw new DomainError(
      "MISSING_CLIENT",
      "clientPartyId is required",
      400,
    );
  }
  assertClientPartyScope(req.principal, target);
  const rows = await listClientStatements(tenant, target);
  res.json(ListClientStatementsResponse.parse(rows));
});

// The firm's month-to-date Clerk consumption against its allowance, for the
// usage meter on the client-facing surfaces. Firm-scoped by construction.
router.get("/clerk/usage", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    throw new DomainError(
      "NO_TENANT",
      "A firm scope is required for Clerk usage",
      400,
    );
  }
  const usage = await firmClerkUsage(tenant);
  // Per-purpose split of the same month window — which feature is spending
  // the allowance. monthStart comes from the usage read so the two queries
  // can never straddle a month boundary.
  const byPurpose = await firmClerkUsageByPurpose(tenant, usage.monthStart);
  // Budget pace (idea #7): the same numbers the 429 gate uses, projected to
  // month end so the usage meters can warn before the cliff.
  res.json(
    GetClerkUsageResponse.parse({ ...usage, ...budgetPace(usage), byPurpose }),
  );
});

export default router;
