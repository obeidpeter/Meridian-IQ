import { Router, type IRouter } from "express";
import {
  ListFirmApiKeysResponse,
  CreateFirmApiKeyBody,
  CreateFirmApiKeyResponse,
  RevokeFirmApiKeyParams,
  RevokeFirmApiKeyResponse,
  ListFirmWebhooksResponse,
  CreateFirmWebhookBody,
  CreateFirmWebhookResponse,
  DisableFirmWebhookParams,
  DisableFirmWebhookResponse,
  ListFirmWebhookDeliveriesParams,
  ListFirmWebhookDeliveriesResponse,
} from "@workspace/api-zod";
import type {
  FirmApiKeyRow,
  FirmWebhookRow,
  FirmWebhookDeliveryRow,
} from "@workspace/db";
import { parseOrThrow } from "../lib/parse";
import { appendAudit } from "../modules/audit/audit";
import { requireFirmScope, type Principal } from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import {
  listFirmApiKeys,
  mintFirmApiKey,
  revokeFirmApiKey,
} from "../modules/integrations/api-keys";
import {
  createFirmWebhook,
  disableFirmWebhook,
  listFirmWebhooks,
  listWebhookDeliveries,
} from "../modules/integrations/webhooks";

// Firm integrations (contract 0.41.0): API keys + outbound webhooks.
//
// Gate: EXPLICIT firm_admin role check, not a capability (the staff-prefs
// precedent — routes/staff.ts staffSelfScope). Minting a machine credential
// or pointing the firm's event stream at an external URL is firm-level
// administration: firm_staff and client_users act under credentials, they do
// not create them, and no capability in the matrix describes "manage the
// firm's machine access" (adding one would hand it to every role holding a
// broad capability by accident). The explicit check also excludes machine
// principals themselves by construction — an API key's synthetic "api_key"
// role can never mint keys or webhooks (credentials must not self-propagate).
// requireFirmScope pins every query to the caller's own tenant on top of the
// firm-keyed RLS from migration 0022.
function firmAdminScope(principal: Principal): string {
  if (principal.role !== "firm_admin") {
    throw new DomainError(
      "FORBIDDEN",
      "Integration management is a firm-admin surface",
      403,
    );
  }
  return requireFirmScope(principal);
}

const router: IRouter = Router();

function apiKeyBody(row: FirmApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    capabilities: row.capabilities,
    keyPrefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

router.get("/firm-api-keys", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const rows = await listFirmApiKeys(firmId);
  res.json(ListFirmApiKeysResponse.parse(rows.map(apiKeyBody)));
});

router.post("/firm-api-keys", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const parsed = parseOrThrow(CreateFirmApiKeyBody, req.body);
  const { row, secret } = await mintFirmApiKey(
    firmId,
    parsed.name,
    parsed.capabilities,
  );
  // Pointer-only audit: the key id and capability list, NEVER the secret.
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "api_key.create",
    entityType: "firm_api_key",
    entityId: row.id,
    after: { name: row.name, capabilities: row.capabilities },
  });
  res.status(201).json(
    CreateFirmApiKeyResponse.parse({
      id: row.id,
      name: row.name,
      capabilities: row.capabilities,
      keyPrefix: row.keyPrefix,
      // Shown once; only the sha256 is stored.
      secret,
      createdAt: row.createdAt,
    }),
  );
});

router.post("/firm-api-keys/:id/revoke", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const params = parseOrThrow(RevokeFirmApiKeyParams, req.params);
  const row = await revokeFirmApiKey(firmId, params.id);
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "api_key.revoke",
    entityType: "firm_api_key",
    entityId: row.id,
    after: { revokedAt: row.revokedAt?.toISOString() ?? null },
  });
  res.json(RevokeFirmApiKeyResponse.parse(apiKeyBody(row)));
});

function webhookBody(row: FirmWebhookRow) {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    active: row.active,
    secretPrefix: row.secretPrefix,
    createdAt: row.createdAt,
  };
}

router.get("/firm-webhooks", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const rows = await listFirmWebhooks(firmId);
  res.json(ListFirmWebhooksResponse.parse(rows.map(webhookBody)));
});

router.post("/firm-webhooks", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const parsed = parseOrThrow(CreateFirmWebhookBody, req.body);
  const { row, secret } = await createFirmWebhook(
    firmId,
    parsed.url,
    parsed.events,
  );
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "webhook.create",
    entityType: "firm_webhook",
    entityId: row.id,
    after: { events: row.events },
  });
  res.status(201).json(
    CreateFirmWebhookResponse.parse({
      ...webhookBody(row),
      // Shown once; only the sha256 is stored (and used as the signing key —
      // see modules/integrations/webhooks.ts signDeliveryBody).
      secret,
    }),
  );
});

router.post("/firm-webhooks/:id/disable", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const params = parseOrThrow(DisableFirmWebhookParams, req.params);
  const row = await disableFirmWebhook(firmId, params.id);
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "webhook.disable",
    entityType: "firm_webhook",
    entityId: row.id,
    after: { active: row.active },
  });
  res.json(DisableFirmWebhookResponse.parse(webhookBody(row)));
});

function deliveryBody(row: FirmWebhookDeliveryRow) {
  return {
    id: row.id,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

router.get(
  "/firm-webhooks/:id/deliveries",
  async (req, res): Promise<void> => {
    const firmId = firmAdminScope(req.principal);
    const params = parseOrThrow(ListFirmWebhookDeliveriesParams, req.params);
    const rows = await listWebhookDeliveries(firmId, params.id);
    res.json(ListFirmWebhookDeliveriesResponse.parse(rows.map(deliveryBody)));
  },
);

export default router;
