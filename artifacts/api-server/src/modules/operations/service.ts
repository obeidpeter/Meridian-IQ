import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, getDb, type Database } from "@workspace/db";
import {
  assertCan,
  assertClientPartyScope,
  requireFirmScope,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";
import {
  operationPayloadHash,
  parseIdempotencyKey,
  serializeJson,
  type CompletedOperationState,
  type OperationCommand,
} from "./command";

interface StoredOperation extends Record<string, unknown> {
  id: string;
  client_party_id: string;
  command: OperationCommand;
  idempotency_key: string;
  payload_hash: string;
  status: "running" | CompletedOperationState;
  response_status: number | null;
  response_body: string | null;
  summary: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_time: string;
  import_run_id?: string | null;
}

// Navigation authority comes from committed, same-owner chunk/run rows, not
// a caller-selected idempotency key or a run-shaped response body.
const importRunReference = sql`
  LEFT JOIN import_run_chunks c ON o.command = 'invoice.import' AND c.operation_id = o.id
    AND c.firm_id = o.firm_id AND c.actor_id = o.actor_id AND c.client_party_id = o.client_party_id
  LEFT JOIN import_runs r ON r.id = c.run_id AND r.firm_id = c.firm_id
    AND r.actor_id = c.actor_id AND r.client_party_id = c.client_party_id
`;

export interface OperationSummary {
  id: string;
  command: OperationCommand;
  idempotencyKey: string;
  status: CompletedOperationState;
  title: string;
  route: string;
  summary: string;
  startedAt: string;
  updatedAt: string;
}

export interface OperationResponse {
  operationId: string;
  replayed: boolean;
  statusCode: number;
  body: string;
}

export function activeOperationDb(tx: Database): Database {
  const current = getDb();
  if (current !== tx || current === db)
    throw new Error("Operation transaction is no longer current");
  return current;
}

export async function operationOwnerTransaction(
  principal: Principal,
  capability: "invoice.read" | "invoice.write",
) {
  if (
    ["operator", "auditor", "bank_user", "buyer_user"].includes(principal.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Recovery requires a firm-scoped principal without bypass",
      403,
    );
  }
  assertCan(principal, capability);
  const firmId = requireFirmScope(principal);
  if (
    !principal.userId ||
    (principal.role === "client_user" && !principal.clientPartyId)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "An authorized operation owner is required",
      403,
    );
  }
  const tx = getDb();
  if (tx === db)
    throw new Error("Operations require the caller's tenant transaction");
  const context = await activeOperationDb(tx).execute<{
    firm_id: string;
    bypass: string;
    role: string;
    isolation: string;
  }>(sql`
    SELECT current_setting('app.firm_id', true) AS firm_id,
      current_setting('app.bypass', true) AS bypass, current_user AS role,
      current_setting('transaction_isolation') AS isolation
  `);
  const current = context.rows[0];
  if (
    current?.firm_id !== firmId ||
    current.bypass !== "off" ||
    current.role !== "meridian_app" ||
    current.isolation !== "read committed"
  ) {
    throw new Error(
      "Operations require a matching read-committed tenant transaction without bypass",
    );
  }
  await activeOperationDb(tx).execute(sql`SELECT
    set_config('app.operation_actor_id', ${principal.userId}, true),
    set_config('app.operation_client_party_id', ${principal.role === "client_user" ? principal.clientPartyId! : ""}, true)
  `);
  return { tx, firmId };
}

// Shared recovery-table predicate; the owned relation must be aliased as o.
export function authorizedOperationOwner(
  principal: Principal,
  firmId: string,
): SQL {
  return sql`o.firm_id = ${firmId}::uuid AND o.actor_id = ${principal.userId}
    AND (${principal.role !== "client_user"} OR o.client_party_id = ${principal.clientPartyId}::uuid)
    AND EXISTS (SELECT 1 FROM engagements e
      WHERE e.firm_id = o.firm_id AND e.client_party_id = o.client_party_id AND e.status <> 'archived')`;
}

function notFound(): never {
  throw new DomainError("NOT_FOUND", "Operation not found", 404);
}

export async function executeOperation(input: {
  principal: Principal;
  command: OperationCommand;
  idempotencyKey: string;
  clientPartyId: string;
  payload: unknown;
  execute: (tx: Database) => Promise<{
    statusCode: number;
    body: unknown;
    status?: CompletedOperationState;
    summary?: string;
  }>;
}): Promise<OperationResponse> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  const payloadHash = operationPayloadHash({
    clientPartyId: input.clientPartyId,
    payload: input.payload,
  });
  const { principal } = input;
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.write",
  );
  assertClientPartyScope(principal, input.clientPartyId);
  const access = await activeOperationDb(tx)
    .execute(sql`SELECT 1 FROM engagements WHERE firm_id = ${firmId}::uuid
    AND client_party_id = ${input.clientPartyId}::uuid AND status <> 'archived' LIMIT 1`);
  if (!access.rows.length)
    throw new DomainError(
      "FORBIDDEN",
      "Client is not authorized for this operation",
      403,
    );

  // The unique index waits for the winning transaction, not just its handler.
  // The separate SELECT gets a fresh READ COMMITTED snapshot after that wait.
  const inserted = await activeOperationDb(tx).execute<{ id: string }>(sql`
    INSERT INTO operations (id, firm_id, actor_id, client_party_id, command, idempotency_key, payload_hash)
    VALUES (${randomUUID()}::uuid, ${firmId}::uuid, ${principal.userId}, ${input.clientPartyId}::uuid,
      ${input.command}, ${key}, ${payloadHash})
    ON CONFLICT (firm_id, actor_id, command, idempotency_key) DO NOTHING RETURNING id
  `);
  if (!inserted.rows[0]) {
    const existing = await activeOperationDb(tx)
      .execute<StoredOperation>(sql`SELECT o.* FROM operations o
      WHERE ${authorizedOperationOwner(principal, firmId)} AND o.command = ${input.command} AND o.idempotency_key = ${key}`);
    const row = existing.rows[0];
    // Missing and inaccessible keys are indistinguishable; never expose their result/hash.
    if (!row) notFound();
    if (row.payload_hash !== payloadHash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "X-Idempotency-Key was already used with a different payload",
        409,
      );
    }
    if (
      row.status === "running" ||
      row.response_status === null ||
      row.response_body === null
    ) {
      throw new DomainError(
        "OPERATION_PENDING",
        "Operation has not completed; retry the same key",
        409,
      );
    }
    return {
      operationId: row.id,
      replayed: true,
      statusCode: row.response_status,
      body: row.response_body,
    };
  }

  const operationId = inserted.rows[0].id;
  const result = await input.execute(activeOperationDb(tx));
  if (
    !Number.isInteger(result.statusCode) ||
    result.statusCode < 200 ||
    result.statusCode > 299
  ) {
    throw new TypeError(
      "Durable commands must return a successful HTTP response; thrown errors roll back",
    );
  }
  const body = serializeJson(result.body);
  const completed = await activeOperationDb(tx)
    .execute(sql`UPDATE operations SET status = ${result.status ?? "succeeded"},
    response_status = ${result.statusCode}, response_body = ${body}, summary = ${result.summary ?? "Command completed."},
    updated_at = clock_timestamp() WHERE id = ${operationId}::uuid AND status = 'running' RETURNING id`);
  if (completed.rows.length !== 1)
    throw new Error("Operation completion was not persisted");
  return { operationId, replayed: false, statusCode: result.statusCode, body };
}

function summary(row: StoredOperation): OperationSummary {
  if (row.status === "running")
    throw new Error("Uncommitted operation cannot be returned as history");
  return {
    id: row.id,
    command: row.command,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    title:
      row.command === "invoice.create" ? "Create invoice" : "Invoice import",
    route:
      row.command === "invoice.create"
        ? "/invoices"
        : row.import_run_id
          ? `/import?run=${row.import_run_id}`
          : "/import",
    summary: row.summary ?? "Command completed.",
    startedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    if (cursor.length > 256) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.id,
      )
    )
      throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "Invalid operation history cursor",
      400,
    );
  }
}

export async function listOperations(
  principal: Principal,
  options: { limit?: number; cursor?: string } = {},
) {
  const limit = options.limit ?? 24;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError(
      "INVALID_LIMIT",
      "limit must be between 1 and 100",
      400,
    );
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.read",
  );
  const page = await activeOperationDb(tx).execute<StoredOperation>(sql`
    SELECT o.id, o.command, o.idempotency_key, o.status, o.summary, o.created_at, o.updated_at,
      o.created_at::text AS cursor_time, r.id AS import_run_id
    FROM operations o ${importRunReference}
    WHERE ${authorizedOperationOwner(principal, firmId)} AND o.status <> 'running'
      ${cursor ? sql`AND (o.created_at, o.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit + 1}
  `);
  const rows = page.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    operations: rows.map(summary),
    nextCursor:
      page.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.cursor_time, id: last.id }),
          ).toString("base64url")
        : null,
  };
}

export async function recoverOperation(
  principal: Principal,
  selector:
    | { id: string }
    | { command: OperationCommand; idempotencyKey: string },
) {
  const { tx, firmId } = await operationOwnerTransaction(
    principal,
    "invoice.read",
  );
  const match =
    "id" in selector
      ? sql`o.id = ${selector.id}::uuid`
      : sql`o.command = ${selector.command} AND o.idempotency_key = ${parseIdempotencyKey(selector.idempotencyKey)}`;
  const result = await activeOperationDb(tx)
    .execute<StoredOperation>(sql`SELECT o.*, r.id AS import_run_id FROM operations o ${importRunReference}
    WHERE ${authorizedOperationOwner(principal, firmId)} AND ${match} AND o.status <> 'running'`);
  const row = result.rows[0];
  if (!row || row.response_status === null || row.response_body === null)
    notFound();
  return {
    ...summary(row),
    result: {
      statusCode: row.response_status,
      body: JSON.parse(row.response_body) as unknown,
    },
  };
}
