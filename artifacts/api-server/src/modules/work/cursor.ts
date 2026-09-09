import { createHash } from "node:crypto";
import { DomainError } from "../errors";

export interface WorkCursor {
  rank: number;
  due: string | null;
  id: string;
}

export function workFilterKey(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

export function encodeWorkCursor(value: WorkCursor, filter: string): string {
  return Buffer.from(JSON.stringify({ ...value, filter })).toString(
    "base64url",
  );
}

export function decodeWorkCursor(cursor: string, filter: string): WorkCursor {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<WorkCursor> & { filter?: unknown };
    if (
      !value ||
      value.filter !== filter ||
      !Number.isInteger(value.rank) ||
      value.rank! < 0 ||
      value.rank! > 3 ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)
    )
      throw new Error();
    if (
      value.due !== null &&
      (typeof value.due !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.due) ||
        !Number.isFinite(Date.parse(value.due)) ||
        Number(value.due.slice(0, 4)) < 1 ||
        new Date(value.due).toISOString() !== value.due.slice(0, 23) + "Z")
    )
      throw new Error();
    return { rank: value.rank!, due: value.due, id: value.id };
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "This page is no longer valid for this workspace or filter. Refresh team work.",
      400,
    );
  }
}
