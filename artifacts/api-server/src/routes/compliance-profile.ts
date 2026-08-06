import { Router, type IRouter } from "express";
import {
  GetComplianceProfileParams,
  GetComplianceProfileResponse,
  GetComplianceProfileSummaryResponse,
  UpdateComplianceProfileParams,
  UpdateComplianceProfileBody,
  UpdateComplianceProfileResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  firmScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import {
  complianceProfileSummary,
  getClientComplianceProfile,
  upsertComplianceProfile,
} from "../modules/filings/profile";

// Client Compliance Profile (contract 0.70.0): the statutory facts a firm
// asserts about a client — evidence-only, gating the Filing Desk's mint.
// Authz posture:
//  - GET is filing.read with assertClientPartyScope (SEC-03: a client_user
//    may read ITS OWN profile — the register rows it already sees are minted
//    from it — while a sibling id is rejected before any lookup);
//  - PUT is filing.write (firm work — a client never asserts its own
//    registration status; client_user lacks the capability). The module
//    enforces the engagement wall with a 404 non-disclosure: a foreign
//    tenant's party and an unknown id are indistinguishable;
//  - the summary is the /console/filing-matrix posture exactly
//    (console.portfolio.read + firmScope) — a firm-wide adoption rollup.

const router: IRouter = Router();

router.get("/clients/:id/compliance-profile", async (req, res): Promise<void> => {
  assertCan(req.principal, "filing.read");
  const params = parseOrThrow(GetComplianceProfileParams, req.params);
  const firmId = requireFirmScope(req.principal);
  // SEC-03: pure string comparison against the principal's own party —
  // nothing is looked up (so nothing is disclosed) before the pin holds.
  assertClientPartyScope(req.principal, params.id);
  const profile = await getClientComplianceProfile(firmId, params.id);
  // The envelope keeps "no profile yet" (null — the load-bearing absence:
  // monthly VAT + PAYE mint as ever) distinct from an all-defaults profile.
  res.json(GetComplianceProfileResponse.parse({ profile }));
});

router.put("/clients/:id/compliance-profile", async (req, res): Promise<void> => {
  assertCan(req.principal, "filing.write");
  const params = parseOrThrow(UpdateComplianceProfileParams, req.params);
  const body = parseOrThrow(UpdateComplianceProfileBody, req.body);
  const firmId = requireFirmScope(req.principal);
  const row = await upsertComplianceProfile(
    firmId,
    params.id,
    body,
    req.principal.userId,
  );
  res.json(UpdateComplianceProfileResponse.parse(row));
});

router.get("/compliance-profiles/summary", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const summary = await complianceProfileSummary(firmId);
  res.json(GetComplianceProfileSummaryResponse.parse(summary));
});

export default router;
