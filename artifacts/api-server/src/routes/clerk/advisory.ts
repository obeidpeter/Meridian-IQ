import { Router, type IRouter } from "express";
import {
  GenerateAdvisoryBriefBody,
  GenerateAdvisoryBriefResponse,
  ListAdvisoryBriefsQueryParams,
  ListAdvisoryBriefsResponse,
} from "@workspace/api-zod";
import type { ClerkAdvisoryBriefRow } from "@workspace/db";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { DomainError } from "../../modules/errors";
import { gatewayOrNull } from "../../modules/clerk/provider";
import {
  generateAdvisoryBrief,
  listAdvisoryBriefs,
} from "../../modules/clerk/advisory-brief";

// Advise with Clerk, Phase 1 (round 49): the per-client advisory brief.
// Generation is FIRM work product (engagement.write — firm_admin/firm_staff;
// a client never triggers the firm's advisory spend); reading follows the
// client-statement route's exact SEC-03 shape: a client_user is pinned to
// its own party, a firm principal names the client. Digest posture: the
// generate route makes at most ONE in-transaction completion (mirrored in
// the MODEL rate-limit class), and an unavailable provider degrades to the
// template note — never an error.

const router: IRouter = Router();

const briefView = (
  row: ClerkAdvisoryBriefRow & { clientName: string },
): Record<string, unknown> => ({
  id: row.id,
  clientPartyId: row.clientPartyId,
  clientName: row.clientName,
  monthStart: row.monthStart,
  headline: row.headline,
  note: row.note,
  source: row.source,
  sections: row.sections,
  updatedAt: row.updatedAt,
});

router.get("/clerk/advisory-briefs", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const query = parseOrThrow(ListAdvisoryBriefsQueryParams, req.query);
  // The client-statements route's exact resolution: firm principals use
  // their tenant; a cross-tenant operator falls back to a bound firm.
  const tenant = tenantFirmId(req.principal) ?? req.principal.firmId;
  if (!tenant) {
    throw new DomainError(
      "NO_TENANT",
      "A firm scope is required for advisory briefs",
      400,
    );
  }
  // A client_user resolves to its OWN party whatever the query says; a firm
  // principal must name the client. assertClientPartyScope is the SEC-03
  // wall (no-op for firm principals, 403 for a client_user naming another
  // party).
  const target = clientPartyScope(req.principal) ?? query.clientPartyId;
  if (!target) {
    throw new DomainError("MISSING_CLIENT", "clientPartyId is required", 400);
  }
  assertClientPartyScope(req.principal, target);
  const rows = await listAdvisoryBriefs(tenant, target);
  res.json(ListAdvisoryBriefsResponse.parse(rows.map(briefView)));
});

router.post("/clerk/advisory-briefs", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const body = parseOrThrow(GenerateAdvisoryBriefBody, req.body);
  // Generation writes into a firm's tenant, so a cross-tenant principal is
  // rejected outright (the requireFirmScope rule).
  const firmId = requireFirmScope(req.principal);
  // Template posture end to end: an unconfigured provider integration must
  // yield the template note, not a 500 (the digest/narrative route guard).
  const gateway = await gatewayOrNull();
  await generateAdvisoryBrief(
    firmId,
    body.clientPartyId,
    gateway,
    req.principal.userId,
  );
  // The upserted brief IS the newest row for this client — re-read through
  // the same joined view the list serves, so both routes speak one shape.
  const [latest] = await listAdvisoryBriefs(firmId, body.clientPartyId, 1);
  res.json(GenerateAdvisoryBriefResponse.parse(briefView(latest)));
});

export default router;
