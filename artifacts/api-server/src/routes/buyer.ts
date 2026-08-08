import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, invoicesTable, partiesTable } from "@workspace/db";
import {
  ListBuyerInvoicesQueryParams,
  ListBuyerInvoicesResponse,
  GetBuyerInvoiceParams,
  GetBuyerInvoiceResponse,
  GetBuyerInvoiceSummaryResponse,
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
import { parseOrThrow, resolvePaymentFlagAmount } from "../lib/parse";
import {
  assertCan,
  assertBuyerPartyAccess,
  buyerPartyId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import { canTransition, recordTransition } from "../modules/invoice/lifecycle";
import {
  loadBuyerBook,
  getOrRefreshExposure,
  computeScoreboard,
  buyerInvoiceView,
  summarizeBuyerBook,
  supplierDetail,
  respondBulk,
} from "../modules/buyer/service";
import { sendCsvAttachment, toCsv } from "../lib/csv";
import { appendSettlementEvent } from "../modules/invoice/settlement";

// Buyer Rails v1 (BR-01, BR-02, BR-04, BR-05). Every surface is scoped to the
// caller's buyer Party (buyer principals run RLS-bypassed, so this route-level
// scoping is the tenancy boundary) and gated by the R2 `buyer_rails` flag.

const router: IRouter = Router();

// Buyer principals carry no firm; the flag is evaluated globally.
const requireBuyerRails = requireFlag("buyer_rails", { global: true });
const BUYER_CONFIRMATION_EXPORT_CAP = 5_000;

router.get(
  "/buyer/invoices",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const query = parseOrThrow(ListBuyerInvoicesQueryParams, req.query);

    const book = await loadBuyerBook(party, {
      limit: query.limit,
      offset: query.offset,
      confirmationState: query.confirmationState,
      search: query.search,
    });
    const supplierIds = [
      ...new Set(book.map((f) => f.invoice.supplierPartyId)),
    ];
    const suppliers = supplierIds.length
      ? await getDb()
          .select({ id: partiesTable.id, legalName: partiesTable.legalName })
          .from(partiesTable)
          .where(inArray(partiesTable.id, supplierIds))
      : [];
    const nameById = new Map(suppliers.map((s) => [s.id, s.legalName]));
    res.json(
      ListBuyerInvoicesResponse.parse(
        book.map((f) =>
          buyerInvoiceView(f, nameById.get(f.invoice.supplierPartyId)),
        ),
      ),
    );
  },
);

router.get(
  "/buyer/invoices/summary",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const summary = await summarizeBuyerBook(buyerPartyId(req.principal));
    res.json(GetBuyerInvoiceSummaryResponse.parse(summary));
  },
);

router.get(
  "/buyer/invoices/:id",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const params = parseOrThrow(GetBuyerInvoiceParams, req.params);
    const [fact] = await loadBuyerBook(party, {
      limit: 1,
      offset: 0,
      invoiceId: params.id,
    });
    if (!fact) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    const [supplier] = await getDb()
      .select({ legalName: partiesTable.legalName })
      .from(partiesTable)
      .where(eq(partiesTable.id, fact.invoice.supplierPartyId))
      .limit(1);
    res.json(
      GetBuyerInvoiceResponse.parse(
        buyerInvoiceView(fact, supplier?.legalName),
      ),
    );
  },
);

// Awaiting-confirmation worklist as a CSV attachment (contract 0.42.0): the
// same book/latest-lineage read as the list above with
// confirmationState=requested, shipped through the shared CSV helpers
// (formula-injection-safe — supplier names and invoice numbers are
// tenant-authored free text opened in Excel).
router.get(
  "/buyer/confirmations/export",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const awaiting = await loadBuyerBook(party, {
      limit: BUYER_CONFIRMATION_EXPORT_CAP + 1,
      offset: 0,
      confirmationState: "requested",
    });
    if (awaiting.length > BUYER_CONFIRMATION_EXPORT_CAP) {
      throw new DomainError(
        "EXPORT_TOO_LARGE",
        `Pending confirmations export exceeds ${BUYER_CONFIRMATION_EXPORT_CAP} rows`,
        413,
      );
    }
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
  },
);

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
router.post(
  "/invoices/:id/payment-flags",
  requireBuyerRails,
  async (req, res): Promise<void> => {
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
    // The shared payment-flag amount guard (lib/parse.ts) — the same guard the
    // bills payment-flag route applies.
    const amount = resolvePaymentFlagAmount(
      body.paymentStatus,
      body.amount,
      invoice.grandTotal,
    );
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
    const { event, created } = await appendSettlementEvent(
      {
        invoiceId: invoice.id,
        source: "buyer_flag",
        amount,
        paymentStatus: body.paymentStatus,
        actorId: req.principal.userId,
        externalReference: `buyer-flag:${invoice.id}:${req.principal.userId}:${body.paymentStatus}`,
        occurredAt,
      },
      { compareOccurredAt: body.occurredAt !== undefined },
    );
    if (
      created &&
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
    if (created) {
      await appendAudit({
        actorId: req.principal.userId,
        firmId: invoice.firmId,
        action: "invoice.payment_flag",
        entityType: "settlement_event",
        entityId: event.id,
        after: { paymentStatus: event.paymentStatus, amount: event.amount },
      });
    }
    res.status(201).json(FlagPaymentResponse.parse(event));
  },
);

// BR-01: supplier verification view — per-supplier stamp validity and
// input-VAT exposure, served from the (at least daily) snapshot.
router.get(
  "/buyer/suppliers",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const exposure = await getOrRefreshExposure(party);
    res.json(ListBuyerSuppliersResponse.parse(exposure.breakdown));
  },
);

// Supplier drill-down (contract 0.42.0): the one-supplier aggregate plus the
// buyer's invoices from that supplier, always computed live from the caller's
// own book — a supplier with no invoices to this buyer is a 404 in the
// service, indistinguishable from one that does not exist.
router.get(
  "/buyer/suppliers/:id",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const params = parseOrThrow(GetBuyerSupplierDetailParams, req.params);
    const detail = await supplierDetail(party, params.id);
    res.json(GetBuyerSupplierDetailResponse.parse(detail));
  },
);

router.get(
  "/buyer/exposure",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const exposure = await getOrRefreshExposure(party);
    res.json(GetBuyerExposureResponse.parse(exposure));
  },
);

// BR-05: the supplier compliance scoreboard.
router.get(
  "/buyer/scoreboard",
  requireBuyerRails,
  async (req, res): Promise<void> => {
    assertCan(req.principal, "buyer.rails.read");
    const party = buyerPartyId(req.principal);
    const scoreboard = await computeScoreboard(party);
    res.json(GetBuyerScoreboardResponse.parse(scoreboard));
  },
);

export default router;
