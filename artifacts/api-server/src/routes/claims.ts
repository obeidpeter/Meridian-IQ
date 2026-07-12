import { Router, type IRouter } from "express";
import {
  ListClaimsQueryParams,
  ListClaimsResponse,
  CreateClaimBody,
  CreateClaimResponse,
  GetClaimParams,
  GetClaimResponse,
  UpdateClaimParams,
  UpdateClaimBody,
  UpdateClaimResponse,
  SubmitClaimParams,
  SubmitClaimResponse,
  DecideClaimParams,
  DecideClaimBody,
  DecideClaimResponse,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import {
  listClaims,
  getClaim,
  createClaimDraft,
  updateClaimDraft,
  submitClaim,
  decideClaim,
} from "../modules/clerk/claims";

const router: IRouter = Router();

// Claims register (Task #40, C2). Reads are broad (claims.read) because the
// register is reference data shown across the console; writes are operator-only
// and every state change is audited. Maker-checker separation (the author can
// never approve their own claim) is enforced in the module, not here.

router.get("/claims", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.read");
  const query = ListClaimsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await listClaims(query.data.claimKey);
  res.json(ListClaimsResponse.parse(rows));
});

router.get("/claims/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.read");
  const params = GetClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const claim = await getClaim(params.data.id);
  res.json(GetClaimResponse.parse(claim));
});

router.post("/claims", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const parsed = CreateClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const claim = await createClaimDraft(parsed.data, req.principal.userId);
  await appendAudit({
    actorId: req.principal.userId,
    action: "claim.draft",
    entityType: "claim_record",
    entityId: claim.id,
    after: { claimKey: claim.claimKey, version: claim.version },
  });
  res.status(201).json(CreateClaimResponse.parse(claim));
});

router.patch("/claims/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const params = UpdateClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const claim = await updateClaimDraft(
    params.data.id,
    parsed.data,
    req.principal.userId,
  );
  await appendAudit({
    actorId: req.principal.userId,
    action: "claim.update",
    entityType: "claim_record",
    entityId: claim.id,
    after: { claimKey: claim.claimKey, version: claim.version },
  });
  res.json(UpdateClaimResponse.parse(claim));
});

router.post("/claims/:id/submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const params = SubmitClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const claim = await submitClaim(params.data.id, req.principal.userId);
  await appendAudit({
    actorId: req.principal.userId,
    action: "claim.submit",
    entityType: "claim_record",
    entityId: claim.id,
    after: { claimKey: claim.claimKey, version: claim.version, state: claim.state },
  });
  res.json(SubmitClaimResponse.parse(claim));
});

router.post("/claims/:id/decision", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.approve");
  const params = DecideClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DecideClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const claim = await decideClaim(
    params.data.id,
    parsed.data.action,
    parsed.data.note ?? null,
    req.principal.userId,
  );
  await appendAudit({
    actorId: req.principal.userId,
    action: `claim.${parsed.data.action}`,
    entityType: "claim_record",
    entityId: claim.id,
    after: {
      claimKey: claim.claimKey,
      version: claim.version,
      state: claim.state,
      note: parsed.data.note ?? null,
    },
  });
  res.json(DecideClaimResponse.parse(claim));
});

export default router;
