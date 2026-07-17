import { Router, type IRouter } from "express";
import {
  ListPartiesQueryParams,
  ListPartiesResponse,
  CreatePartyBody,
  CreatePartyResponse,
  GetPartyParams,
  GetPartyResponse,
  UpdatePartyParams,
  UpdatePartyBody,
  UpdatePartyResponse,
  MergePartiesBody,
  GetMergeImpactQueryParams,
  GetMergeImpactResponse,
  SplitPartyParams,
  ValidateTinBody,
  ValidateTinResponse,
  ValidateCacBody,
  ValidateCacResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { and, sql, type SQL } from "drizzle-orm";
import { getDb, partiesTable } from "@workspace/db";
import { likePattern } from "../lib/sql";
import {
  assertCan,
  assertPartyAccessOrInvoiceRef,
  can,
  tenantFirmId,
} from "../modules/auth/rbac";
import {
  createParty,
  getParty,
  mergeParties,
  partySphereCondition,
  splitParty,
  updateParty,
  validateTin,
  validateCac,
} from "../modules/party/party";
import { computeMergeImpact } from "../modules/party/merge-impact";

const router: IRouter = Router();

router.get("/parties", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const query = ListPartiesQueryParams.safeParse(req.query);
  const q = query.success ? query.data.q?.trim() : undefined;
  // Search matches the legal name or TIN; wildcards in the query are literal.
  let search: SQL | undefined;
  if (q) {
    const pattern = likePattern(q);
    search = sql`(${partiesTable.legalName} ILIKE ${pattern}
        OR ${partiesTable.tin} ILIKE ${pattern})`;
  }
  // Visibility is the firm's SPHERE, not just its engagement subjects —
  // buyers are rarely engagement clients, yet the invoice form must list
  // them. Null = cross-tenant staff (operator, auditor) see the whole spine.
  // The condition itself lives in modules/party/party.ts so every surface
  // that lists or suggests parties scopes identically.
  const sphere = partySphereCondition(req.principal);
  const conditions = [sphere, search].filter((c): c is SQL => !!c);
  const rows = await getDb()
    .select()
    .from(partiesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(partiesTable.createdAt);
  res.json(ListPartiesResponse.parse(rows));
});

router.post("/parties", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.write");
  const parsed = parseOrThrow(CreatePartyBody, req.body);
  const party = await createParty(
    parsed,
    req.principal.userId,
    tenantFirmId(req.principal),
  );
  res.status(201).json(CreatePartyResponse.parse(party));
});

// Merge impact preview (round-12 idea #2): what each side of a proposed
// merge carries, so accepting a duplicate suggestion is an informed act.
// Same gate as the merge itself; counts only, nothing stored.
router.get("/parties/merge-impact", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.merge");
  const query = parseOrThrow(GetMergeImpactQueryParams, req.query);
  const impact = await computeMergeImpact(query.survivorId, query.duplicateId);
  res.json(GetMergeImpactResponse.parse(impact));
});

router.post("/parties/merge", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.merge");
  const parsed = parseOrThrow(MergePartiesBody, req.body);
  await mergeParties(
    parsed.survivorId,
    parsed.duplicateId,
    req.principal.userId,
  );
  res.sendStatus(204);
});

router.post("/parties/:id/split", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.merge");
  const params = parseOrThrow(SplitPartyParams, req.params);
  await splitParty(params.id, req.principal.userId);
  res.sendStatus(204);
});

router.post("/parties/validate-tin", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(ValidateTinBody, req.body);
  res.json(ValidateTinResponse.parse(validateTin(parsed.tin)));
});

router.post("/parties/validate-cac", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(ValidateCacBody, req.body);
  res.json(ValidateCacResponse.parse(validateCac(parsed.cac)));
});

// Correct a party's registration data (fix-and-retry: rejected TIN, missing
// address). Access: party.write (firm staff/admin, over engaged parties via
// assertPartyAccess) — plus the one deliberate self-service carve-out: a
// client_user may fix its OWN client party record (assertPartyAccess already
// confines client_users to exactly that party), since a wrong supplier TIN is
// the client's own data and the fix should not require firm staff.
router.patch("/parties/:id", async (req, res): Promise<void> => {
  const params = parseOrThrow(UpdatePartyParams, req.params);
  const selfService =
    req.principal.role === "client_user" &&
    req.principal.clientPartyId === params.id;
  if (!selfService && !can(req.principal, "party.write")) {
    assertCan(req.principal, "party.write"); // throws the standard 403
  }
  // Engaged parties pass; firm staff additionally get the invoice-reference
  // fallback so they can fix a buyer whose bad TIN failed one of the firm's
  // invoices. client_users stay confined to their own party (SEC-03).
  await assertPartyAccessOrInvoiceRef(req.principal, params.id);
  const body = parseOrThrow(UpdatePartyBody, req.body);
  const party = await updateParty(params.id, body, req.principal.userId);
  res.json(UpdatePartyResponse.parse(party));
});

router.get("/parties/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const params = parseOrThrow(GetPartyParams, req.params);
  // Same access model as PATCH: engagement OR the party appears on one of the
  // firm's invoices — firm staff must be able to view a buyer they may edit.
  await assertPartyAccessOrInvoiceRef(req.principal, params.id);
  const party = await getParty(params.id);
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  res.json(GetPartyResponse.parse(party));
});

export default router;
