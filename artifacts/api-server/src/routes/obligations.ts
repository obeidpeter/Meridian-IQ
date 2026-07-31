import { Router, type IRouter } from "express";
import {
  ListObligationsQueryParams,
  ListObligationsResponse,
  CreateObligationBody,
  CreateObligationResponse,
  GetObligationParams,
  GetObligationResponse,
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
import { DomainError } from "../modules/errors";
import {
  createObligation,
  getObligation,
  listObligations,
  updateObligationStatus,
} from "../modules/obligations/obligations";

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
