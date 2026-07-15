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
} from "../modules/buyer/service";

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
        .map((f) => ({
          id: f.invoice.id,
          invoiceNumber: f.invoice.invoiceNumber,
          supplierPartyId: f.invoice.supplierPartyId,
          supplierName:
            nameById.get(f.invoice.supplierPartyId) ?? "Unknown supplier",
          status: f.invoice.status,
          grandTotal: f.invoice.grandTotal,
          vatTotal: f.invoice.vatTotal,
          issueDate: f.invoice.issueDate,
          dueDate: f.invoice.dueDate,
          confirmationState: f.latestConfirmation ?? "none",
          stampValid: f.stamped,
          eligible: f.stamped && f.eligible,
        })),
    ),
  );
});

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
