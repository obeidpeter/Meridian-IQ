import { Router, type IRouter } from "express";
import {
  ListRecurringInvoicesResponse,
  CreateRecurringInvoiceBody,
  CreateRecurringInvoiceResponse,
  UpdateRecurringInvoiceParams,
  UpdateRecurringInvoiceBody,
  UpdateRecurringInvoiceResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  setTemplateActive,
} from "../modules/invoice/recurring";

const router: IRouter = Router();

router.get("/recurring-invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  // Same visibility model as the invoice list: firm principals see the firm's
  // templates, cross-tenant staff the whole spine, a client_user (SEC-03)
  // only templates drafting for its own party.
  const rows = await listTemplates(
    tenantFirmId(req.principal),
    clientPartyScope(req.principal),
  );
  res.json(ListRecurringInvoicesResponse.parse(rows));
});

router.post("/recurring-invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = CreateRecurringInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // SEC-03: a client_user may only set up recurring drafts for its own party.
  assertClientPartyScope(req.principal, parsed.data.supplierPartyId);
  const template = await createTemplate(
    firmId,
    parsed.data,
    req.principal.userId,
  );
  res.status(201).json(CreateRecurringInvoiceResponse.parse(template));
});

router.patch("/recurring-invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = UpdateRecurringInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateRecurringInvoiceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const template = await getTemplate(params.data.id);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  assertSameTenant(req.principal, template.firmId);
  assertClientPartyScope(req.principal, template.supplierPartyId);
  const updated = await setTemplateActive(
    params.data.id,
    body.data.active,
    req.principal.userId,
  );
  res.json(UpdateRecurringInvoiceResponse.parse(updated));
});

export default router;
