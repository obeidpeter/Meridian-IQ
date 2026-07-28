import { Router, type IRouter } from "express";
import {
  GetFirmPoliciesResponse,
  UpdateFirmPoliciesBody,
  UpdateFirmPoliciesResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  requireFirmScope,
  type Principal,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import {
  firmSubmitApprovalRequired,
  updateFirmPolicies,
} from "../modules/invoice/approvals";

// Firm governance policies (contract 0.45.0): today just the maker-checker
// submit-approval requirement (modules/invoice/approvals.ts). Reads are open
// to every firm principal — the submit UI must be able to explain WHY a
// submit will demand a colleague's approval — but writes are firm-level
// administration.
//
// Registered by the orchestrator in routes/index.ts.

// Gate: EXPLICIT firm_admin role check, not a capability (the integrations
// precedent — routes/integrations.ts firmAdminScope). Loosening the firm's
// dual-control posture is firm-level administration: firm_staff and
// client_users act UNDER the policy, they do not set it, and no capability in
// the matrix describes "govern the firm's controls" (adding one would hand it
// to every role holding a broad capability by accident). The explicit check
// also excludes machine principals by construction — an API key's synthetic
// "api_key" role can never switch the policy off around the humans it binds.
// requireFirmScope pins the write to the caller's own tenant on top of the
// firm-keyed RLS from migration 0024.
function firmAdminScope(principal: Principal): string {
  if (principal.role !== "firm_admin") {
    throw new DomainError(
      "FORBIDDEN",
      "Policy management is a firm-admin surface",
      403,
    );
  }
  return requireFirmScope(principal);
}

const router: IRouter = Router();

router.get("/firm/policies", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const firmId = requireFirmScope(req.principal);
  // No firm_policies row = every policy at its default (false).
  res.json(
    GetFirmPoliciesResponse.parse({
      submitApprovalRequired: await firmSubmitApprovalRequired(firmId),
    }),
  );
});

router.put("/firm/policies", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const parsed = parseOrThrow(UpdateFirmPoliciesBody, req.body);
  const state = await updateFirmPolicies(firmId, parsed, req.principal.userId);
  res.json(UpdateFirmPoliciesResponse.parse(state));
});

export default router;
