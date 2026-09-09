export async function readBoundedJsonObject(
  response: Response,
  maxBytes: number,
  source: string,
): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maxBytes
    ) {
      throw new Error(`${source} response is too large`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${source} returned an empty response`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${source} response is too large`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large")) {
      throw error;
    }
    throw new Error(`${source} response could not be read`);
  }

  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} returned an invalid response`);
  }
  return parsed as Record<string, unknown>;
}
