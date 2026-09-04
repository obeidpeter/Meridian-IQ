import { createHash, createHmac } from "node:crypto";

const P = "sweep-ping";
const url = new URL(
  process.env.SWEEP_URL ?? "https://meridian-iq.replit.app/api/internal/sweep",
);

function signingKey() {
  const directId = process.env.SWEEP_KEY_ID?.trim();
  const directSecret = process.env.SWEEP_KEY_SECRET?.trim();
  if (directId && directSecret) return { id: directId, secret: directSecret };

  const firstRingEntry = process.env.SWEEP_KEYS?.split(",")[0]?.trim();
  if (firstRingEntry) {
    const separator = firstRingEntry.indexOf(":");
    if (separator > 0) {
      return {
        id: firstRingEntry.slice(0, separator).trim(),
        secret: firstRingEntry.slice(separator + 1).trim(),
      };
    }
  }

  const legacySecret = process.env.SWEEP_TOKEN?.trim();
  if (legacySecret) return { id: "legacy", secret: legacySecret };
  throw new Error(
    "Set SWEEP_KEY_ID + SWEEP_KEY_SECRET, SWEEP_KEYS, or SWEEP_TOKEN.",
  );
}

function signedHeaders(key, timestamp = Math.floor(Date.now() / 1000)) {
  const bodyHash = createHash("sha256").update("").digest("hex");
  const digest = createHmac("sha256", key.secret)
    .update(`${timestamp}.GET.${url.pathname}.${bodyHash}`)
    .digest("hex");
  return {
    "x-op-key-id": key.id,
    "x-op-timestamp": String(timestamp),
    "x-op-signature": `v1=${digest}`,
  };
}

const key = signingKey();
let lastError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("sweep request timed out")),
    120_000,
  );
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: signedHeaders(key),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const result = await response.json();
    console.log(`${P}: completed`, JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000));
  } finally {
    clearTimeout(timer);
  }
}
console.error(
  `${P}: failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
);
process.exit(1);
