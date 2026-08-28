import { useEffect, useState } from "react";

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
}

export interface BeginOperationInput {
  title: string;
  kind: string;
  route: string;
  detail?: string;
  status?: "queued" | "running";
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
    item.route.startsWith("/") &&
    typeof item.startedAt === "string" &&
    typeof item.updatedAt === "string" &&
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
      JSON.stringify(operations.slice(0, MAX_OPERATIONS)),
    );
    emitChange(key);
  } catch {
    // The journal improves recovery but must never block the underlying action.
  }
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
  const operation: OperationRecord = {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: input.title,
    kind: input.kind,
    status: input.status ?? "running",
    route: input.route,
    startedAt: now,
    updatedAt: now,
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

export function useOperationJournal(key: string | null) {
  const [operations, setOperations] = useState<OperationRecord[]>(() =>
    key ? readOperations(key) : [],
  );
  useEffect(() => {
    const refresh = () => setOperations(key ? readOperations(key) : []);
    refresh();
    if (!key || typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) refresh();
    };
    const onLocal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(OPERATION_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(OPERATION_EVENT, onLocal);
    };
  }, [key]);
  return {
    operations,
    dismiss: (id: string) => key && dismissOperation(key, id),
    clearCompleted: () => key && clearCompletedOperations(key),
  };
}
