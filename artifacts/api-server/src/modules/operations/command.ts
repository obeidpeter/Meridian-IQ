import { createHash } from "node:crypto";
import { DomainError } from "../errors";

export type OperationCommand = "invoice.create" | "invoice.import";
export type CompletedOperationState = "succeeded" | "partial" | "failed";

export function parseIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "X-Idempotency-Key must contain 1-128 letters, digits, dots, underscores, colons or hyphens",
      400,
    );
  }
  return value;
}

export function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError("Operation JSON cannot contain non-finite numbers");
    }
    return item;
  });
  if (serialized === undefined)
    throw new TypeError("Operation JSON must have a body");
  return serialized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function operationPayloadHash(payload: unknown): string {
  // Normalize exactly as JSON over the wire, then ignore object key ordering.
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(serializeJson(payload))))
    .digest("hex");
}

export function importOperationOutcome(result: {
  committed: boolean;
  createdCount: number;
  invalidCount: number;
}): { status: CompletedOperationState; summary: string } {
  if (!result.committed)
    throw new TypeError(
      "Only committed imports belong in durable command history",
    );
  return {
    status:
      result.invalidCount === 0
        ? "succeeded"
        : result.createdCount > 0
          ? "partial"
          : "failed",
    summary: `${result.createdCount} drafts created; ${result.invalidCount} rows not created.`,
  };
}
