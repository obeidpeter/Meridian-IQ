import type { Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../../invoice/canonical";
import { logger } from "../../../lib/logger";
import type { RailTransport, StampResult } from "../adapter";
import type { StampFields } from "../faults";

// The HTTP rail transport (R95): the first RailTransport that leaves the
// process. It speaks the provisional "MeridianIQ access-point profile v0"
// (docs/platform.md, "Rail transport & selection") and maps every wire
// outcome onto the failure-class vocabulary in modules/errors.ts, so the
// pipeline's park / retry / dead dispositions never see HTTP. Bound only
// when RAIL_PRIMARY_URL and/or RAIL_SECONDARY_URL is lit (adapter.ts); the
// simulator stays the default until accreditation.
//
//   POST {base}/v0/submissions        {idempotencyKey, rail, invoice}
//     201/200 {irn,csid,qrPayload,signedArtifactRef}  → accepted
//     409                                              → rejected MBS_DUPLICATE (recovered via lookup)
//     400/422 {code}                                   → rejected <code>
//     401/403                                          → error RAIL_UNAUTHORIZED (retriable: the platform's fault)
//     429                                              → error RAIL_RATE_LIMITED
//     5xx                                              → error RAIL_UNAVAILABLE
//     other status / non-conforming 2xx body           → error RAIL_PROTOCOL (retriable: a duplicate recovers)
//     abort (RAIL_TIMEOUT_MS)                          → error RAIL_TIMEOUT
//     network error                                    → error RAIL_UNAVAILABLE
//   GET  {base}/v0/submissions/{idempotencyKey}
//     200 conforming → the stamp; anything else → null (a lookup never throws)

export interface HttpRailConfig {
  urls: Partial<Record<Rail, string>>;
  tokens: Partial<Record<Rail, string>>;
  /** Provenance stamped on every stamp record; never inferred from the URL. */
  environment: string;
  timeoutMs: number;
}

const RAILS: readonly Rail[] = ["rail_primary", "rail_secondary"];
const RAIL_ENV: Record<Rail, { url: string; token: string }> = {
  rail_primary: { url: "RAIL_PRIMARY_URL", token: "RAIL_PRIMARY_TOKEN" },
  rail_secondary: { url: "RAIL_SECONDARY_URL", token: "RAIL_SECONDARY_TOKEN" },
};
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ENVIRONMENT = "sandbox";
// What of a non-conforming or error body the attempts table retains.
const RAW_BODY_LIMIT = 4_096;
const MAX_CODE_LENGTH = 64;

export const HTTP_RAIL_TRANSPORT_NAME = "http";

export function railTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.RAIL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TIMEOUT_MS;
}

/** The HTTP configuration the environment describes, or null when no rail URL is lit. */
export function httpRailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpRailConfig | null {
  const urls: Partial<Record<Rail, string>> = {};
  const tokens: Partial<Record<Rail, string>> = {};
  for (const rail of RAILS) {
    const url = env[RAIL_ENV[rail].url]?.trim();
    if (!url) continue;
    urls[rail] = url.replace(/\/+$/, "");
    const token = env[RAIL_ENV[rail].token]?.trim();
    if (token) tokens[rail] = token;
  }
  if (Object.keys(urls).length === 0) return null;
  return {
    urls,
    tokens,
    environment: env.RAIL_ENVIRONMENT?.trim() || DEFAULT_ENVIRONMENT,
    timeoutMs: railTimeoutMs(env),
  };
}

function conformingStamp(body: unknown): StampFields | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  const fields = ["irn", "csid", "qrPayload", "signedArtifactRef"] as const;
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value !== "string" || value.length === 0) return null;
  }
  return {
    irn: candidate.irn as string,
    csid: candidate.csid as string,
    qrPayload: candidate.qrPayload as string,
    signedArtifactRef: candidate.signedArtifactRef as string,
  };
}

async function readBody(resp: Response): Promise<unknown> {
  const text = await resp.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, RAW_BODY_LIMIT);
  }
}

function rejectionCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" &&
    code.length > 0 &&
    code.length <= MAX_CODE_LENGTH &&
    /^[A-Z0-9_]+$/.test(code)
    ? code
    : null;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
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
        });
      } catch (err) {
        const timedOut = isAbort(err);
        logger.warn(
          { rail, err: err instanceof Error ? err.message : String(err) },
          timedOut ? "rail submission timed out" : "rail submission failed",
        );
        return errorResult(rail, timedOut ? "RAIL_TIMEOUT" : "RAIL_UNAVAILABLE", {
          reason: timedOut ? "timeout" : "network",
          timeoutMs: cfg.timeoutMs,
        });
      }
      const httpStatus = resp.status;
      const body = await readBody(resp);
      const raw = { httpStatus, body };
      if (resp.ok) {
        const stamp = conformingStamp(body);
        if (!stamp) {
          logger.warn({ rail, httpStatus }, "rail accepted with a non-conforming body");
          return errorResult(rail, "RAIL_PROTOCOL", raw);
        }
        return { status: "accepted", rail, ...stamp, raw, ...provenance };
      }
      if (httpStatus === 409) {
        return { status: "rejected", rail, errorCode: "MBS_DUPLICATE", raw, ...provenance };
      }
      if (httpStatus === 400 || httpStatus === 422) {
        return {
          status: "rejected",
          rail,
          errorCode: rejectionCode(body) ?? "MBS_SCHEMA_INVALID",
          raw,
          ...provenance,
        };
      }
      let errorCode: string;
      if (httpStatus === 401 || httpStatus === 403) errorCode = "RAIL_UNAUTHORIZED";
      else if (httpStatus === 429) errorCode = "RAIL_RATE_LIMITED";
      else if (httpStatus >= 500) errorCode = "RAIL_UNAVAILABLE";
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
      try {
        const resp = await fetch(
          `${base}/v0/submissions/${encodeURIComponent(idempotencyKey)}`,
          {
            method: "GET",
            headers: headersFor(rail),
            signal: AbortSignal.timeout(cfg.timeoutMs),
          },
        );
        const httpStatus = resp.status;
        const body = await readBody(resp);
        if (!resp.ok) {
          if (httpStatus !== 404) {
            logger.warn({ rail, httpStatus }, "rail lookup not answered");
          }
          return null;
        }
        const stamp = conformingStamp(body);
        if (!stamp) {
          logger.warn({ rail, httpStatus }, "rail lookup answered with a non-conforming body");
          return null;
        }
        return {
          status: "accepted",
          rail,
          ...stamp,
          raw: { httpStatus, body, lookedUp: true },
          ...provenance,
        };
      } catch (err) {
        logger.warn(
          { rail, err: err instanceof Error ? err.message : String(err) },
          "rail lookup failed",
        );
        return null;
      }
    },
  };
}
