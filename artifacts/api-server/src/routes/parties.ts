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
  SplitPartyParams,
  ValidateTinBody,
  ValidateTinResponse,
  ValidateCacBody,
  ValidateCacResponse,
} from "@workspace/api-zod";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, partiesTable, engagementsTable } from "@workspace/db";
import { likePattern } from "../lib/sql";
import {
  assertCan,
  assertPartyAccessOrInvoiceRef,
  can,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import {
  createParty,
  getParty,
  mergeParties,
  splitParty,
  updateParty,
  validateTin,
  validateCac,
} from "../modules/party/party";

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
  const tenant = tenantFirmId(req.principal);
  let rows;
  if (tenant === null) {
    // Cross-tenant staff (operator, auditor) see the whole spine.
    rows = await getDb()
      .select()
      .from(partiesTable)
      .where(search)
      .orderBy(partiesTable.createdAt);
  } else {
    const scope = clientPartyScope(req.principal);
    // Visibility is the firm's SPHERE, not just its engagement subjects —
    // buyers are rarely engagement clients, yet the invoice form must list
    // them. Three ways into the sphere: an engagement, appearing on one of
    // the firm's invoices, or having been captured by the firm (provenance
    // column). A client_user (SEC-03) gets the strictly narrower version:
    // its OWN party, parties on its OWN invoices, and parties it captured
    // itself — never a sibling client's customer list.
    const sphere =
      scope === null
        ? sql`(
            ${partiesTable.id} IN (
              SELECT client_party_id FROM engagements WHERE firm_id = ${tenant}
            )
            OR ${partiesTable.createdByFirmId} = ${tenant}
            OR EXISTS (
              SELECT 1 FROM invoices i
              WHERE i.firm_id = ${tenant}
                AND (i.supplier_party_id = ${partiesTable.id}
                  OR i.buyer_party_id = ${partiesTable.id})
            )
          )`
        : sql`(
            ${partiesTable.id} = ${scope}
            OR ${partiesTable.createdByUserId} = ${req.principal.userId}
            OR EXISTS (
              SELECT 1 FROM invoices i
              WHERE i.firm_id = ${tenant}
                AND i.supplier_party_id = ${scope}
                AND (i.supplier_party_id = ${partiesTable.id}
                  OR i.buyer_party_id = ${partiesTable.id})
            )
          )`;
    rows = await getDb()
      .select()
      .from(partiesTable)
      .where(search ? and(sphere, search) : sphere)
      .orderBy(partiesTable.createdAt);
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
  const party = await createParty(
    parsed.data,
    req.principal.userId,
    tenantFirmId(req.principal),
  );
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

// Correct a party's registration data (fix-and-retry: rejected TIN, missing
// address). Access: party.write (firm staff/admin, over engaged parties via
// assertPartyAccess) — plus the one deliberate self-service carve-out: a
// client_user may fix its OWN client party record (assertPartyAccess already
// confines client_users to exactly that party), since a wrong supplier TIN is
// the client's own data and the fix should not require firm staff.
router.patch("/parties/:id", async (req, res): Promise<void> => {
  const params = UpdatePartyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const selfService =
    req.principal.role === "client_user" &&
    req.principal.clientPartyId === params.data.id;
  if (!selfService && !can(req.principal, "party.write")) {
    assertCan(req.principal, "party.write"); // throws the standard 403
  }
  // Engaged parties pass; firm staff additionally get the invoice-reference
  // fallback so they can fix a buyer whose bad TIN failed one of the firm's
  // invoices. client_users stay confined to their own party (SEC-03).
  await assertPartyAccessOrInvoiceRef(req.principal, params.data.id);
  const body = UpdatePartyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const party = await updateParty(params.data.id, body.data, req.principal.userId);
  res.json(UpdatePartyResponse.parse(party));
});

router.get("/parties/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const params = GetPartyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Same access model as PATCH: engagement OR the party appears on one of the
  // firm's invoices — firm staff must be able to view a buyer they may edit.
  await assertPartyAccessOrInvoiceRef(req.principal, params.data.id);
  const party = await getParty(params.data.id);
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  res.json(GetPartyResponse.parse(party));
});

export default router;
