import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  invoicesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  confirmationsTable,
  settlementEventsTable,
} from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoiceParams,
  GetInvoiceResponse,
  ValidateInvoiceParams,
  ValidateInvoiceResponse,
  SubmitInvoiceParams,
  SubmitInvoiceResponse,
  CancelInvoiceParams,
  CancelInvoiceResponse,
  GetInvoiceUblParams,
  GetInvoiceUblResponse,
  GetInvoiceCanonicalParams,
  GetInvoiceCanonicalResponse,
  GetInvoiceStampParams,
  GetInvoiceStampResponse,
  ListSubmissionAttemptsParams,
  ListSubmissionAttemptsResponse,
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
import { assertCan, assertSameTenant, tenantFirmId } from "../modules/auth/rbac";
import {
  createDraft,
  getInvoiceWithLines,
  buildCanonical,
  validateInvoice,
  submitInvoice,
} from "../modules/invoice/service";
import { canTransition, assertTransition } from "../modules/invoice/lifecycle";
import { serializeToUbl } from "../modules/invoice/canonical";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";

const router: IRouter = Router();

async function loadForTenant(req: { principal: import("../modules/auth/rbac").Principal }, id: string) {
  const bundle = await getInvoiceWithLines(id);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(req.principal, bundle.invoice.firmId);
  return bundle;
}

router.get("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ListInvoicesQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const tenant = tenantFirmId(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  if (status) conditions.push(eq(invoicesTable.status, status as never));
  const rows = conditions.length
    ? await db
        .select()
        .from(invoicesTable)
        .where(and(...conditions))
        .orderBy(asc(invoicesTable.createdAt))
    : await db.select().from(invoicesTable).orderBy(asc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(rows));
});

router.post("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const bundle = await createDraft(
    { firmId, ...parsed.data },
    req.principal.userId,
  );
  res.status(201).json(CreateInvoiceResponse.parse(bundle));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bundle = await loadForTenant(req, params.data.id);
  res.json(GetInvoiceResponse.parse(bundle));
});

router.post("/invoices/:id/validate", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = ValidateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const result = await validateInvoice(params.data.id, req.principal.userId);
  res.json(ValidateInvoiceResponse.parse(result));
});

router.post("/invoices/:id/submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const params = SubmitInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const invoice = await submitInvoice(params.data.id, req.principal.userId);
  res.status(202).json(SubmitInvoiceResponse.parse(invoice));
});

router.post("/invoices/:id/cancel", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = CancelInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
  assertTransition(invoice.status, "cancelled");
  const [row] = await db
    .update(invoicesTable)
    .set({ status: "cancelled" })
    .where(eq(invoicesTable.id, params.data.id))
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.cancel",
    entityType: "invoice",
    entityId: invoice.id,
    before: { status: invoice.status },
    after: { status: "cancelled" },
  });
  res.json(CancelInvoiceResponse.parse(row));
});

router.get("/invoices/:id/ubl", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceUblParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const canonical = await buildCanonical(params.data.id);
  res.json(GetInvoiceUblResponse.parse({ xml: serializeToUbl(canonical) }));
});

router.get("/invoices/:id/canonical", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceCanonicalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const canonical = await buildCanonical(params.data.id);
  res.json(GetInvoiceCanonicalResponse.parse(canonical));
});

router.get("/invoices/:id/stamp", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceStampParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const [stamp] = await db
    .select()
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, params.data.id))
    .orderBy(asc(stampRecordsTable.createdAt))
    .limit(1);
  if (!stamp) {
    res.status(404).json({ error: "No stamp for this invoice" });
    return;
  }
  res.json(GetInvoiceStampResponse.parse(stamp));
});

router.get("/invoices/:id/attempts", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = ListSubmissionAttemptsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await db
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, params.data.id))
    .orderBy(asc(submissionAttemptsTable.attemptNo));
  res.json(ListSubmissionAttemptsResponse.parse(rows));
});

router.get("/invoices/:id/confirmations", async (req, res): Promise<void> => {
  assertCan(req.principal, "confirmation.read");
  const params = ListConfirmationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await db
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, params.data.id))
    .orderBy(asc(confirmationsTable.createdAt));
  res.json(ListConfirmationsResponse.parse(rows));
});

router.post("/invoices/:id/confirmations", async (req, res): Promise<void> => {
  assertCan(req.principal, "confirmation.write");
  const params = CreateConfirmationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateConfirmationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
  const [row] = await db
    .insert(confirmationsTable)
    .values({
      invoiceId: params.data.id,
      buyerPartyId: parsed.data.buyerPartyId,
      state: parsed.data.state,
      method: parsed.data.method ?? null,
      noSetOff: parsed.data.noSetOff ?? false,
    })
    .returning();
  if (parsed.data.state === "confirmed" && canTransition(invoice.status, "confirmed")) {
    await db
      .update(invoicesTable)
      .set({ status: "confirmed" })
      .where(eq(invoicesTable.id, params.data.id));
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.confirmation",
    entityType: "confirmation",
    entityId: row.id,
    after: { state: row.state },
  });
  res.status(201).json(CreateConfirmationResponse.parse(row));
});

router.get("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = ListSettlementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await db
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, params.data.id))
    .orderBy(asc(settlementEventsTable.occurredAt));
  res.json(ListSettlementsResponse.parse(rows));
});

router.post("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "settlement.write");
  const params = CreateSettlementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateSettlementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
  const [row] = await db
    .insert(settlementEventsTable)
    .values({
      invoiceId: params.data.id,
      source: parsed.data.source,
      amount: parsed.data.amount,
      confidence: parsed.data.confidence ?? null,
      occurredAt: parsed.data.occurredAt,
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
