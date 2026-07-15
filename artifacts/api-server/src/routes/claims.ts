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
import { parseOrThrow } from "../lib/parse";
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
  const query = parseOrThrow(ListClaimsQueryParams, req.query);
  const rows = await listClaims(query.claimKey);
  res.json(ListClaimsResponse.parse(rows));
});

router.get("/claims/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.read");
  const params = parseOrThrow(GetClaimParams, req.params);
  const claim = await getClaim(params.id);
  res.json(GetClaimResponse.parse(claim));
});

router.post("/claims", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const parsed = parseOrThrow(CreateClaimBody, req.body);
  const claim = await createClaimDraft(parsed, req.principal.userId);
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
  const params = parseOrThrow(UpdateClaimParams, req.params);
  const parsed = parseOrThrow(UpdateClaimBody, req.body);
  const claim = await updateClaimDraft(
    params.id,
    parsed,
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
  const params = parseOrThrow(SubmitClaimParams, req.params);
  const claim = await submitClaim(params.id, req.principal.userId);
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
  const params = parseOrThrow(DecideClaimParams, req.params);
  const parsed = parseOrThrow(DecideClaimBody, req.body);
  const claim = await decideClaim(
    params.id,
    parsed.action,
    parsed.note ?? null,
    req.principal.userId,
  );
  await appendAudit({
    actorId: req.principal.userId,
    action: `claim.${parsed.action}`,
    entityType: "claim_record",
    entityId: claim.id,
    after: {
      claimKey: claim.claimKey,
      version: claim.version,
      state: claim.state,
      note: parsed.note ?? null,
    },
  });
  res.json(DecideClaimResponse.parse(claim));
});

export default router;
