import { Router, type IRouter } from "express";
import {
  CreateInvitationBody,
  CreateInvitationResponse,
  ListInvitationsResponse,
  RevokeInvitationParams,
  RevokeInvitationResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import {
  createInvitation,
  listInvitations,
  revokeInvitation,
} from "../modules/auth/invitations";

// Self-serve onboarding (IDN-01). A firm_admin invites teammates/clients into
// its own firm; operators may also read/revoke for support. Firm scoping is
// enforced at the data layer by the invitations RLS policy (migration 0008) and
// re-asserted in the module. The public redeem endpoint lives in auth.ts.

const router: IRouter = Router();

router.get("/invitations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invitation.read");
  const rows = await listInvitations(req.principal);
  res.json(ListInvitationsResponse.parse(rows));
});

router.post("/invitations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invitation.write");
  const parsed = parseOrThrow(CreateInvitationBody, req.body);
  const created = await createInvitation(req.principal, {
    email: parsed.email,
    role: parsed.role,
    clientPartyId: parsed.clientPartyId ?? null,
  });
  res.status(201).json(CreateInvitationResponse.parse(created));
});

router.post("/invitations/:id/revoke", async (req, res): Promise<void> => {
  assertCan(req.principal, "invitation.write");
  const params = parseOrThrow(RevokeInvitationParams, req.params);
  const row = await revokeInvitation(req.principal, params.id);
  if (!row) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  res.json(RevokeInvitationResponse.parse(row));
});

export default router;
