import { eq } from "drizzle-orm";
import {
  getDb,
  statementConnectionsTable,
  statementSyncRunsTable,
  type OutboxEvent,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { appendAudit } from "../audit/audit";
import { registerHandler, type HandlerOutcome } from "../pipeline/pipeline";
import { ingestStatement } from "./service.ts";
import {
  FEED_FORMAT_KEY,
  findFeedConnector,
  renderFeedCsv,
} from "./feed-contract.ts";

// Bank-feed sync engine (Wave C), built on the ERP sync engine template
// (modules/connectors/engine.ts): connector-agnostic — resolve the connector
// from the registry, authenticate, pull one page from the stored cursor, and
// land the page through the SAME ingest path every statement upload takes
// (ingestStatement with commit:true). That single call is what keeps a feed
// honest: the CORE-03 "reconciliation" consent gate, the parser invariants
// and the statement.reconcile outbox all fire exactly as they do for a manual
// upload — bank_statement_lines are NEVER inserted directly here (see
// feed-contract.ts). Syncs run async in the pipeline worker via the
// statement.feed_sync outbox event; the route pre-creates the run row so its
// 202 has something to hand back, and the worker adopts it (same
// claim/idempotency posture as erp.sync).

const PULL_LIMIT = 200;

export interface FeedSyncResult {
  runId: string;
  linesPulled: number;
  statementId: string | null;
}

async function markRunFailed(runId: string, error: string): Promise<void> {
  await getDb()
    .update(statementSyncRunsTable)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(statementSyncRunsTable.id, runId));
}

export async function runFeedSync(
  connectionId: string,
  existingRunId?: string,
): Promise<FeedSyncResult> {
  const [connection] = await getDb()
    .select()
    .from(statementConnectionsTable)
    .where(eq(statementConnectionsTable.id, connectionId))
    .limit(1);
  if (!connection) {
    throw new DomainError("NOT_FOUND", "Connection not found", 404);
  }

  // The sync route pre-creates the run marker (so the 202 response carries
  // it); the worker adopts it rather than inserting a duplicate.
  let run: { id: string } | undefined;
  if (existingRunId) {
    const [existing] = await getDb()
      .select({ id: statementSyncRunsTable.id })
      .from(statementSyncRunsTable)
      .where(eq(statementSyncRunsTable.id, existingRunId))
      .limit(1);
    run = existing;
  }
  if (!run) {
    const [created] = await getDb()
      .insert(statementSyncRunsTable)
      .values({
        connectionId,
        firmId: connection.firmId,
        status: "running",
      })
      .returning({ id: statementSyncRunsTable.id });
    run = created;
  }

  try {
    const connector = findFeedConnector(connection.connectorKey);
    if (!connector) {
      throw new DomainError(
        "UNKNOWN_CONNECTOR",
        `No feed connector registered for "${connection.connectorKey}"`,
        422,
      );
    }
    const config = connection.config ?? {};
    const auth = await connector.authenticate(config);
    if (!auth.ok) {
      throw new DomainError(
        "CONNECTOR_AUTH",
        auth.error ?? "authentication failed",
        422,
      );
    }

    const pull = await connector.pullLines(config, connection.cursor, PULL_LIMIT);

    if (pull.lines.length === 0) {
      // Nothing new: the run succeeds with no statement and the cursor stays
      // put — an idle feed is a healthy feed, not an error.
      await getDb()
        .update(statementSyncRunsTable)
        .set({ status: "succeeded", linesPulled: 0, finishedAt: new Date() })
        .where(eq(statementSyncRunsTable.id, run.id));
      await getDb()
        .update(statementConnectionsTable)
        .set({ lastSyncAt: new Date() })
        .where(eq(statementConnectionsTable.id, connectionId));
      return { runId: run.id, linesPulled: 0, statementId: null };
    }

    // The one and only landing path (consent gate, parse invariants and the
    // statement.reconcile enqueue all live inside ingestStatement).
    const result = await ingestStatement({
      firmId: connection.firmId,
      clientPartyId: connection.clientPartyId,
      csv: renderFeedCsv(pull.lines),
      formatKey: FEED_FORMAT_KEY,
      filename: `${connector.key}-feed-${new Date().toISOString().slice(0, 10)}.csv`,
      commit: true,
      // No human uploaded this; the connection is the actor of record.
      actorId: `feed:${connection.id}`,
    });

    await getDb()
      .update(statementSyncRunsTable)
      .set({
        status: "succeeded",
        linesPulled: pull.lines.length,
        statementId: result.statementId,
        finishedAt: new Date(),
      })
      .where(eq(statementSyncRunsTable.id, run.id));
    await getDb()
      .update(statementConnectionsTable)
      .set({
        cursor: pull.nextCursor ?? connection.cursor,
        lastSyncAt: new Date(),
      })
      .where(eq(statementConnectionsTable.id, connectionId));
    await appendAudit({
      firmId: connection.firmId,
      action: "statement.feed_sync",
      entityType: "statement_sync_run",
      entityId: run.id,
      after: {
        connectorKey: connection.connectorKey,
        linesPulled: pull.lines.length,
        statementId: result.statementId,
        cursor: pull.nextCursor ?? connection.cursor,
      },
    });
    return {
      runId: run.id,
      linesPulled: pull.lines.length,
      statementId: result.statementId,
    };
  } catch (err) {
    // Every failure — bad auth, missing CORE-03 consent thrown by
    // ingestStatement, an unparseable render — lands on the run row with a
    // clean message, then propagates so the outbox marks the event.
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(run.id, message);
    throw err;
  }
}

// Outbox handler: syncs run async in the pipeline worker, never in a request.
// DomainErrors (auth/consent/config) are terminal until the connection is
// fixed; anything else is retried with backoff.
async function handleFeedSync(event: OutboxEvent): Promise<HandlerOutcome> {
  const payload = event.payload as {
    connectionId?: string;
    requestRunId?: string;
  };
  const connectionId = String(payload.connectionId ?? "");
  if (!connectionId) return { kind: "dead", error: "Missing connectionId" };
  try {
    await runFeedSync(connectionId, payload.requestRunId);
    return { kind: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DomainError) return { kind: "dead", error: message };
    return { kind: "retry", error: message };
  }
}

registerHandler("statement.feed_sync", handleFeedSync);
