import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, invoicesTable } from "@workspace/db";
import {
  GetWhtRemittanceQueryParams,
  GetWhtRemittanceResponse,
  ListWhtCreditsQueryParams,
  ListWhtCreditsResponse,
  MarkWhtNoteReceivedBody,
  MarkWhtNoteReceivedParams,
  MarkWhtNoteReceivedResponse,
  RecordWhtCreditBody,
  RecordWhtCreditResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  narrowToClientPartyScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import {
  listWhtCredits,
  loadWhtCreditForScope,
  markWhtNoteReceived,
  recordWhtCredit,
} from "../modules/wht/credits";
import { computeWhtRemittance } from "../modules/wht/remittance";

// WHT Desk (contract 0.69.0): the withholding credit ledger + the buyer-side
// remittance schedule. Authz posture (the routes/filings.ts shape):
//  - reads are invoice.read; a firm principal may list FIRM-WIDE (the ledger
//    is a cross-client worklist), while a client_user is always pinned to
//    its own party (SEC-03: narrowToClientPartyScope — firm-keyed RLS alone
//    would share siblings);
//  - writes are invoice.write. Recording a deduction loads the invoice FIRST
//    and scopes on its SUPPLIER (the credit belongs to the supplier client);
//    marking a note received loads the credit under the 404 non-disclosure
//    loader. Both collapse foreign-tenant and sibling-client probes into the
//    same not-found a missing id produces;
//  - the remittance read REQUIRES a clientPartyId (the schedule is one
//    client's period by definition) and asserts the caller's own-party scope
//    on it.

const router: IRouter = Router();

router.get("/wht/credits", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListWhtCreditsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  // SEC-03: a client_user is pinned to its own party whatever the filter
  // says; firm staff keep the filter they asked for (or none — firm-wide).
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.clientPartyId,
  );
  const result = await listWhtCredits(firmId, {
    clientPartyId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  res.json(ListWhtCreditsResponse.parse(result));
});

router.post("/wht/credits", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const body = parseOrThrow(RecordWhtCreditBody, req.body);
  const firmId = requireFirmScope(req.principal);
  // Load the invoice first (firm-scoped) and gate on its SUPPLIER: the
  // credit belongs to the supplier-side client, so a client_user may only
  // record deductions on its own paper. 404 non-disclosure — a foreign
  // tenant's id and a sibling client's are indistinguishable from a missing
  // one.
  const [invoice] = await getDb()
    .select({ supplierPartyId: invoicesTable.supplierPartyId })
    .from(invoicesTable)
    .where(
      and(eq(invoicesTable.id, body.invoiceId), eq(invoicesTable.firmId, firmId)),
    )
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  try {
    assertClientPartyScope(req.principal, invoice.supplierPartyId);
  } catch {
    throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  }
  // Always 201 with the surviving row: the unique invoiceId key makes a
  // re-record idempotent (the module SELECTs the winner either way).
  const row = await recordWhtCredit(firmId, body.invoiceId, {
    amount: body.amount,
    deductedDate: body.deductedDate,
    source: "manual",
    recordedBy: req.principal.userId,
  });
  res.status(201).json(RecordWhtCreditResponse.parse(row));
});

router.post("/wht/credits/:id/note", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(MarkWhtNoteReceivedParams, req.params);
  const body = parseOrThrow(MarkWhtNoteReceivedBody, req.body);
  const firmId = requireFirmScope(req.principal);
  // The ONE loader (loadFilingForScope shape): missing id, foreign tenant
  // and sibling client all read as the same 404.
  await loadWhtCreditForScope(params.id, req.principal);
  const row = await markWhtNoteReceived(
    firmId,
    params.id,
    body,
    req.principal.userId,
  );
  if (!row) {
    throw new DomainError("NOT_FOUND", "Credit not found", 404);
  }
  res.json(MarkWhtNoteReceivedResponse.parse(row));
});

router.get("/wht/remittance", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetWhtRemittanceQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  // clientPartyId is REQUIRED by the contract; a client_user may only ask
  // for its own party's schedule (SEC-03).
  assertClientPartyScope(req.principal, query.clientPartyId);
  const result = await computeWhtRemittance(
    firmId,
    query.clientPartyId,
    query.period,
  );
  res.json(GetWhtRemittanceResponse.parse(result));
});

export default router;
