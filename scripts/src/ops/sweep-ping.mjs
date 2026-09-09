import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const P = "sweep-ping";

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

// The target is always explicit (R116): a public hostname default would send
// a signed request to whatever deployment last owned that name. Plain http is
// accepted only to a loopback receiver, and the path is the sweep endpoint.
export function sweepUrl(env = process.env) {
  const raw = env.SWEEP_URL?.trim();
  if (!raw) {
    throw new Error(
      "Set SWEEP_URL to the deployment's https://<host>/api/internal/sweep endpoint; there is no default host.",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SWEEP_URL must be an absolute URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("SWEEP_URL must use https (plain http only to loopback).");
  }
  if (
    !url.pathname.endsWith("/api/internal/sweep") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "SWEEP_URL must point at /api/internal/sweep and carry no credentials.",
    );
  }
  return url;
}

function signedHeaders(url, key, timestamp = Math.floor(Date.now() / 1000)) {
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

export async function pingSweep(
  url,
  key,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let retryMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("sweep request timed out")),
      120_000,
    );
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: signedHeaders(url, key, Math.floor(now() / 1000)),
        signal: controller.signal,
        redirect: "error",
      });
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay =
          Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1_000
            : Date.parse(retryAfter) - now();
        if (Number.isFinite(delay)) retryMs = Math.max(retryMs, delay);
      }
      const result = await response.json().catch(() => null);
      if (
        response.status === 200 &&
        result?.status === "ok" &&
        ["drain", "reconcile", "sweeps"].every(
          (pass) => result.ran?.[pass] === true,
        )
      ) {
        // R105: best-effort sweeps that failed ride along as `degraded` —
        // static sweep names, never tenant data. The pass still completed.
        const degraded = Array.isArray(result.degraded)
          ? result.degraded.filter((name) => typeof name === "string")
          : [];
        if (degraded.length)
          console.warn(`${P}: degraded sweeps: ${degraded.join(", ")}`);
        return {
          status: "ok",
          ran: { drain: true, reconcile: true, sweeps: true },
          ...(degraded.length ? { degraded } : {}),
        };
      }
      throw new Error(`Sweep did not complete (HTTP ${response.status})`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) {
      // A long server delay belongs to the next scheduled run, not an
      // unbounded sleep in this three-attempt command.
      if (retryMs > 120_000) break;
      await sleep(retryMs);
    }
  }
  throw new Error(
    `failed within 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await pingSweep(sweepUrl(), signingKey());
    console.log(`${P}: completed`, JSON.stringify(result));
  } catch (error) {
    console.error(
      `${P}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
