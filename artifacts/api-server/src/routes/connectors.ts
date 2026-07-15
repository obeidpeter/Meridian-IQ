import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { getDb, erpConnectionsTable, erpSyncRunsTable, outboxTable } from "@workspace/db";
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
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  assertSameTenant,
  requireFirmScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import { CONNECTORS, findConnector } from "../modules/connectors/implementations";
// Importing the engine registers the erp.sync outbox handler.
import "../modules/connectors/engine";

// ERP connector surfaces (PL-03, INT-06), gated by the R2 `erp_connectors`
// flag. Connections are firm-tenant resources; syncs run async via the outbox.

const router: IRouter = Router();

router.get("/connectors", requireFlag("erp_connectors"), async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.read");
  res.json(
    ListConnectorsResponse.parse(
      Object.values(CONNECTORS).map((c) => ({
        key: c.key,
        name: c.name,
        description: c.description,
      })),
    ),
  );
});

router.get("/connections", requireFlag("erp_connectors"), async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.read");
  const query = ListErpConnectionsQueryParams.safeParse(req.query);
  const clientPartyId = query.success ? query.data.clientPartyId : undefined;
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
});

router.post("/connections", requireFlag("erp_connectors"), async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateErpConnectionBody, req.body);
  if (!findConnector(parsed.connectorKey)) {
    throw new DomainError(
      "UNKNOWN_CONNECTOR",
      `No connector registered for "${parsed.connectorKey}"`,
      422,
    );
  }
  await assertPartyAccess(req.principal, parsed.clientPartyId);
  const [row] = await getDb()
    .insert(erpConnectionsTable)
    .values({
      firmId,
      clientPartyId: parsed.clientPartyId,
      connectorKey: parsed.connectorKey,
      authConfig: parsed.authConfig ?? null,
      fieldMap: (parsed.fieldMap ?? null) as Record<string, string> | null,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "connector.connection_created",
    entityType: "erp_connection",
    entityId: row.id,
    after: { connectorKey: row.connectorKey, clientPartyId: row.clientPartyId },
  });
  res.status(201).json(CreateErpConnectionResponse.parse(row));
});

router.post("/connections/:id/sync", requireFlag("erp_connectors"), async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.write");
  const params = parseOrThrow(SyncErpConnectionParams, req.params);
  const [connection] = await getDb()
    .select()
    .from(erpConnectionsTable)
    .where(eq(erpConnectionsTable.id, params.id))
    .limit(1);
  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
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
  await getDb().insert(outboxTable).values({
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
});

router.get("/connections/:id/runs", requireFlag("erp_connectors"), async (req, res): Promise<void> => {
  assertCan(req.principal, "connector.read");
  const params = parseOrThrow(ListErpSyncRunsParams, req.params);
  const [connection] = await getDb()
    .select({ firmId: erpConnectionsTable.firmId })
    .from(erpConnectionsTable)
    .where(eq(erpConnectionsTable.id, params.id))
    .limit(1);
  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  assertSameTenant(req.principal, connection.firmId);
  const rows = await getDb()
    .select()
    .from(erpSyncRunsTable)
    .where(eq(erpSyncRunsTable.connectionId, params.id))
    .orderBy(desc(erpSyncRunsTable.startedAt));
  res.json(ListErpSyncRunsResponse.parse(rows));
});

export default router;
