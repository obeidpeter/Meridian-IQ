import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, invoicesTable, partiesTable, settlementEventsTable } from "@workspace/db";
import {
  ListBuyerInvoicesQueryParams,
  ListBuyerInvoicesResponse,
  FlagPaymentParams,
  FlagPaymentBody,
  FlagPaymentResponse,
  ListBuyerSuppliersResponse,
  GetBuyerExposureResponse,
  GetBuyerScoreboardResponse,
  GetBuyerSupplierDetailParams,
  GetBuyerSupplierDetailResponse,
  BulkRespondConfirmationsBody,
  BulkRespondConfirmationsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertBuyerPartyAccess,
  buyerPartyId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import {
  canTransition,
  recordTransition,
} from "../modules/invoice/lifecycle";
import {
  loadBuyerBook,
  getOrRefreshExposure,
  computeScoreboard,
  buyerInvoiceView,
  supplierDetail,
  respondBulk,
} from "../modules/buyer/service";
import { sendCsvAttachment, toCsv } from "../lib/csv";

// Buyer Rails v1 (BR-01, BR-02, BR-04, BR-05). Every surface is scoped to the
// caller's buyer Party (buyer principals run RLS-bypassed, so this route-level
// scoping is the tenancy boundary) and gated by the R2 `buyer_rails` flag.

const router: IRouter = Router();

// Buyer principals carry no firm; the flag is evaluated globally.
const requireBuyerRails = requireFlag("buyer_rails", { global: true });

router.get("/buyer/invoices", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const query = ListBuyerInvoicesQueryParams.safeParse(req.query);
  const stateFilter = query.success ? query.data.confirmationState : undefined;

  const book = await loadBuyerBook(party);
  const supplierIds = [...new Set(book.map((f) => f.invoice.supplierPartyId))];
  const suppliers = supplierIds.length
    ? await getDb()
        .select({ id: partiesTable.id, legalName: partiesTable.legalName })
        .from(partiesTable)
        .where(inArray(partiesTable.id, supplierIds))
    : [];
  const nameById = new Map(suppliers.map((s) => [s.id, s.legalName]));
  res.json(
    ListBuyerInvoicesResponse.parse(
      book
        .filter((f) =>
          stateFilter
            ? (f.latestConfirmation ?? "none") === stateFilter
            : true,
        )
        .map((f) =>
          buyerInvoiceView(f, nameById.get(f.invoice.supplierPartyId)),
        ),
    ),
  );
});

// Awaiting-confirmation worklist as a CSV attachment (contract 0.42.0): the
// same book/latest-lineage read as the list above with
// confirmationState=requested, shipped through the shared CSV helpers
// (formula-injection-safe — supplier names and invoice numbers are
// tenant-authored free text opened in Excel).
router.get("/buyer/confirmations/export", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const awaiting = (await loadBuyerBook(party)).filter(
    (f) => f.latestConfirmation === "requested",
  );
  const supplierIds = [
    ...new Set(awaiting.map((f) => f.invoice.supplierPartyId)),
  ];
  const suppliers = supplierIds.length
    ? await getDb()
        .select({ id: partiesTable.id, legalName: partiesTable.legalName })
        .from(partiesTable)
        .where(inArray(partiesTable.id, supplierIds))
    : [];
  const nameById = new Map(suppliers.map((s) => [s.id, s.legalName]));
  const csv = toCsv(
    [
      "invoiceNumber",
      "supplierName",
      "issueDate",
      "dueDate",
      "currency",
      "grandTotal",
      "requestedAt",
    ],
    awaiting.map((f) => [
      f.invoice.invoiceNumber,
      nameById.get(f.invoice.supplierPartyId) ?? "Unknown supplier",
      f.invoice.issueDate,
      f.invoice.dueDate,
      f.invoice.currency,
      f.invoice.grandTotal,
      f.latestConfirmationAt?.toISOString() ?? "",
    ]),
  );
  sendCsvAttachment(res, "pending-confirmations.csv", csv);
});

// Bulk confirmation response (contract 0.42.0): per-invoice outcomes, skips
// reported never silent — the semantics live in the service
// (modules/buyer/service.ts respondBulk), one savepoint per item. Gated by
// BOTH buyer_rails (this is a buyer-portal surface) and buyer_confirmations
// (a dark confirmation workflow must be unreachable through the batch door
// exactly as it is through the single-invoice door, PL-02).
router.post(
  "/buyer/confirmations/bulk",
  requireBuyerRails,
  requireFlag("buyer_confirmations", { global: true }),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "confirmation.respond");
    const body = parseOrThrow(BulkRespondConfirmationsBody, req.body);
    const result = await respondBulk(
      req.principal,
      body.invoiceIds,
      body.method,
      body.noSetOff ?? false,
    );
    res.json(BulkRespondConfirmationsResponse.parse(result));
  },
);

// BR-04: buyer marks an invoice payment as scheduled or paid. Each flag is one
// append-only SettlementEvent with source=buyer_flag and the flagging user
// recorded; a `paid` flag settles the invoice (an allowed settlement source in
// the mandatory-source hierarchy, Plan 7.4).
router.post("/invoices/:id/payment-flags", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "settlement.flag");
  const params = parseOrThrow(FlagPaymentParams, req.params);
  const body = parseOrThrow(FlagPaymentBody, req.body);
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.id))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertBuyerPartyAccess(req.principal, invoice.buyerPartyId);
  if (!["stamped", "confirmed", "settled"].includes(invoice.status)) {
    throw new DomainError(
      "NOT_FLAGGABLE",
      `Invoice is ${invoice.status}; only stamped, confirmed or settled invoices carry payment flags`,
      409,
    );
  }
  // The contract types amount as a bare string; reject anything that is not a
  // plain decimal before it reaches the numeric column (400, not a DB 500).
  if (
    body.amount !== undefined &&
    !/^\d+(\.\d{1,2})?$/.test(body.amount)
  ) {
    throw new DomainError(
      "INVALID_AMOUNT",
      "amount must be a plain decimal string (e.g. 120000.00)",
      400,
    );
  }
  const occurredAt = body.occurredAt
    ? new Date(body.occurredAt)
    : new Date();
  const [event] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: invoice.id,
      source: "buyer_flag",
      amount: body.amount ?? invoice.grandTotal,
      paymentStatus: body.paymentStatus,
      actorId: req.principal.userId,
      occurredAt,
    })
    .returning();
  if (
    body.paymentStatus === "paid" &&
    canTransition(invoice.status, "settled")
  ) {
    // Compare-and-set: a concurrent cancel/credit wins; the flag event stands
    // as lineage but the settled transition is skipped.
    const [moved] = await getDb()
      .update(invoicesTable)
      .set({ status: "settled" })
      .where(
        and(
          eq(invoicesTable.id, invoice.id),
          eq(invoicesTable.status, invoice.status),
        ),
      )
      .returning({ id: invoicesTable.id });
    if (moved) {
      await recordTransition({
        invoiceId: invoice.id,
        firmId: invoice.firmId,
        fromStatus: invoice.status,
        toStatus: "settled",
        actorId: req.principal.userId,
        actorRole: req.principal.role,
        reason: "buyer_flag:paid",
      });
    }
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.payment_flag",
    entityType: "settlement_event",
    entityId: event.id,
    after: { paymentStatus: event.paymentStatus, amount: event.amount },
  });
  res.status(201).json(FlagPaymentResponse.parse(event));
});

// BR-01: supplier verification view — per-supplier stamp validity and
// input-VAT exposure, served from the (at least daily) snapshot.
router.get("/buyer/suppliers", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const exposure = await getOrRefreshExposure(party);
  res.json(ListBuyerSuppliersResponse.parse(exposure.breakdown));
});

// Supplier drill-down (contract 0.42.0): the one-supplier aggregate plus the
// buyer's invoices from that supplier, always computed live from the caller's
// own book — a supplier with no invoices to this buyer is a 404 in the
// service, indistinguishable from one that does not exist.
router.get("/buyer/suppliers/:id", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const params = parseOrThrow(GetBuyerSupplierDetailParams, req.params);
  const detail = await supplierDetail(party, params.id);
  res.json(GetBuyerSupplierDetailResponse.parse(detail));
});

router.get("/buyer/exposure", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const exposure = await getOrRefreshExposure(party);
  res.json(GetBuyerExposureResponse.parse(exposure));
});

// BR-05: the supplier compliance scoreboard.
router.get("/buyer/scoreboard", requireBuyerRails, async (req, res): Promise<void> => {
  assertCan(req.principal, "buyer.rails.read");
  const party = buyerPartyId(req.principal);
  const scoreboard = await computeScoreboard(party);
  res.json(GetBuyerScoreboardResponse.parse(scoreboard));
});

export default router;
