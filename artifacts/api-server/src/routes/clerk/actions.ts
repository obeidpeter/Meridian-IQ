import { Router, type IRouter } from "express";
import {
  GetActionProposalsQueryParams,
  GetActionProposalsResponse,
  ExecuteActionBody,
  ExecuteActionResponse,
  GetActionDecisionsQueryParams,
  GetActionDecisionsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { resolveClientAnalyticsScope } from "../../lib/client-scope";
import { assertCan, assertPartyAccess } from "../../modules/auth/rbac";
import {
  executeAction,
  listActionDecisions,
  listActionProposals,
} from "../../modules/clerk/actions";

// Proposed actions (round 21): Clerk assembles a batch, a HUMAN approves it,
// and approval executes through the platform's existing per-invoice
// machinery. Three deliberate authz choices:
//  - proposals and decisions are READ surfaces (invoice.read) — they reveal
//    nothing the invoice list doesn't already show;
//  - execution requires invoice.submit — approving a Clerk batch IS
//    submitting, so it carries exactly the capability a manual submit does
//    (and maker-checker still bites per invoice inside submitInvoice);
//  - all three resolve the client through resolveClientAnalyticsScope
//    (SEC-03): a client_user is pinned to its own party, a firm principal
//    names the client.
// The opt-in clerk_actions flag is enforced inside the module (dark →
// proposals answer empty, execution refuses 503).

const router: IRouter = Router();

router.get("/clerk/action-proposals", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetActionProposalsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const proposals = await listActionProposals(firmId, clientPartyId);
  res.json(GetActionProposalsResponse.parse(proposals));
});

router.post(
  "/clerk/action-proposals/execute",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.submit");
    const body = parseOrThrow(ExecuteActionBody, req.body);
    const { firmId, clientPartyId } = resolveClientAnalyticsScope(
      req.principal,
      body.clientPartyId,
    );
    // Parity with the manual bulk-submit route: the party must be reachable
    // by this principal (cross-tenant IDOR wall), not just consent-refused.
    await assertPartyAccess(req.principal, clientPartyId);
    const result = await executeAction(
      firmId,
      clientPartyId,
      req.principal.userId,
      body.kind,
      body.invoiceIds,
    );
    res.json(ExecuteActionResponse.parse(result));
  },
);

router.get("/clerk/action-decisions", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetActionDecisionsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const decisions = await listActionDecisions(firmId, clientPartyId);
  res.json(GetActionDecisionsResponse.parse({ decisions }));
});

export default router;
