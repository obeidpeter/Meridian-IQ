import { useCallback, useEffect, useRef, useState } from "react";
import { isImportOperationRoute } from "./operation-routes";

export type OperationState =
  | "queued"
  | "running"
  | "partial"
  | "failed"
  | "succeeded";

export interface OperationRecord {
  id: string;
  title: string;
  kind: string;
  status: OperationState;
  route: string;
  startedAt: string;
  updatedAt: string;
  detail?: string;
  savedSummary?: string;
  command?: "invoice.create" | "invoice.import";
  idempotencyKey?: string;
  serverId?: string;
  verification?: "local" | "unconfirmed" | "server";
  verifiedAt?: string;
  // Recovered results are memory-only; never persist invoice/import payloads.
  serverResult?: { statusCode: number; body: unknown };
}

export interface BeginOperationInput {
  title: string;
  kind: string;
  route: string;
  detail?: string;
  status?: "queued" | "running";
  command?: OperationRecord["command"];
  idempotencyKey?: string;
}

const OPERATION_EVENT = "meridianiq:operation-journal-change";
const MAX_OPERATIONS = 24;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;

function isOperationState(value: unknown): value is OperationState {
  return ["queued", "running", "partial", "failed", "succeeded"].includes(
    String(value),
  );
}

function isOperation(value: unknown): value is OperationRecord {
  if (typeof value !== "object" || value === null) return false;
  const item = value as OperationRecord;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.kind === "string" &&
    isOperationState(item.status) &&
    typeof item.route === "string" &&
    /^\/(?!\/)/.test(item.route) &&
    !item.route.includes("\\") &&
    typeof item.startedAt === "string" &&
    typeof item.updatedAt === "string" &&
    Number.isFinite(Date.parse(item.startedAt)) &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    (item.command === undefined ||
      item.command === "invoice.create" ||
      item.command === "invoice.import") &&
    (item.idempotencyKey === undefined ||
      (typeof item.idempotencyKey === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.idempotencyKey))) &&
    (item.detail === undefined || typeof item.detail === "string") &&
    (item.savedSummary === undefined || typeof item.savedSummary === "string")
  );
}

function emitChange(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPERATION_EVENT, { detail: key }));
}

function writeOperations(key: string, operations: OperationRecord[]): void {
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify(operations.slice(0, MAX_OPERATIONS).map(localRecord)),
    );
    emitChange(key);
  } catch {
    // The journal improves recovery but must never block the underlying action.
  }
}

function localRecord(item: OperationRecord): OperationRecord {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    route: item.route,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    detail: item.detail,
    savedSummary: item.savedSummary,
    command: item.command,
    idempotencyKey: item.idempotencyKey,
    verification: item.command ? "unconfirmed" : "local",
  };
}

export function readOperations(key: string): OperationRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter(isOperation)
      .map(localRecord)
      .filter(
        (operation) =>
          now - new Date(operation.updatedAt).getTime() <= RETENTION_MS,
      )
      .map((operation) => {
        const stale =
          (operation.status === "queued" || operation.status === "running") &&
          now - new Date(operation.updatedAt).getTime() > STALE_RUNNING_MS;
        return stale
          ? {
              ...operation,
              status: "partial" as const,
              detail:
                "Completion was not recorded. Open the source page and verify the result before trying again.",
              savedSummary: "Outcome unconfirmed after the session ended.",
            }
          : operation;
      })
      .slice(0, MAX_OPERATIONS);
  } catch {
    return [];
  }
}

export function beginOperation(
  key: string | null,
  input: BeginOperationInput,
): OperationRecord | null {
  if (!key || typeof window === "undefined") return null;
  const now = new Date().toISOString();
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const operation: OperationRecord = {
    id,
    title: input.title,
    kind: input.kind,
    status: input.status ?? "running",
    route: input.route,
    startedAt: now,
    updatedAt: now,
    verification: input.command ? "unconfirmed" : "local",
    ...(input.command
      ? { command: input.command, idempotencyKey: input.idempotencyKey ?? id }
      : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
  writeOperations(key, [
    operation,
    ...readOperations(key).filter((item) => item.id !== operation.id),
  ]);
  return operation;
}

export function updateOperation(
  key: string | null,
  id: string | null | undefined,
  patch: Pick<OperationRecord, "status"> &
    Partial<Pick<OperationRecord, "detail" | "savedSummary" | "route">>,
): void {
  if (!key || !id || typeof window === "undefined") return;
  const current = readOperations(key);
  const next = current.map((operation) =>
    operation.id === id
      ? { ...operation, ...patch, updatedAt: new Date().toISOString() }
      : operation,
  );
  writeOperations(key, next);
}

export function dismissOperation(key: string, id: string): void {
  writeOperations(
    key,
    readOperations(key).filter((operation) => operation.id !== id),
  );
}

export function clearCompletedOperations(key: string): void {
  writeOperations(
    key,
    readOperations(key).filter((operation) =>
      ["queued", "running", "partial", "failed"].includes(operation.status),
    ),
  );
}

export type OperationSyncState =
  | "local"
  | "syncing"
  | "synced"
  | "offline"
  | "unavailable"
  | "forbidden";

export interface OperationRecoveryClient {
  // Inject customFetch bound to the SAME tenant/user as the journal key.
  fetcher: (
    path: string,
    options: { signal: AbortSignal; cache: "no-store" },
  ) => Promise<unknown>;
  pollIntervalMs?: number;
}

interface ServerOperation {
  id: string;
  command: NonNullable<OperationRecord["command"]>;
  idempotencyKey: string;
  status: "succeeded" | "partial" | "failed";
  route: string;
  summary: string;
  startedAt: string;
  updatedAt: string;
  result?: { statusCode: number; body: unknown };
}

function parseServerOperation(value: unknown): ServerOperation {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid operation response");
  const row = value as ServerOperation;
  if (
    typeof row.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(row.id) ||
    !["invoice.create", "invoice.import"].includes(row.command) ||
    !(row.command === "invoice.create"
      ? row.route === "/invoices"
      : isImportOperationRoute(row.route)) ||
    typeof row.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.idempotencyKey) ||
    !["succeeded", "partial", "failed"].includes(row.status) ||
    typeof row.summary !== "string" ||
    typeof row.startedAt !== "string" ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    (row.result !== undefined &&
      (!row.result ||
        !Number.isInteger(row.result.statusCode) ||
        row.result.statusCode < 200 ||
        row.result.statusCode > 299 ||
        !("body" in row.result)))
  ) {
    throw new TypeError("Invalid operation response");
  }
  return row;
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error
    ? Number(error.status)
    : undefined;
}

function serverRecord(
  row: ServerOperation,
  local?: OperationRecord,
): OperationRecord {
  return {
    id: local?.id ?? row.id,
    serverId: row.id,
    command: row.command,
    idempotencyKey: row.idempotencyKey,
    kind: row.command === "invoice.create" ? "invoice" : "import",
    title:
      row.command === "invoice.create" ? "Create invoice" : "Invoice import",
    route: row.route,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    savedSummary: row.summary,
    verification: "server",
    verifiedAt: new Date().toISOString(),
    ...(row.result ? { serverResult: row.result } : {}),
  };
}

export async function reconcileOperations(
  local: OperationRecord[],
  client: OperationRecoveryClient,
  signal: AbortSignal,
): Promise<OperationRecord[]> {
  const request = (path: string) =>
    client.fetcher(path, { signal, cache: "no-store" });
  const page = (await request("/api/operations?limit=24")) as {
    operations?: unknown;
  };
  if (!page || !Array.isArray(page.operations) || page.operations.length > 24)
    throw new TypeError("Invalid operation history");
  const remote = page.operations.map(parseServerOperation);
  const merged: OperationRecord[] = [];
  for (const item of local.slice(0, MAX_OPERATIONS)) {
    if (!item.command || !item.idempotencyKey) {
      merged.push(item);
      continue;
    }
    const index = remote.findIndex(
      (row) =>
        row.command === item.command &&
        row.idempotencyKey === item.idempotencyKey,
    );
    if (index >= 0) {
      merged.push(serverRecord(remote.splice(index, 1)[0], item));
      continue;
    }
    try {
      const query = new URLSearchParams({
        command: item.command,
        idempotencyKey: item.idempotencyKey,
      });
      const row = parseServerOperation(
        await request(`/api/operations/lookup?${query}`),
      );
      if (
        row.command !== item.command ||
        row.idempotencyKey !== item.idempotencyKey
      )
        throw new TypeError("Operation lookup mismatch");
      merged.push(serverRecord(row, item));
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      // No committed visible record is not proof of failure or permission to
      // mint a new key: the original request may still be in flight.
      merged.push({
        ...localRecord(item),
        status: "partial",
        verification: "unconfirmed",
        detail:
          "No authorized committed result is available. Verify before retrying.",
        savedSummary: "Outcome unconfirmed.",
      });
    }
  }
  merged.push(...remote.map((row) => serverRecord(row)));
  if (signal.aborted)
    throw signal.reason ?? new Error("Operation reconciliation cancelled");
  return merged
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, MAX_OPERATIONS);
}

export function useOperationJournal(
  key: string | null,
  client?: OperationRecoveryClient,
) {
  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    operations: OperationRecord[];
    syncState: OperationSyncState;
  }>({
    key,
    operations: key ? readOperations(key) : [],
    syncState: "local",
  });
  const [generation, setGeneration] = useState(0);
  const dismissed = useRef<{ key: string | null; ids: Set<string> }>({
    key,
    ids: new Set(),
  });
  const requestScope = useRef<{
    key: string | null;
    controller: AbortController;
  } | null>(null);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const fetcher = client?.fetcher;
  const pollIntervalMs = client?.pollIntervalMs ?? 30_000;
  useEffect(() => {
    const controller = new AbortController();
    requestScope.current = { key, controller };
    let busy = false;
    if (dismissed.current.key !== key)
      dismissed.current = { key, ids: new Set() };
    const visible = (items: OperationRecord[]) =>
      items.filter((item) => !dismissed.current.ids.has(item.id));
    const fallback = (local: OperationRecord[], previous: typeof snapshot) => {
      if (previous.key !== key) return visible(local);
      const known = new Map(previous.operations.map((item) => [item.id, item]));
      return visible([
        ...local.map((item) => {
          const server = known.get(item.id);
          return server?.verification === "server" &&
            Date.parse(server.updatedAt) >= Date.parse(item.updatedAt)
            ? server
            : item;
        }),
        ...previous.operations.filter(
          (item) =>
            item.serverId &&
            !local.some((candidate) => candidate.id === item.id),
        ),
      ]).slice(0, MAX_OPERATIONS);
    };
    const sync = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      const local = key ? readOperations(key) : [];
      if (!key || !fetcher) {
        setSnapshot({ key, operations: visible(local), syncState: "local" });
        busy = false;
        return;
      }
      setSnapshot((previous) => ({
        key,
        operations: fallback(local, previous),
        syncState: "syncing",
      }));
      try {
        const operations = await reconcileOperations(
          local,
          { fetcher },
          controller.signal,
        );
        if (!controller.signal.aborted)
          setSnapshot({
            key,
            operations: visible(operations),
            syncState: "synced",
          });
      } catch (error) {
        if (controller.signal.aborted) return;
        const forbidden = [401, 403].includes(statusOf(error) ?? 0);
        setSnapshot((previous) => ({
          key,
          operations: forbidden
            ? visible(local.filter((item) => !item.command))
            : fallback(local, previous),
          syncState: forbidden
            ? "forbidden"
            : navigator.onLine === false
              ? "offline"
              : "unavailable",
        }));
      } finally {
        busy = false;
      }
    };
    void sync();
    if (!key || typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) refresh();
    };
    const onLocal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(OPERATION_EVENT, onLocal);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    const timer = fetcher
      ? window.setInterval(() => void sync(), Math.max(5_000, pollIntervalMs))
      : undefined;
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(OPERATION_EVENT, onLocal);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, [key, fetcher, pollIntervalMs, generation, refresh]);
  // Key changes must hide the previous account synchronously, before effects.
  const operations = snapshot.key === key ? snapshot.operations : [];
  return {
    operations,
    syncState:
      snapshot.key === key
        ? snapshot.syncState
        : ("local" as OperationSyncState),
    refresh,
    recover: async (id: string): Promise<void> => {
      const item = operations.find((operation) => operation.id === id);
      const scope = requestScope.current;
      if (
        !fetcher ||
        !item?.serverId ||
        !scope ||
        scope.key !== key ||
        scope.controller.signal.aborted
      )
        return;
      try {
        const row = parseServerOperation(
          await fetcher(
            `/api/operations/${encodeURIComponent(item.serverId)}`,
            {
              signal: scope.controller.signal,
              cache: "no-store",
            },
          ),
        );
        if (
          row.id !== item.serverId ||
          row.command !== item.command ||
          row.idempotencyKey !== item.idempotencyKey ||
          !row.result
        ) {
          throw new TypeError("Operation result mismatch");
        }
        if (scope.controller.signal.aborted) return;
        setSnapshot((previous) =>
          previous.key !== key
            ? previous
            : {
                ...previous,
                operations: previous.operations.map((operation) =>
                  operation.id === id
                    ? serverRecord(row, operation)
                    : operation,
                ),
              },
        );
      } catch (error) {
        if (scope.controller.signal.aborted) return;
        if ([401, 403, 404].includes(statusOf(error) ?? 0)) {
          setSnapshot((previous) =>
            previous.key !== key
              ? previous
              : {
                  ...previous,
                  operations: previous.operations.filter(
                    (operation) => operation.id !== id,
                  ),
                  syncState: "forbidden",
                },
          );
        }
        throw error;
      }
    },
    dismiss: (id: string) => {
      dismissed.current.ids.add(id);
      if (key) dismissOperation(key, id);
      refresh();
    },
    clearCompleted: () => {
      operations
        .filter((item) => item.status === "succeeded")
        .forEach((item) => dismissed.current.ids.add(item.id));
      if (key) clearCompletedOperations(key);
      refresh();
    },
  };
}
