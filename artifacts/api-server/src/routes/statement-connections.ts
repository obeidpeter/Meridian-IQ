import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  statementConnectionsTable,
  statementSyncRunsTable,
  partiesTable,
  outboxTable,
  type StatementConnection,
  type StatementSyncRun,
} from "@workspace/db";
import {
  ListStatementConnectorsResponse,
  ListStatementConnectionsResponse,
  CreateStatementConnectionBody,
  CreateStatementConnectionResponse,
  SyncStatementConnectionParams,
  SyncStatementConnectionResponse,
  ListStatementSyncRunsParams,
  ListStatementSyncRunsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  assertSameTenant,
  requireFirmScope,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import {
  STATEMENT_FEED_CONNECTORS,
  findFeedConnector,
} from "../modules/statements/feed-contract";
// Importing the engine registers the statement.feed_sync outbox handler.
import "../modules/statements/feed-engine";

// Bank-feed connection surfaces (Wave C), gated by the opt-in `bank_feeds`
// flag. Connections are firm-tenant resources managed by firm STAFF only:
// every route asserts `statement.write`, which the role matrix grants to
// firm_admin/firm_staff and deliberately NOT to client_user (SEC-03 — a
// client may read its statements but never wire up a feed) nor to the
// cross-tenant operator/auditor roles. Syncs run async via the outbox; the
// pulled lines land through the ordinary ingestStatement path (see
// modules/statements/feed-engine.ts).

const router: IRouter = Router();

// The contract carries plain-string timestamps for these resources, so the
// views serialize dates explicitly instead of parsing raw rows.
function connectionView(
  row: StatementConnection,
  clientName: string | null,
): Record<string, unknown> {
  return {
    id: row.id,
    connectorKey: row.connectorKey,
    clientPartyId: row.clientPartyId,
    clientName,
    status: row.status,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function runView(row: StatementSyncRun): Record<string, unknown> {
  return {
    id: row.id,
    connectionId: row.connectionId,
    status: row.status,
    linesPulled: row.linesPulled,
    statementId: row.statementId,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

router.get(
  "/statement-connectors",
  requireFlag("bank_feeds"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    res.json(
      ListStatementConnectorsResponse.parse(
        Object.values(STATEMENT_FEED_CONNECTORS).map((c) => ({
          key: c.key,
          name: c.name,
          description: c.description,
        })),
      ),
    );
  },
);

router.get(
  "/statement-connections",
  requireFlag("bank_feeds"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const firmId = requireFirmScope(req.principal);
    const rows = await getDb()
      .select({
        connection: statementConnectionsTable,
        clientName: partiesTable.legalName,
      })
      .from(statementConnectionsTable)
      .leftJoin(
        partiesTable,
        eq(partiesTable.id, statementConnectionsTable.clientPartyId),
      )
      .where(eq(statementConnectionsTable.firmId, firmId))
      .orderBy(desc(statementConnectionsTable.createdAt));
    res.json(
      ListStatementConnectionsResponse.parse(
        rows.map((r) => connectionView(r.connection, r.clientName)),
      ),
    );
  },
);

router.post(
  "/statement-connections",
  requireFlag("bank_feeds"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const firmId = requireFirmScope(req.principal);
    const parsed = parseOrThrow(CreateStatementConnectionBody, req.body);
    const connector = findFeedConnector(parsed.connectorKey);
    if (!connector) {
      throw new DomainError(
        "UNKNOWN_CONNECTOR",
        `No feed connector registered for "${parsed.connectorKey}"`,
        422,
      );
    }
    // The named client must be one this firm engages (and a client_user could
    // never reach here — statement.write excludes the role entirely).
    await assertPartyAccess(req.principal, parsed.clientPartyId);
    // Reject a config the connector itself cannot authenticate: a connection
    // that could only ever produce failed runs should not be storable.
    const auth = await connector.authenticate(parsed.config ?? {});
    if (!auth.ok) {
      throw new DomainError(
        "CONNECTOR_AUTH",
        auth.error ?? "authentication failed",
        422,
      );
    }
    const [row] = await getDb()
      .insert(statementConnectionsTable)
      .values({
        firmId,
        clientPartyId: parsed.clientPartyId,
        connectorKey: parsed.connectorKey,
        config: parsed.config ?? null,
      })
      .returning();
    const [party] = await getDb()
      .select({ legalName: partiesTable.legalName })
      .from(partiesTable)
      .where(eq(partiesTable.id, row.clientPartyId))
      .limit(1);
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "statement.connection_created",
      entityType: "statement_connection",
      entityId: row.id,
      after: { connectorKey: row.connectorKey, clientPartyId: row.clientPartyId },
    });
    res.json(
      CreateStatementConnectionResponse.parse(
        connectionView(row, party?.legalName ?? null),
      ),
    );
  },
);

router.post(
  "/statement-connections/:id/sync",
  requireFlag("bank_feeds"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const params = parseOrThrow(SyncStatementConnectionParams, req.params);
    const [connection] = await getDb()
      .select()
      .from(statementConnectionsTable)
      .where(eq(statementConnectionsTable.id, params.id))
      .limit(1);
    if (!connection) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    assertSameTenant(req.principal, connection.firmId);
    if (connection.status === "disabled") {
      throw new DomainError("CONNECTION_DISABLED", "Connection is disabled", 409);
    }
    // Create the run marker synchronously so the caller has something to
    // watch, then hand the pull to the worker via the outbox — both inserts
    // ride the request transaction, so the 202 and the queued job are atomic
    // (the connectors.ts idiom, INT-09 pattern).
    const [run] = await getDb()
      .insert(statementSyncRunsTable)
      .values({
        connectionId: connection.id,
        firmId: connection.firmId,
        status: "running",
      })
      .returning();
    await getDb().insert(outboxTable).values({
      aggregateType: "statement_connection",
      aggregateId: connection.id,
      type: "statement.feed_sync",
      payload: { connectionId: connection.id, requestRunId: run.id },
    });
    await appendAudit({
      actorId: req.principal.userId,
      firmId: connection.firmId,
      action: "statement.feed_sync_requested",
      entityType: "statement_connection",
      entityId: connection.id,
    });
    res.status(202).json(SyncStatementConnectionResponse.parse(runView(run)));
  },
);

router.get(
  "/statement-connections/:id/runs",
  requireFlag("bank_feeds"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const params = parseOrThrow(ListStatementSyncRunsParams, req.params);
    const [connection] = await getDb()
      .select({ firmId: statementConnectionsTable.firmId })
      .from(statementConnectionsTable)
      .where(eq(statementConnectionsTable.id, params.id))
      .limit(1);
    if (!connection) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    assertSameTenant(req.principal, connection.firmId);
    const rows = await getDb()
      .select()
      .from(statementSyncRunsTable)
      .where(eq(statementSyncRunsTable.connectionId, params.id))
      .orderBy(desc(statementSyncRunsTable.startedAt));
    res.json(ListStatementSyncRunsResponse.parse(rows.map(runView)));
  },
);

export default router;
