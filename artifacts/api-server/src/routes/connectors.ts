import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  erpConnectionsTable,
  erpSyncRunsTable,
  outboxTable,
} from "@workspace/db";
import {
  ListConnectorsResponse,
  ListErpConnectionsQueryParams,
  ListErpConnectionsResponse,
  CreateErpConnectionBody,
  CreateErpConnectionResponse,
  SyncErpConnectionParams,
  SyncErpConnectionResponse,
  ListErpSyncRunsParams,
  ListErpSyncRunsResponse,
  GetIntegrationReadinessResponse,
  TestErpConnectionBody,
  TestErpConnectionResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  assertSameTenant,
  narrowToClientPartyScope,
  requireFirmScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import {
  CONNECTORS,
  findConnector,
} from "../modules/connectors/implementations";
import { isBankRelayConfigured } from "../modules/statements/feed-contract";
// Importing the engine registers the erp.sync outbox handler.
import "../modules/connectors/engine";

// ERP connector surfaces (PL-03, INT-06), gated by the R2 `erp_connectors`
// flag. Connections are firm-tenant resources; syncs run async via the outbox.

const router: IRouter = Router();

function normalizeConnectorConfig(
  connector: (typeof CONNECTORS)[string],
  config: Record<string, unknown>,
): Record<string, string> {
  const fields = new Map(
    connector.configurationFields.map((field) => [field.key, field]),
  );
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    const field = fields.get(key);
    if (!field) {
      throw new DomainError(
        "CONNECTOR_CONFIG_UNKNOWN_FIELD",
        `Configuration field "${key}" is not supported by this connector`,
        422,
      );
    }
    if (typeof value !== "string") {
      throw new DomainError(
        "CONNECTOR_CONFIG_INVALID",
        `${field.label} must be text`,
        422,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length > 2_048 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new DomainError(
        "CONNECTOR_CONFIG_INVALID",
        `${field.label} contains an unsupported value`,
        422,
      );
    }
    if (trimmed) normalized[key] = trimmed;
  }
  for (const field of connector.configurationFields) {
    if (field.required && !normalized[field.key]) {
      throw new DomainError(
        "CONNECTOR_CONFIG_REQUIRED",
        `${field.label} is required`,
        422,
      );
    }
  }
  return normalized;
}

const readinessEntries = () => [
  {
    key: "tax_access_point",
    label: "FIRS access point",
    category: "tax" as const,
    configured: Boolean(process.env.RAIL_PRIMARY_URL?.trim()),
    note: "Invoice submission and stamp retrieval use the configured primary access-point relay.",
  },
  {
    key: "payments",
    label: "Payment provider",
    category: "payments" as const,
    configured: Boolean(process.env.PAYMENT_PROVIDER_URL?.trim()),
    note: "Hosted checkout initialization uses a deployment-owned payment relay.",
  },
  {
    key: "invoice_payments",
    label: "Invoice Room checkout",
    category: "payments" as const,
    configured: Boolean(process.env.INVOICE_PAYMENT_PROVIDER_URL?.trim()),
    note: "Buyer checkout links are priced server-side and opened through a deployment-owned payment relay.",
  },
  {
    key: "banking",
    label: "Open-banking feed",
    category: "banking" as const,
    configured: isBankRelayConfigured(),
    note: "Statement lines enter through the same consented reconciliation path as file uploads.",
  },
  {
    key: "messaging",
    label: "Messaging relay",
    category: "messaging" as const,
    configured: Boolean(process.env.MESSAGING_WEBHOOK_URL?.trim()),
    note: "Invitations, reminders and access requests are sent through the trusted relay boundary.",
  },
  {
    key: "accounting",
    label: "ERP relay",
    category: "accounting" as const,
    configured: CONNECTORS["meridian-relay"].isConfigured(),
    note: "Live accounting packages connect through the canonical Valo adapter protocol.",
  },
];

router.get("/integration-readiness", async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.read");
  const entries = readinessEntries();
  res.json(
    GetIntegrationReadinessResponse.parse({
      generatedAt: new Date(),
      liveCount: entries.filter((entry) => entry.configured).length,
      totalCount: entries.length,
      items: entries.map(({ configured, ...entry }) => ({
        ...entry,
        status: configured ? "live" : "sandbox",
        setupHref: "/integrations",
      })),
    }),
  );
});

router.get(
  "/connectors",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.read");
    res.json(
      ListConnectorsResponse.parse(
        Object.values(CONNECTORS).map((c) => ({
          key: c.key,
          name: c.name,
          description: c.description,
          mode: c.mode,
          configured: c.isConfigured(),
          configurationFields: c.configurationFields,
        })),
      ),
    );
  },
);

router.post(
  "/connections/test",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.write");
    const body = parseOrThrow(TestErpConnectionBody.strict(), req.body);
    const connector = findConnector(body.connectorKey);
    if (!connector || !connector.isConfigured()) {
      throw new DomainError(
        "CONNECTOR_UNAVAILABLE",
        "This connector is not configured on the server",
        422,
      );
    }
    const authConfig = normalizeConnectorConfig(
      connector,
      body.authConfig ?? {},
    );
    const result = await connector.authenticate(authConfig);
    if (!result.ok) {
      throw new DomainError(
        "CONNECTOR_AUTH_FAILED",
        result.error ?? "Connector rejected the configuration",
        422,
      );
    }
    res.json(
      TestErpConnectionResponse.parse({
        ok: true,
        message: "Connection test passed",
      }),
    );
  },
);

router.get(
  "/connections",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.read");
    const query = parseOrThrow(ListErpConnectionsQueryParams, req.query);
    const clientPartyId = narrowToClientPartyScope(
      req.principal,
      query.clientPartyId,
    );
    const tenant = tenantFirmId(req.principal);
    const conditions = [];
    if (tenant) conditions.push(eq(erpConnectionsTable.firmId, tenant));
    if (clientPartyId)
      conditions.push(eq(erpConnectionsTable.clientPartyId, clientPartyId));
    const rows = await getDb()
      .select()
      .from(erpConnectionsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(erpConnectionsTable.createdAt));
    res.json(ListErpConnectionsResponse.parse(rows));
  },
);

router.post(
  "/connections",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.write");
    const firmId = requireFirmScope(req.principal);
    const parsed = parseOrThrow(CreateErpConnectionBody, req.body);
    const connector = findConnector(parsed.connectorKey);
    if (!connector || !connector.isConfigured()) {
      throw new DomainError(
        "UNKNOWN_CONNECTOR",
        `No configured connector is available for "${parsed.connectorKey}"`,
        422,
      );
    }
    const authConfig = normalizeConnectorConfig(
      connector,
      parsed.authConfig ?? {},
    );
    // Sandbox checks are local and safe inside the request transaction. A live
    // relay round-trip belongs on /connections/test (NO_CONTEXT) so a slow
    // provider never pins the tenant transaction; the worker authenticates
    // again before every pull.
    if (connector.mode === "sandbox") {
      const authentication = await connector.authenticate(authConfig);
      if (!authentication.ok) {
        throw new DomainError(
          "CONNECTOR_AUTH_FAILED",
          authentication.error ?? "Connector rejected the configuration",
          422,
        );
      }
    }
    await assertPartyAccess(req.principal, parsed.clientPartyId);
    const [row] = await getDb()
      .insert(erpConnectionsTable)
      .values({
        firmId,
        clientPartyId: parsed.clientPartyId,
        connectorKey: parsed.connectorKey,
        authConfig: Object.keys(authConfig).length ? authConfig : null,
        fieldMap: (parsed.fieldMap ?? null) as Record<string, string> | null,
      })
      .returning();
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "connector.connection_created",
      entityType: "erp_connection",
      entityId: row.id,
      after: {
        connectorKey: row.connectorKey,
        clientPartyId: row.clientPartyId,
      },
    });
    res.status(201).json(CreateErpConnectionResponse.parse(row));
  },
);

router.post(
  "/connections/:id/sync",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.write");
    const params = parseOrThrow(SyncErpConnectionParams, req.params);
    const [connection] = await getDb()
      .select()
      .from(erpConnectionsTable)
      .where(eq(erpConnectionsTable.id, params.id))
      .limit(1);
    if (!connection) {
      throw new DomainError("NOT_FOUND", "Connection not found", 404);
    }
    assertSameTenant(req.principal, connection.firmId);
    if (connection.status === "paused") {
      throw new DomainError("CONNECTION_PAUSED", "Connection is paused", 409);
    }
    // Create the run marker synchronously so the caller has something to watch,
    // then hand the pull to the worker via the outbox (async, INT-09 pattern).
    const [run] = await getDb()
      .insert(erpSyncRunsTable)
      .values({
        connectionId: connection.id,
        status: "running",
        fromCursor: connection.cursor,
      })
      .returning();
    await getDb()
      .insert(outboxTable)
      .values({
        aggregateType: "erp_connection",
        aggregateId: connection.id,
        type: "erp.sync",
        payload: { connectionId: connection.id, requestRunId: run.id },
      });
    await appendAudit({
      actorId: req.principal.userId,
      firmId: connection.firmId,
      action: "connector.sync_requested",
      entityType: "erp_connection",
      entityId: connection.id,
    });
    res.status(202).json(SyncErpConnectionResponse.parse(run));
  },
);

router.get(
  "/connections/:id/runs",
  requireFlag("erp_connectors"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "connector.read");
    const params = parseOrThrow(ListErpSyncRunsParams, req.params);
    const [connection] = await getDb()
      .select({ firmId: erpConnectionsTable.firmId })
      .from(erpConnectionsTable)
      .where(eq(erpConnectionsTable.id, params.id))
      .limit(1);
    if (!connection) {
      throw new DomainError("NOT_FOUND", "Connection not found", 404);
    }
    assertSameTenant(req.principal, connection.firmId);
    const rows = await getDb()
      .select()
      .from(erpSyncRunsTable)
      .where(eq(erpSyncRunsTable.connectionId, params.id))
      .orderBy(desc(erpSyncRunsTable.startedAt));
    res.json(ListErpSyncRunsResponse.parse(rows));
  },
);

export default router;
