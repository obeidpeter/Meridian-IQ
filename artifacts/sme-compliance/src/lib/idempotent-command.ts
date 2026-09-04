function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function canonicalPayloadHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonical(JSON.parse(JSON.stringify(payload))),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Deterministic across refresh/retry; scope includes the draft ID for creates.
export async function stableCommandKey(
  scope: string,
  payload: unknown,
): Promise<string> {
  return `sme-${await canonicalPayloadHash([scope, payload])}`;
}
