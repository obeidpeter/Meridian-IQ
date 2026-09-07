import type { Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../../invoice/canonical";
import { logger } from "../../../lib/logger";
import type { RailTransport, StampResult } from "../contracts";
import { RailLookupError, sanitiseRejectionCode, type StampFields } from "../faults";

// The HTTP rail transport (R95): the first RailTransport that leaves the
// process. It speaks the provisional "Valo access-point profile v0"
// (docs/platform.md, "Rail transport & selection") and maps every wire
// outcome onto the failure-class vocabulary in modules/errors.ts, so the
// pipeline's park / retry / dead dispositions never see HTTP. Bound only
// when RAIL_PRIMARY_URL and/or RAIL_SECONDARY_URL is lit (adapter.ts); the
// simulator stays the default until accreditation.
//
//   POST {base}/v0/submissions        {idempotencyKey, rail, invoice}
//     2xx {irn,csid,qrPayload,signedArtifactRef}       → accepted (fields bounded, printable ASCII)
//     409                                              → rejected MBS_DUPLICATE (recovered via lookup)
//     422 {code?}                                      → rejected <code | MBS_SCHEMA_INVALID>
//     400 {code}                                       → rejected <code>; without a code → error RAIL_PROTOCOL
//     401/403                                          → error RAIL_UNAUTHORIZED (retriable: the platform's fault)
//     429 [Retry-After]                                → error RAIL_RATE_LIMITED (raw.retryAfterMs honoured as a floor)
//     5xx                                              → error RAIL_UNAVAILABLE
//     3xx (never followed), other status, bad 2xx body → error RAIL_PROTOCOL (retriable: a duplicate recovers)
//     abort (RAIL_TIMEOUT_MS, headers OR body)         → error RAIL_TIMEOUT
//     network error                                    → error RAIL_UNAVAILABLE
//   GET  {base}/v0/submissions/{idempotencyKey}
//     2xx conforming → the stamp; 404 → null (a definite miss);
//     anything else, a timeout or a network error → RailLookupError (the
//     stamp may exist: the caller retries, never fails the invoice).
//
// `raw` on every result is `{ httpStatus, body }` — httpStatus 0 and body
// null when nothing was answered (plus `reason` / `timeoutMs`); `body` is the
// parsed JSON when it is small and shallow, else the text truncated to 4 KiB,
// always with NUL stripped and the bearer token redacted, so what the
// attempts table retains is bounded and safe to show.

export interface HttpRailConfig {
  urls: Partial<Record<Rail, string>>;
  tokens: Partial<Record<Rail, string>>;
  /** Provenance stamped on every stamp record; never inferred from the URL. */
  environment: RailEnvironment;
  timeoutMs: number;
}

export type RailEnvironment = "sandbox" | "live";

const RAILS: readonly Rail[] = ["rail_primary", "rail_secondary"];
const RAIL_ENV: Record<Rail, { url: string; token: string }> = {
  rail_primary: { url: "RAIL_PRIMARY_URL", token: "RAIL_PRIMARY_TOKEN" },
  rail_secondary: { url: "RAIL_SECONDARY_URL", token: "RAIL_SECONDARY_TOKEN" },
};
// Four calls per event (two submits, two lookups) at the default budget fit
// inside the 25 s graceful-shutdown grace (lib/shutdown.ts) with room to
// spare; raising RAIL_TIMEOUT_MS means raising SHUTDOWN_TIMEOUT_MS with it.
const DEFAULT_TIMEOUT_MS = 5_000;
// A per-call budget above this would let one event hold its transaction and
// the worker far past any sensible shutdown deadline.
export const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_ENVIRONMENT: RailEnvironment = "sandbox";
// The most of a response the transport reads at all, and the most of it the
// attempts table retains.
const BODY_READ_LIMIT = 65_536;
const RAW_BODY_LIMIT = 4_096;
const RAW_JSON_MAX_DEPTH = 8;
// A 429's Retry-After is honoured as a floor under the pipeline backoff, but
// never beyond this.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
// What an accepted body may carry: bounded, printable ASCII, no whitespace.
const STAMP_FIELD_LIMITS: Record<keyof StampFields, number> = {
  irn: 128,
  csid: 128,
  signedArtifactRef: 4_096,
  // QR version 40, error level M: 2,331 bytes of binary / ~2,900 of base64.
  qrPayload: 2_900,
};
const PRINTABLE = /^[\x21-\x7e]+$/;
const BASE64ISH = /^[A-Za-z0-9+/=_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const HTTP_RAIL_TRANSPORT_NAME = "http";

export function railTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.RAIL_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(configured), MAX_TIMEOUT_MS);
}

/** `sandbox` unless RAIL_ENVIRONMENT says exactly `live`; anything else is refused. */
export function railEnvironmentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RailEnvironment {
  const value = env.RAIL_ENVIRONMENT?.trim();
  if (!value) return DEFAULT_ENVIRONMENT;
  if (value === "sandbox" || value === "live") return value;
  logger.warn(
    { configured: value.slice(0, 32) },
    "RAIL_ENVIRONMENT is not sandbox|live; provenance stays sandbox",
  );
  return DEFAULT_ENVIRONMENT;
}

/**
 * A rail base URL fit to send a credential and invoices to: parseable, no
 * userinfo (a secret in a URL ends up in error messages), http(s) only, and
 * never plain http in production except to loopback. The value itself is
 * never logged — a refused URL may be the misplaced secret.
 */
export function vettedRailUrl(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    logger.warn("a RAIL_*_URL is not a valid URL; that rail stays unconfigured");
    return null;
  }
  if (url.username || url.password) {
    logger.warn("a RAIL_*_URL carries credentials; that rail stays unconfigured");
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    logger.warn({ protocol: url.protocol }, "a RAIL_*_URL is not http(s); that rail stays unconfigured");
    return null;
  }
  if (
    url.protocol === "http:" &&
    env.NODE_ENV === "production" &&
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    logger.warn("a RAIL_*_URL is plain http in production; that rail stays unconfigured");
    return null;
  }
  return url.toString().replace(/\/+$/, "");
}

/** The HTTP configuration the environment describes, or null when no rail URL is lit. */
export function httpRailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpRailConfig | null {
  const urls: Partial<Record<Rail, string>> = {};
  const tokens: Partial<Record<Rail, string>> = {};
  for (const rail of RAILS) {
    const raw = env[RAIL_ENV[rail].url]?.trim();
    if (!raw) continue;
    const url = vettedRailUrl(raw, env);
    if (!url) continue;
    urls[rail] = url;
    const token = env[RAIL_ENV[rail].token]?.trim();
    if (token) tokens[rail] = token;
  }
  if (Object.keys(urls).length === 0) return null;
  return {
    urls,
    tokens,
    environment: railEnvironmentFromEnv(env),
    timeoutMs: railTimeoutMs(env),
  };
}

function conformingStamp(body: unknown): StampFields | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  const fields = ["irn", "csid", "qrPayload", "signedArtifactRef"] as const;
  for (const field of fields) {
    const value = candidate[field];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > STAMP_FIELD_LIMITS[field] ||
      !PRINTABLE.test(value)
    ) {
      return null;
    }
  }
  if (!BASE64ISH.test(candidate.qrPayload as string)) return null;
  return {
    irn: candidate.irn as string,
    csid: candidate.csid as string,
    qrPayload: candidate.qrPayload as string,
    signedArtifactRef: candidate.signedArtifactRef as string,
  };
}

/** Max nesting of a JSON text (strings skipped); 0 for a scalar. */
function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === "}" || ch === "]") depth -= 1;
  }
  return max;
}

interface ReadBody {
  /** For classification: the parsed JSON, or null. */
  parsed: unknown;
  /** For the attempts table: bounded, NUL-free, token-redacted. */
  persisted: unknown;
  truncated: boolean;
  aborted: boolean;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A reason to log for a failed fetch: the error's name / cause code, never its message (which may echo a URL). */
function failureReason(err: unknown): string {
  const e = err as { name?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code;
  return typeof code === "string" ? code : typeof e?.name === "string" ? e.name : "unknown";
}

async function readBody(resp: Response, token: string | undefined): Promise<ReadBody> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let aborted = false;
  const reader = resp.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > BODY_READ_LIMIT) {
          truncated = true;
          chunks.push(value.subarray(0, Math.max(0, BODY_READ_LIMIT - (size - value.byteLength))));
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    } catch (err) {
      aborted = isAbort(err);
      truncated = truncated || !aborted;
    }
  }
  let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  // NUL is refused by Postgres text and jsonb columns; a bearer echoed back
  // by a gateway must not reach every invoice reader.
  // JSON can also spell NUL as the escape \u0000, which parsing turns back
  // into the real character, so the parsed value is walked as well.
  text = text.replace(/\u0000/g, "");
  if (token) text = text.split(token).join("[redacted]");
  let parsed: unknown = null;
  if (!truncated && !aborted && text.length > 0) {
    try {
      parsed = withoutNul(JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }
  }
  const persisted =
    parsed !== null && text.length <= RAW_BODY_LIMIT && jsonDepth(text) <= RAW_JSON_MAX_DEPTH
      ? parsed
      : text.length > 0
        ? text.slice(0, RAW_BODY_LIMIT)
        : null;
  return { parsed, persisted, truncated, aborted };
}

/** The value with U+0000 stripped from every string and key (JSON escapes survive parsing). */
function withoutNul(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key.replace(/\u0000/g, "")] = withoutNul(v);
    }
    return out;
  }
  return value;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  else {
    const at = Date.parse(header);
    if (!Number.isFinite(at)) return undefined;
    ms = at - Date.now();
  }
  return Math.min(Math.max(0, Math.floor(ms)), MAX_RETRY_AFTER_MS);
}

export function createHttpRailTransport(cfg: HttpRailConfig): RailTransport {
  const rails = RAILS.filter((rail) => Boolean(cfg.urls[rail]));
  const provenance = {
    provider: HTTP_RAIL_TRANSPORT_NAME,
    environment: cfg.environment,
  };

  function headersFor(rail: Rail, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    const token = cfg.tokens[rail];
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return headers;
  }

  function errorResult(
    rail: Rail,
    errorCode: string,
    raw: Record<string, unknown>,
  ): StampResult {
    return { status: "error", rail, errorCode, raw, ...provenance };
  }

  function noResponse(reason: "timeout" | "network"): Record<string, unknown> {
    return { httpStatus: 0, body: null, reason, timeoutMs: cfg.timeoutMs };
  }

  return {
    name: HTTP_RAIL_TRANSPORT_NAME,
    environment: cfg.environment,
    rails,

    async submit(
      rail: Rail,
      inv: CanonicalInvoice,
      idempotencyKey: string,
    ): Promise<StampResult> {
      const base = cfg.urls[rail];
      if (!base) {
        return errorResult(rail, "RAIL_UNAVAILABLE", {
          httpStatus: 0,
          body: null,
          reason: "rail not configured",
        });
      }
      let resp: Response;
      try {
        resp = await fetch(`${base}/v0/submissions`, {
          method: "POST",
          headers: headersFor(rail, idempotencyKey),
          body: JSON.stringify({ idempotencyKey, rail, invoice: inv }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
          redirect: "manual",
        });
      } catch (err) {
        const timedOut = isAbort(err);
        logger.warn(
          { rail, reason: failureReason(err) },
          timedOut ? "rail submission timed out" : "rail submission failed",
        );
        return errorResult(
          rail,
          timedOut ? "RAIL_TIMEOUT" : "RAIL_UNAVAILABLE",
          noResponse(timedOut ? "timeout" : "network"),
        );
      }
      const httpStatus = resp.status;
      const body = await readBody(resp, cfg.tokens[rail]);
      if (body.aborted) {
        logger.warn({ rail, httpStatus }, "rail submission body timed out");
        return errorResult(rail, "RAIL_TIMEOUT", {
          ...noResponse("timeout"),
          httpStatus,
          phase: "body",
        });
      }
      const raw: Record<string, unknown> = { httpStatus, body: body.persisted };
      if (body.truncated) raw.truncated = true;
      if (resp.ok) {
        const stamp = conformingStamp(body.parsed);
        if (!stamp) {
          logger.error(
            { rail, httpStatus },
            "rail accepted with a non-conforming body; a recovery will meet the same answer",
          );
          return errorResult(rail, "RAIL_PROTOCOL", raw);
        }
        return { status: "accepted", rail, ...stamp, raw, ...provenance };
      }
      if (httpStatus === 409) {
        return { status: "rejected", rail, errorCode: "MBS_DUPLICATE", raw, ...provenance };
      }
      const code = sanitiseRejectionCode((body.parsed as { code?: unknown } | null)?.code);
      if (httpStatus === 422 || (httpStatus === 400 && code)) {
        return {
          status: "rejected",
          rail,
          errorCode: code ?? "MBS_SCHEMA_INVALID",
          raw,
          ...provenance,
        };
      }
      let errorCode: string;
      if (httpStatus === 401 || httpStatus === 403) errorCode = "RAIL_UNAUTHORIZED";
      else if (httpStatus === 429) {
        errorCode = "RAIL_RATE_LIMITED";
        const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
        if (retryAfterMs !== undefined) raw.retryAfterMs = retryAfterMs;
      } else if (httpStatus >= 500) errorCode = "RAIL_UNAVAILABLE";
      else errorCode = "RAIL_PROTOCOL";
      logger.warn({ rail, httpStatus, errorCode }, "rail submission not accepted");
      return errorResult(rail, errorCode, raw);
    },

    async lookup(
      rail: Rail,
      _inv: CanonicalInvoice,
      idempotencyKey: string,
    ): Promise<StampResult | null> {
      const base = cfg.urls[rail];
      if (!base) return null;
      let resp: Response;
      try {
        resp = await fetch(
          `${base}/v0/submissions/${encodeURIComponent(idempotencyKey)}`,
          {
            method: "GET",
            headers: headersFor(rail),
            signal: AbortSignal.timeout(cfg.timeoutMs),
            redirect: "manual",
          },
        );
      } catch (err) {
        const timedOut = isAbort(err);
        logger.warn({ rail, reason: failureReason(err) }, "rail lookup failed");
        throw new RailLookupError(rail, timedOut ? "RAIL_TIMEOUT" : "RAIL_UNAVAILABLE");
      }
      const httpStatus = resp.status;
      if (httpStatus === 404) {
        await resp.body?.cancel().catch(() => undefined);
        return null;
      }
      const body = await readBody(resp, cfg.tokens[rail]);
      if (body.aborted) throw new RailLookupError(rail, "RAIL_TIMEOUT");
      if (resp.ok) {
        const stamp = conformingStamp(body.parsed);
        if (!stamp) {
          logger.warn({ rail, httpStatus }, "rail lookup answered with a non-conforming body");
          throw new RailLookupError(rail, "RAIL_PROTOCOL");
        }
        return {
          status: "accepted",
          rail,
          ...stamp,
          raw: { httpStatus, body: body.persisted, lookedUp: true },
          ...provenance,
        };
      }
      let errorCode: string;
      if (httpStatus === 401 || httpStatus === 403) errorCode = "RAIL_UNAUTHORIZED";
      else if (httpStatus === 429) errorCode = "RAIL_RATE_LIMITED";
      else if (httpStatus >= 500) errorCode = "RAIL_UNAVAILABLE";
      else errorCode = "RAIL_PROTOCOL";
      logger.warn({ rail, httpStatus, errorCode }, "rail lookup not answered");
      throw new RailLookupError(rail, errorCode);
    },
  };
}
