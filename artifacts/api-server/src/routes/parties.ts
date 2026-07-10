import { Router, type IRouter } from "express";
import {
  ListPartiesResponse,
  CreatePartyBody,
  CreatePartyResponse,
  GetPartyParams,
  GetPartyResponse,
  MergePartiesBody,
  SplitPartyParams,
  ValidateTinBody,
  ValidateTinResponse,
  ValidateCacBody,
  ValidateCacResponse,
} from "@workspace/api-zod";
import { eq, inArray } from "drizzle-orm";
import { getDb, partiesTable, engagementsTable } from "@workspace/db";
import {
  assertCan,
  assertPartyAccess,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import {
  createParty,
  getParty,
  mergeParties,
  splitParty,
  validateTin,
  validateCac,
} from "../modules/party/party";

const router: IRouter = Router();

router.get("/parties", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const tenant = tenantFirmId(req.principal);
  let rows;
  if (tenant === null) {
    // Cross-tenant staff (operator, auditor) see the whole spine.
    rows = await getDb()
      .select()
      .from(partiesTable)
      .orderBy(partiesTable.createdAt);
  } else {
    // Firm-scoped principals only see parties they have an engagement with.
    const engagements = await getDb()
      .select({ pid: engagementsTable.clientPartyId })
      .from(engagementsTable)
      .where(eq(engagementsTable.firmId, tenant));
    // A client_user is confined to its own client party (SEC-03): drop any
    // sibling clients the firm engages.
    const scope = clientPartyScope(req.principal);
    const ids = engagements
      .map((e) => e.pid)
      .filter((id) => scope === null || id === scope);
    rows = ids.length
      ? await getDb()
          .select()
          .from(partiesTable)
          .where(inArray(partiesTable.id, ids))
          .orderBy(partiesTable.createdAt)
      : [];
  }
  res.json(ListPartiesResponse.parse(rows));
});

router.post("/parties", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.write");
  const parsed = CreatePartyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const party = await createParty(parsed.data, req.principal.userId);
  res.status(201).json(CreatePartyResponse.parse(party));
});

router.post("/parties/merge", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.merge");
  const parsed = MergePartiesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await mergeParties(
    parsed.data.survivorId,
    parsed.data.duplicateId,
    req.principal.userId,
  );
  res.sendStatus(204);
});

router.post("/parties/:id/split", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.merge");
  const params = SplitPartyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await splitParty(params.data.id, req.principal.userId);
  res.sendStatus(204);
});

router.post("/parties/validate-tin", async (req, res): Promise<void> => {
  const parsed = ValidateTinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ValidateTinResponse.parse(validateTin(parsed.data.tin)));
});

router.post("/parties/validate-cac", async (req, res): Promise<void> => {
  const parsed = ValidateCacBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ValidateCacResponse.parse(validateCac(parsed.data.cac)));
});

router.get("/parties/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const params = GetPartyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await assertPartyAccess(req.principal, params.data.id);
  const party = await getParty(params.data.id);
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  res.json(GetPartyResponse.parse(party));
});

export default router;
