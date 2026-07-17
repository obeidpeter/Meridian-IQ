import { Router, type IRouter } from "express";
import {
  ListRecurringInvoicesResponse,
  CreateRecurringInvoiceBody,
  CreateRecurringInvoiceResponse,
  UpdateRecurringInvoiceParams,
  UpdateRecurringInvoiceBody,
  UpdateRecurringInvoiceResponse,
  ListRecurringSuggestionsQueryParams,
  ListRecurringSuggestionsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  setTemplateActive,
} from "../modules/invoice/recurring";
import { listRecurringSuggestions } from "../modules/invoice/recurring-suggest";

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

// Deterministic "make this recurring?" suggestions (exhaust idea #3): mined
// on demand from the client's own invoice history, nothing stored, no model.
// Same SEC-03 resolution as client statements: a client_user is pinned to its
// own party; a firm principal names the client.
router.get("/recurring-suggestions", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListRecurringSuggestionsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  const target = clientPartyScope(req.principal) ?? query.clientPartyId;
  if (!target) {
    throw new DomainError("MISSING_CLIENT", "clientPartyId is required", 400);
  }
  assertClientPartyScope(req.principal, target);
  const suggestions = await listRecurringSuggestions(firmId, target);
  res.json(ListRecurringSuggestionsResponse.parse(suggestions));
});

router.post("/recurring-invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateRecurringInvoiceBody, req.body);
  // SEC-03: a client_user may only set up recurring drafts for its own party.
  assertClientPartyScope(req.principal, parsed.supplierPartyId);
  const template = await createTemplate(
    firmId,
    parsed,
    req.principal.userId,
  );
  res.status(201).json(CreateRecurringInvoiceResponse.parse(template));
});

router.patch("/recurring-invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(UpdateRecurringInvoiceParams, req.params);
  const body = parseOrThrow(UpdateRecurringInvoiceBody, req.body);
  const template = await getTemplate(params.id);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  assertSameTenant(req.principal, template.firmId);
  assertClientPartyScope(req.principal, template.supplierPartyId);
  const updated = await setTemplateActive(
    params.id,
    body.active,
    req.principal.userId,
  );
  res.json(UpdateRecurringInvoiceResponse.parse(updated));
});

export default router;
