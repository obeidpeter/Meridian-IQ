import { createHash } from "node:crypto";
import { DomainError } from "../errors.ts";

export function invoiceFilterKey(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

export function encodeInvoiceCursor(
  timestamp: string,
  id: string,
  filter: string,
): string {
  return Buffer.from(
    JSON.stringify({ timestamp, id, filter }),
    "utf8",
  ).toString("base64url");
}

export function decodeInvoiceCursor(
  cursor: string,
  filter: string,
): { timestamp: string; id: string } {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error("format");
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object") throw new Error("object");
    const parsed = value as {
      timestamp?: unknown;
      id?: unknown;
      filter?: unknown;
    };
    if (
      parsed.filter !== filter ||
      typeof parsed.timestamp !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.timestamp) ||
      !Number.isFinite(Date.parse(parsed.timestamp)) ||
      Number(parsed.timestamp.slice(0, 4)) < 1 ||
      new Date(parsed.timestamp).toISOString() !==
        parsed.timestamp.slice(0, 23) + "Z" ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parsed.id)
    )
      throw new Error("values");
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "This page belongs to a different filter or workspace. Refresh the invoice list.",
    );
  }
}
