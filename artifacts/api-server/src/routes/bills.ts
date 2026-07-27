import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  getDb,
  billVerificationsTable,
  invoicesTable,
  settlementEventsTable,
  type Invoice,
} from "@workspace/db";
import {
  ListBillsQueryParams,
  ListBillsResponse,
  GetPayablesSummaryQueryParams,
  GetPayablesSummaryResponse,
  FlagBillPaymentParams,
  FlagBillPaymentBody,
  FlagBillPaymentResponse,
  VerifyBillStampParams,
  VerifyBillStampBody,
  VerifyBillStampResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { resolveClientAnalyticsScope } from "../lib/client-scope";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../modules/auth/rbac";
import {
  invoiceOrientation,
  listBills,
  payablesSummary,
} from "../modules/invoice/payables";
import { verifyStamp } from "../modules/rails/adapter";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";

// Supplier payables (contract 0.44.0). A BILL is an invoice row where the
// firm's CLIENT is the BUYER — a captured vendor invoice. ALL bill access
// goes through these routes with their own buyer-side scope: the SEC-03
// invoice loaders (loadForTenant, invoiceListConditions) are supplier-pinned
// by design and are deliberately NOT widened. Bills never transition —
// payment state is settlement evidence only (source payer_flag /
// statement_match), and the submit guard in modules/invoice/service.ts keeps
// them out of the stamping lifecycle.

const router: IRouter = Router();

// The bills scope wall, one definition: the invoice must exist, sit in the
// caller's tenant, be reachable by the caller's client scope ON THE BUYER
// SIDE (a client_user is the bill's payer, so assertClientPartyScope checks
// buyerPartyId — the mirror of the receivable loaders), and actually BE a
// bill. Every failure is a 404 non-disclosure: a sibling client's bill, a
// receivable, or a foreign tenant's invoice must all be indistinguishable
// from an id that does not exist.
async function loadBillForScope(
  principal: Principal,
  id: string,
): Promise<Invoice> {
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id))
    .limit(1);
  const notFound = () => new DomainError("NOT_FOUND", "Bill not found", 404);
  if (!invoice) throw notFound();
  try {
    assertSameTenant(principal, invoice.firmId);
    assertClientPartyScope(principal, invoice.buyerPartyId);
  } catch {
    throw notFound();
  }
  if (
    invoice.kind !== "invoice" ||
    (await invoiceOrientation(invoice)) !== "bill"
  ) {
    throw notFound();
  }
  return invoice;
}

router.get("/bills", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListBillsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const bills = await listBills(firmId, clientPartyId);
  res.json(ListBillsResponse.parse(bills));
});

router.get("/dashboard/payables", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetPayablesSummaryQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const summary = await payablesSummary(firmId, clientPartyId);
  res.json(GetPayablesSummaryResponse.parse(summary));
});

// The payer's own payment flag (the buyer route's mirror, routes/buyer.ts
// payment-flags): one append-only settlement event with source=payer_flag —
// evidence only. NO status transition, ever: a bill is a draft for life, and
// applyTransition would (correctly) 409 a draft->settled move.
router.post("/bills/:id/payment-flag", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(FlagBillPaymentParams, req.params);
  const body = parseOrThrow(FlagBillPaymentBody, req.body);
  const invoice = await loadBillForScope(req.principal, params.id);
  // The contract types amount as a bare string; reject anything that is not a
  // plain decimal before it reaches the numeric column (400, not a DB 500) —
  // the buyer payment-flag route's exact guard.
  if (body.amount !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.amount)) {
    throw new DomainError(
      "INVALID_AMOUNT",
      "amount must be a plain decimal string (e.g. 120000.00)",
      400,
    );
  }
  const [event] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: invoice.id,
      source: "payer_flag",
      amount: body.amount ?? invoice.grandTotal,
      paymentStatus: body.status,
      actorId: req.principal.userId,
      occurredAt: new Date(),
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.payment_flag",
    entityType: "settlement_event",
    entityId: event.id,
    after: { paymentStatus: event.paymentStatus, amount: event.amount },
  });
  res.status(201).json(FlagBillPaymentResponse.parse(event));
});

// Verify a bill's stamp (IRN/CSID entered by the payer — never extracted)
// against the national record via the ordinary verify path, and keep the
// result on the bill so the ledger shows the input-VAT posture. A stamp the
// platform does not know answers valid:false with a null eligibility — the
// verification row is still recorded (that IS the posture).
router.post("/bills/:id/verify-stamp", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(VerifyBillStampParams, req.params);
  const body = parseOrThrow(VerifyBillStampBody, req.body);
  const invoice = await loadBillForScope(req.principal, params.id);
  const verification = await verifyStamp(body.irn, body.csid);
  const [row] = await getDb()
    .insert(billVerificationsTable)
    .values({
      firmId: invoice.firmId,
      invoiceId: invoice.id,
      irn: body.irn,
      csid: body.csid,
      valid: verification.valid,
      // Null when the stamp is unknown here: validity comes from the rail
      // record; eligibility needs the invoice lifecycle behind it.
      eligible: verification.valid ? verification.eligible : null,
      checkedByUserId: req.principal.userId,
    })
    .returning();
  // Pointer-only audit (SEC-12): the row id and outcome, never the IRN/CSID.
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "bill.verify_stamp",
    entityType: "bill_verification",
    entityId: row.id,
    after: { valid: row.valid, eligible: row.eligible },
  });
  res.status(201).json(
    VerifyBillStampResponse.parse({
      invoiceId: row.invoiceId,
      irn: row.irn,
      csid: row.csid,
      valid: row.valid,
      eligible: row.eligible,
      checkedAt: row.checkedAt.toISOString(),
    }),
  );
});

export default router;
