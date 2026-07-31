import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, firmsTable } from "@workspace/db";
import {
  ListObligationsQueryParams,
  ListObligationsResponse,
  CreateObligationBody,
  CreateObligationResponse,
  GetObligationParams,
  GetObligationResponse,
  GetObligationResponsePackQueryParams,
  DraftObligationResponseParams,
  DraftObligationResponseBody,
  DraftObligationResponseResponse,
  UpdateObligationStatusParams,
  UpdateObligationStatusBody,
  UpdateObligationStatusResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  assertPartyAccess,
  assertSameTenant,
  narrowToClientPartyScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";
import {
  sendPdfAttachment,
  themeWithBrandFallback,
} from "../modules/invoice/pdf";
import {
  createObligation,
  getObligation,
  listObligations,
  updateObligationStatus,
} from "../modules/obligations/obligations";
import {
  computeObligationResponseFacts,
  draftObligationResponse,
} from "../modules/obligations/response-pack";
import { renderObligationResponsePdf } from "../modules/obligations/response-pack-pdf";
import { gatewayOrNull } from "../modules/clerk/provider";

// Notice Desk obligations (contract 0.57.0): tracked authority notices with a
// response deadline. Authz posture:
//  - reads are obligation.read; a firm principal may list FIRM-WIDE (the
//    clientPartyId filter is optional — the Notice Desk is a cross-client
//    worklist), while a client_user is always pinned to its own party
//    (SEC-03: narrowToClientPartyScope on the list, assertClientPartyScope on
//    the detail — firm-keyed RLS alone would share siblings);
//  - writes are obligation.write (firm staff); creation crosses the real
//    engagement wall (assertPartyAccess — the IDOR guard, not just a filter);
//  - the detail read is 404 non-disclosure (the bills-route posture): a
//    foreign tenant's obligation and a sibling client's obligation are both
//    indistinguishable from an id that does not exist.

const router: IRouter = Router();

router.get("/obligations", async (req, res): Promise<void> => {
  assertCan(req.principal, "obligation.read");
  const query = parseOrThrow(ListObligationsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  // SEC-03: a client_user is pinned to its own party whatever the filter
  // says; firm staff keep the filter they asked for (or none — firm-wide).
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.clientPartyId,
  );
  const obligations = await listObligations(firmId, {
    clientPartyId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  res.json(ListObligationsResponse.parse({ obligations }));
});

router.post("/obligations", async (req, res): Promise<void> => {
  assertCan(req.principal, "obligation.write");
  const body = parseOrThrow(CreateObligationBody, req.body);
  const firmId = requireFirmScope(req.principal);
  // WRITE surface: the party must be one the firm actually engages (the
  // cross-tenant IDOR wall), not merely a plausible uuid.
  await assertPartyAccess(req.principal, body.clientPartyId);
  const row = await createObligation(firmId, body, req.principal.userId);
  res.status(201).json(CreateObligationResponse.parse(row));
});

router.get("/obligations/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "obligation.read");
  const params = parseOrThrow(GetObligationParams, req.params);
  const row = await getObligation(params.id);
  const notFound = () =>
    new DomainError("NOT_FOUND", "Obligation not found", 404);
  if (!row) throw notFound();
  // 404 non-disclosure: CROSS_TENANT and CROSS_CLIENT both collapse to the
  // same not-found the missing id produces (the loadBillForScope posture).
  try {
    assertSameTenant(req.principal, row.firmId);
    assertClientPartyScope(req.principal, row.clientPartyId);
  } catch {
    throw notFound();
  }
  res.json(GetObligationResponse.parse(row));
});

// Response Desk (Task #207, contract 0.59.0): the response bundle PDF and
// the letter draft. Both are obligation.write surfaces — FIRM work product
// prepared to answer an authority (a client_user holds obligation.read only
// and must not pull either) — and both reuse computeObligationResponseFacts,
// which carries the detail route's 404 non-disclosure dance and the shared
// month resolver.

// Query-params-only (house style: a path id plus query params collides in
// the generated client names — the compliance-pack precedent). Deterministic
// SQL + rendering end to end, zero model calls (the renderer's input has no
// letter field by construction).
router.get("/obligation-response-pack", async (req, res): Promise<void> => {
  assertCan(req.principal, "obligation.write");
  const query = parseOrThrow(GetObligationResponsePackQueryParams, req.query);
  requireFirmScope(req.principal);
  const { obligation, pack, monthStart } = await computeObligationResponseFacts(
    query.obligationId,
    req.principal,
    query.month,
  );
  // brandName falls back to the firm's own name — the whitelabel page's rule
  // (themeWithBrandFallback, the compliance-pack route's exact fallback).
  const [firm] = await getDb()
    .select({ name: firmsTable.name, theme: firmsTable.theme })
    .from(firmsTable)
    .where(eq(firmsTable.id, pack.firmId))
    .limit(1);
  const theme = themeWithBrandFallback(firm?.theme, firm?.name);
  const pdf = await renderObligationResponsePdf({
    obligation,
    pack,
    monthStart,
    theme,
  });
  // Pointer-only audit (SEC-12): which obligation's bundle, which month —
  // never notice contents or figures.
  await appendAudit({
    actorId: req.principal.userId,
    firmId: obligation.firmId,
    action: "obligation.response_pack",
    entityType: "obligation",
    entityId: obligation.id,
    after: { month: monthStart },
  });
  // The reference is authority free text; sendPdfAttachment sanitizes the
  // filename before it reaches the header.
  const refPart = obligation.reference ?? obligation.id.slice(0, 8);
  sendPdfAttachment(
    res,
    `obligation-response-${refPart}-${monthStart.slice(0, 7)}.pdf`,
    pdf,
  );
});

// Digest-posture letter draft: ONE phrasing call that stays inside the
// request transaction, and the template always answers (no gateway, kill
// switch, exhausted budget, ungrounded output → template, never an error) —
// so there is no route budget assert. One phrasing call in-transaction; the
// route rides the MODEL rate class (rate-limit.ts pattern).
router.post(
  "/obligations/:id/response-draft",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "obligation.write");
    const params = parseOrThrow(DraftObligationResponseParams, req.params);
    const body = parseOrThrow(DraftObligationResponseBody, req.body);
    const gateway = await gatewayOrNull();
    const draft = await draftObligationResponse(
      params.id,
      req.principal,
      gateway,
      body.month,
    );
    res.json(DraftObligationResponseResponse.parse(draft));
  },
);

router.post("/obligations/:id/status", async (req, res): Promise<void> => {
  assertCan(req.principal, "obligation.write");
  const params = parseOrThrow(UpdateObligationStatusParams, req.params);
  const body = parseOrThrow(UpdateObligationStatusBody, req.body);
  const firmId = requireFirmScope(req.principal);
  // The module's UPDATE carries the firm predicate (compare-and-set): a
  // foreign tenant's id updates zero rows and 404s without disclosure.
  const row = await updateObligationStatus(
    params.id,
    firmId,
    body.status,
    body.notes,
    req.principal.userId,
  );
  if (!row) {
    throw new DomainError("NOT_FOUND", "Obligation not found", 404);
  }
  res.json(UpdateObligationStatusResponse.parse(row));
});

export default router;
