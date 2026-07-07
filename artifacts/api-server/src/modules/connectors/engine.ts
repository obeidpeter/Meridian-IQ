import { and, eq } from "drizzle-orm";
import {
  getDb,
  erpConnectionsTable,
  erpSyncRunsTable,
  invoicesTable,
  partiesTable,
  type ErpConnection,
  type OutboxEvent,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { appendAudit } from "../audit/audit";
import { createDraft } from "../invoice/service";
import { registerHandler, type HandlerOutcome } from "../pipeline/pipeline";
import { mapRow } from "./contract.ts";
import { findConnector } from "./implementations.ts";

// ERP sync engine (PL-03, INT-06). Connector-agnostic: resolve the connector
// from the registry, authenticate, pull one page from the stored cursor, map
// rows through the field map (connector default overlaid with per-connection
// overrides), and land each mapped row on the SAME canonical draft path every
// invoice takes (modules/invoice/service.createDraft) — a connector can never
// fork core invoice behaviour.

const PULL_LIMIT = 50;

interface RowOutcome {
  ref: string;
  status: "imported" | "skipped" | "invalid";
  detail?: string;
  invoiceId?: string;
}

async function findOrCreateBuyer(
  name: string,
  tin: string | null,
): Promise<string> {
  if (tin) {
    const [byTin] = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(eq(partiesTable.tin, tin))
      .limit(1);
    if (byTin) return byTin.id;
  }
  const [byName] = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(eq(partiesTable.legalName, name))
    .limit(1);
  if (byName) return byName.id;
  const [created] = await getDb()
    .insert(partiesTable)
    .values({
      type: "buyer",
      legalName: name,
      tin,
      // Registry validation happens through the parties surface (CORE-08); an
      // ERP-sourced TIN is captured but not presumed validated.
      tinValidated: false,
    })
    .returning({ id: partiesTable.id });
  return created.id;
}

export async function runSync(
  connectionId: string,
  existingRunId?: string,
): Promise<{
  runId: string;
  pulled: number;
  imported: number;
  skipped: number;
  errors: number;
}> {
  const [connection] = await getDb()
    .select()
    .from(erpConnectionsTable)
    .where(eq(erpConnectionsTable.id, connectionId))
    .limit(1);
  if (!connection) {
    throw new DomainError("NOT_FOUND", "Connection not found", 404);
  }
  const connector = findConnector(connection.connectorKey);
  if (!connector) {
    throw new DomainError(
      "UNKNOWN_CONNECTOR",
      `No connector registered for "${connection.connectorKey}"`,
      422,
    );
  }
  // The sync route pre-creates the run marker (so the 202 response carries it);
  // the worker adopts it rather than inserting a duplicate.
  let run: { id: string };
  if (existingRunId) {
    const [existing] = await getDb()
      .select({ id: erpSyncRunsTable.id })
      .from(erpSyncRunsTable)
      .where(eq(erpSyncRunsTable.id, existingRunId))
      .limit(1);
    run = existing ?? { id: "" };
  } else {
    run = { id: "" };
  }
  if (!run.id) {
    const [created] = await getDb()
      .insert(erpSyncRunsTable)
      .values({
        connectionId,
        status: "running",
        fromCursor: connection.cursor,
      })
      .returning();
    run = created;
  }

  const config = connection.authConfig ?? {};
  const auth = await connector.authenticate(config);
  if (!auth.ok) {
    await getDb()
      .update(erpSyncRunsTable)
      .set({
        status: "failed",
        error: auth.error ?? "authentication failed",
        finishedAt: new Date(),
      })
      .where(eq(erpSyncRunsTable.id, run.id));
    await getDb()
      .update(erpConnectionsTable)
      .set({ status: "error", lastError: auth.error ?? "authentication failed" })
      .where(eq(erpConnectionsTable.id, connectionId));
    throw new DomainError("CONNECTOR_AUTH", auth.error ?? "authentication failed", 422);
  }

  const pull = await connector.pullInvoices(config, connection.cursor, PULL_LIMIT);
  const fieldMap = {
    ...connector.defaultFieldMap,
    ...(connection.fieldMap ?? {}),
  };
  const outcomes: RowOutcome[] = [];
  for (const native of pull.rows) {
    const mapped = mapRow(native, fieldMap);
    const ref = mapped.row?.invoiceNumber ?? JSON.stringify(native).slice(0, 60);
    if (!mapped.row) {
      outcomes.push({
        ref,
        status: "invalid",
        detail: mapped.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
      });
      continue;
    }
    // Duplicate detection: the client's invoice numbers are unique per supplier.
    const [existing] = await getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.supplierPartyId, connection.clientPartyId),
          eq(invoicesTable.invoiceNumber, mapped.row.invoiceNumber),
        ),
      )
      .limit(1);
    if (existing) {
      outcomes.push({ ref, status: "skipped", detail: "already imported" });
      continue;
    }
    const buyerPartyId = await findOrCreateBuyer(
      mapped.row.buyerName,
      mapped.row.buyerTin,
    );
    const { invoice } = await createDraft({
      firmId: connection.firmId,
      supplierPartyId: connection.clientPartyId,
      buyerPartyId,
      invoiceNumber: mapped.row.invoiceNumber,
      issueDate: mapped.row.issueDate,
      category: "b2b",
      lines: [
        {
          description: mapped.row.description,
          quantity: mapped.row.quantity,
          unitPrice: mapped.row.unitPrice,
          vatRate: mapped.row.vatRate,
        },
      ],
    });
    outcomes.push({ ref, status: "imported", invoiceId: invoice.id });
  }

  const imported = outcomes.filter((o) => o.status === "imported").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const errors = outcomes.filter((o) => o.status === "invalid").length;
  await getDb()
    .update(erpSyncRunsTable)
    .set({
      status: "succeeded",
      toCursor: pull.nextCursor,
      pulledCount: pull.rows.length,
      importedCount: imported,
      skippedCount: skipped,
      errorCount: errors,
      rowResults: outcomes as unknown as Record<string, unknown>[],
      finishedAt: new Date(),
    })
    .where(eq(erpSyncRunsTable.id, run.id));
  await getDb()
    .update(erpConnectionsTable)
    .set({
      cursor: pull.nextCursor,
      status: "active",
      lastSyncAt: new Date(),
      lastError: null,
    })
    .where(eq(erpConnectionsTable.id, connectionId));
  await appendAudit({
    firmId: connection.firmId,
    action: "connector.sync",
    entityType: "erp_sync_run",
    entityId: run.id,
    after: {
      connectorKey: connection.connectorKey,
      pulled: pull.rows.length,
      imported,
      skipped,
      errors,
      cursor: pull.nextCursor,
    },
  });
  return { runId: run.id, pulled: pull.rows.length, imported, skipped, errors };
}

// Outbox handler: syncs run async in the pipeline worker, never in a request.
async function handleErpSync(event: OutboxEvent): Promise<HandlerOutcome> {
  const payload = event.payload as {
    connectionId?: string;
    requestRunId?: string;
  };
  const connectionId = String(payload.connectionId ?? "");
  if (!connectionId) return { kind: "dead", error: "Missing connectionId" };
  try {
    await runSync(connectionId, payload.requestRunId);
    return { kind: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Auth/config failures are terminal until the connection is fixed.
    if (err instanceof DomainError) return { kind: "dead", error: message };
    return { kind: "retry", error: message };
  }
}

registerHandler("erp.sync", handleErpSync);
