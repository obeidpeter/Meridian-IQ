import { Router, type IRouter } from "express";
import {
  ListFilingsQueryParams,
  ListFilingsResponse,
  SyncFilingsResponse,
  UpdateFilingStatusParams,
  UpdateFilingStatusBody,
  UpdateFilingStatusResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  narrowToClientPartyScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import {
  listFilings,
  mintFilingsForFirm,
  updateFilingStatus,
} from "../modules/filings/filings";

// Filing Desk (contract 0.67.0): the statutory returns register. Authz
// posture:
//  - reads are filing.read; a firm principal may list FIRM-WIDE (the
//    clientPartyId filter is optional — the register is a cross-client
//    worklist), while a client_user is always pinned to its own party
//    (SEC-03: narrowToClientPartyScope — firm-keyed RLS alone would share
//    siblings);
//  - writes are filing.write (firm_admin/firm_staff only): sync mints from
//    the statutory calendar for the caller's OWN firm, and the status walk's
//    UPDATE carries the firm predicate in the module (compare-and-set), so a
//    foreign tenant's id updates zero rows and 404s without disclosure — the
//    obligations status-route shape exactly.

const router: IRouter = Router();

router.get("/filings", async (req, res): Promise<void> => {
  assertCan(req.principal, "filing.read");
  const query = parseOrThrow(ListFilingsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  // SEC-03: a client_user is pinned to its own party whatever the filter
  // says; firm staff keep the filter they asked for (or none — firm-wide).
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.clientPartyId,
  );
  const filings = await listFilings(firmId, {
    clientPartyId,
    status: query.status,
    taxType: query.taxType,
    limit: query.limit,
    offset: query.offset,
  });
  res.json(ListFilingsResponse.parse({ filings }));
});

// Sync-now: the same mint the hourly sweep performs, on demand for THIS firm
// (a firm that just onboarded a client need not wait for the loop). The
// natural unique key makes the overlap free — an already-current register
// mints zero.
router.post("/filings/sync", async (req, res): Promise<void> => {
  assertCan(req.principal, "filing.write");
  const firmId = requireFirmScope(req.principal);
  const minted = await mintFilingsForFirm(firmId);
  res.json(SyncFilingsResponse.parse({ minted }));
});

router.post("/filings/:id/status", async (req, res): Promise<void> => {
  assertCan(req.principal, "filing.write");
  const params = parseOrThrow(UpdateFilingStatusParams, req.params);
  const body = parseOrThrow(UpdateFilingStatusBody, req.body);
  const firmId = requireFirmScope(req.principal);
  // The module's UPDATE carries the firm predicate (compare-and-set): a
  // foreign tenant's id updates zero rows and 404s without disclosure.
  const row = await updateFilingStatus(
    params.id,
    firmId,
    body,
    req.principal.userId,
  );
  if (!row) {
    throw new DomainError("NOT_FOUND", "Filing not found", 404);
  }
  res.json(UpdateFilingStatusResponse.parse(row));
});

export default router;
