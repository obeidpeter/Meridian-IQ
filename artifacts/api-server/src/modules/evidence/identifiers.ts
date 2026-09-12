const identifierKeys = new Set([
  "clientRequestId",
  "clientPartyId",
  "invoiceId",
  "filingId",
  "ownerId",
  "fileId",
]);

// PostgreSQL UUIDs are case-insensitive; command identities must be too.
export function normalizeEvidenceIds<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      identifierKeys.has(key) && typeof value === "string"
        ? value.toLowerCase()
        : value,
    ]),
  ) as T;
}
