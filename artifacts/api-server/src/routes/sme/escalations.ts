import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { getDb, escalationsTable } from "@workspace/db";
import {
  ListEscalationsParams,
  ListEscalationsResponse,
  EscalateInvoiceParams,
  EscalateInvoiceBody,
  EscalateInvoiceResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { loadForTenant } from "../invoices";
import { appendAudit } from "../../modules/audit/audit";
import { openInvoiceCase } from "../../modules/desk/cases";

const router: IRouter = Router();

router.get("/invoices/:id/escalations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(ListEscalationsParams, req.params);
  // SEC-03: the shared tenancy loader keeps a client_user from reaching a
  // sibling client's invoices; without it the escalation read/write routes
  // would let a client_user act on any invoice in the firm.
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(escalationsTable)
    .where(eq(escalationsTable.invoiceId, params.id))
    .orderBy(desc(escalationsTable.createdAt));
  res.json(ListEscalationsResponse.parse(rows));
});

router.post("/invoices/:id/escalations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(EscalateInvoiceParams, req.params);
  const parsed = parseOrThrow(EscalateInvoiceBody, req.body);
  const { invoice } = await loadForTenant(req, params.id);
  const [row] = await getDb()
    .insert(escalationsTable)
    .values({
      invoiceId: invoice.id,
      firmId: invoice.firmId,
      clientPartyId: invoice.supplierPartyId,
      reason: parsed.reason,
      errorCode: parsed.errorCode ?? null,
      context: parsed.context ?? null,
    })
    .returning();
  // SME-06: an escalation is not just a record — it enters the Compliance
  // Desk work queue with full context, no re-entry by the operator.
  await openInvoiceCase({
    invoiceId: invoice.id,
    title: `${invoice.invoiceNumber} escalated by client`,
    errorCode: row.errorCode,
    priority: "high",
  });
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.escalate",
    entityType: "escalation",
    entityId: row.id,
    after: { reason: row.reason, errorCode: row.errorCode },
  });
  res.status(201).json(EscalateInvoiceResponse.parse(row));
});

export default router;
