import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { getDb, confirmationsTable, settlementEventsTable } from "@workspace/db";
import {
  ListConfirmationsParams,
  ListConfirmationsResponse,
  CreateConfirmationParams,
  CreateConfirmationBody,
  CreateConfirmationResponse,
  ListSettlementsParams,
  ListSettlementsResponse,
  CreateSettlementParams,
  CreateSettlementBody,
  CreateSettlementResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan, assertBuyerPartyAccess } from "../../modules/auth/rbac";
import { getInvoiceWithLines } from "../../modules/invoice/service";
import { recordConfirmation } from "../../modules/invoice/confirmations";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";
import { requireFlag } from "../../modules/flags/flags";
import { loadForTenant } from "./shared";

// The buyer rails on a single invoice: the BR-02 confirmation workflow
// (flag-gated) and settlement evidence. These are the two surfaces where a
// non-firm principal (buyer_user) can write against a firm's invoice, so the
// scope resolution here is two-sided — see the POST confirmations fork.

const router: IRouter = Router();

// Buyer confirmations are a release-tagged (R1) feature: unreachable when dark.
router.get("/invoices/:id/confirmations", requireFlag("buyer_confirmations"), async (req, res): Promise<void> => {
  assertCan(req.principal, "confirmation.read");
  const params = parseOrThrow(ListConfirmationsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, params.id))
    .orderBy(asc(confirmationsTable.createdAt));
  res.json(ListConfirmationsResponse.parse(rows));
});

// BR-02 confirmation workflow. One write path to the spine, two sides:
//   - The supplier's firm requests confirmation (state=requested) on a stamped
//     invoice (confirmation.write).
//   - The buyer organization responds (confirmed/queried/rejected) via a
//     buyer_user principal scoped to the invoice's buyer Party
//     (confirmation.respond), with confirming user and method captured.
// The route owns this two-sided scope resolution; every rule after "which
// invoice, which caller" — buyer-party pin, TIN gate, the record-level state
// machine over the append-only lineage, the CAS transition, the buyer nudge
// and the audit row — lives in modules/invoice/confirmations.ts.
router.post("/invoices/:id/confirmations", requireFlag("buyer_confirmations"), async (req, res): Promise<void> => {
  const params = parseOrThrow(CreateConfirmationParams, req.params);
  const parsed = parseOrThrow(CreateConfirmationBody, req.body);
  const isRequest = parsed.state === "requested";

  let invoice;
  if (isRequest) {
    assertCan(req.principal, "confirmation.write");
    ({ invoice } = await loadForTenant(req, params.id));
  } else {
    // Buyer-side response: scoped by buyer Party, not by firm tenancy.
    assertCan(req.principal, "confirmation.respond");
    const bundle = await getInvoiceWithLines(params.id);
    if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    invoice = bundle.invoice;
    assertBuyerPartyAccess(req.principal, invoice.buyerPartyId);
  }

  const row = await recordConfirmation(invoice, parsed, req.principal);
  res.status(201).json(CreateConfirmationResponse.parse(row));
});

router.get("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(ListSettlementsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, params.id))
    .orderBy(asc(settlementEventsTable.occurredAt));
  res.json(ListSettlementsResponse.parse(rows));
});

router.post("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "settlement.write");
  const params = parseOrThrow(CreateSettlementParams, req.params);
  const parsed = parseOrThrow(CreateSettlementBody, req.body);
  const { invoice } = await loadForTenant(req, params.id);
  const [row] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: params.id,
      source: parsed.source,
      amount: parsed.amount,
      confidence: parsed.confidence ?? null,
      occurredAt: parsed.occurredAt,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.settlement",
    entityType: "settlement_event",
    entityId: row.id,
    after: { source: row.source, amount: row.amount },
  });
  res.status(201).json(CreateSettlementResponse.parse(row));
});

export default router;
