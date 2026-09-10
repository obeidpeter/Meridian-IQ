import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { rawBodyOf } from "./body";

// Machine-rail credentials (R100). Every operational endpoint — the inbound
// email / WhatsApp intake rails, the payment and collection webhooks,
// /api/internal/sweep and /api/metrics — is governed by a per-rail KEY RING
// read from the environment, and a caller proves possession of a key one of
// two ways:
//
//  - the SIGNED path: `x-op-key-id` names the key, `x-op-timestamp` is the
//    caller's clock (unix seconds), and `x-op-signature` is
//    `v1=` + hex HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${sha256hex(rawBody)}`).
//    Binding the method, path and the exact body bytes means a captured
//    signature cannot be replayed against another rail or with another
//    payload, and the timestamp must sit inside a short replay window.
//  - the LEGACY path: `x-op-token` carries a secret verbatim (constant-time
//    compare against every key in the ring). Kept so a provider migrates on
//    its own schedule. Production defaults this path off; explicitly setting
//    OP_LEGACY_TOKENS=on is required during a time-bounded migration.
//
// The ring for rail X is `X_KEYS` = `id:secret,id:secret,…` (ids
// [A-Za-z0-9_-]{1,32}, secrets 32+ chars, ids unique — the same shape as
// SESSION_SIGNING_KEYS). The single-secret `X_TOKEN` a deployment set
// before key rings existed still works and is the key id `legacy`; both
// may be set during a migration. Ring empty (neither set) means the rail is
// dark — a required rail 404s exactly like an unknown route, an optional
// one (metrics) is open only outside production. Secrets are never accepted
// in URLs, where browser history, proxy logs and referrers can retain them,
// and never echoed:
// rail-config reports key IDS only.

const OP_TOKEN_HEADER = "x-op-token";
export const OP_KEY_ID_HEADER = "x-op-key-id";
export const OP_TIMESTAMP_HEADER = "x-op-timestamp";
export const OP_SIGNATURE_HEADER = "x-op-signature";
const LEGACY_KEY_ID = "legacy";
const DEFAULT_WINDOW_SECONDS = 300;
const KEY_ID_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SECRET_LENGTH = 32;

export interface OpKey {
  id: string;
  secret: string;
  /** True for the pre-key-ring single secret (`X_TOKEN`). */
  legacy: boolean;
}

/** `COLLECTION_WEBHOOK_TOKEN` → `COLLECTION_WEBHOOK_KEYS`. */
export function keyRingEnvName(tokenEnv: string): string {
  return tokenEnv.endsWith("_TOKEN")
    ? `${tokenEnv.slice(0, -"_TOKEN".length)}_KEYS`
    : `${tokenEnv}_KEYS`;
}

/** Parse an `id:secret,…` ring; throws on a malformed entry. */
export function parseKeyRing(
  ringEnv: string,
  raw: string | undefined,
): OpKey[] {
  const text = raw?.trim();
  if (!text) return [];
  const keys = text.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !KEY_ID_SHAPE.test(id) ||
      secret.length < MIN_SECRET_LENGTH
    ) {
      throw new Error(
        `${ringEnv} entries must be key-id:secret with a ${MIN_SECRET_LENGTH}+ character secret`,
      );
    }
    return { id, secret, legacy: false };
  });
  if (new Set(keys.map((k) => k.id)).size !== keys.length) {
    throw new Error(`${ringEnv} key IDs must be unique`);
  }
  return keys;
}

/**
 * The key ring for a rail, named by its legacy token env var (the name every
 * route, test and document already uses): the `_KEYS` ring plus, when set,
 * the single `_TOKEN` secret as the `legacy` key. Read per request, like
 * every gate reads its env.
 */
export function railKeyRing(tokenEnv: string): OpKey[] {
  const ringEnv = keyRingEnvName(tokenEnv);
  const ring = parseKeyRing(ringEnv, process.env[ringEnv]);
  const single = process.env[tokenEnv];
  if (single) ring.push({ id: LEGACY_KEY_ID, secret: single, legacy: true });
  return ring;
}

/** Key ids only — what rail-config may show. Malformed rings read as dark. */
export function describeKeyRing(tokenEnv: string): {
  configured: boolean;
  keyIds: string[];
} {
  try {
    const ring = railKeyRing(tokenEnv);
    return { configured: ring.length > 0, keyIds: ring.map((k) => k.id) };
  } catch {
    return { configured: false, keyIds: [] };
  }
}

export function legacyTokenPathEnabled(): boolean {
  const defaultValue = process.env.NODE_ENV === "production" ? "off" : "on";
  return (
    (process.env.OP_LEGACY_TOKENS ?? defaultValue).trim().toLowerCase() !==
    "off"
  );
}

function signatureWindowSeconds(): number {
  const configured = Number(process.env.OP_SIGNATURE_WINDOW_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WINDOW_SECONDS;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length equality checked first because timingSafeEqual requires it; the
  // secret's length is not something we defend.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The string a signature covers — one home for signing and verification. */
function opSigningString(input: {
  method: string;
  path: string;
  timestamp: number | string;
  body: Buffer | string;
}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  return `${input.timestamp}.${input.method.toUpperCase()}.${input.path}.${bodyHash}`;
}

/** Sign a request the way a provider (or the e2e harness) does. */
export function signOpRequest(
  key: Pick<OpKey, "id" | "secret">,
  input: {
    method: string;
    path: string;
    body?: Buffer | string;
    timestamp?: number;
  },
): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", key.secret)
    .update(
      opSigningString({
        method: input.method,
        path: input.path,
        timestamp,
        body: input.body ?? "",
      }),
    )
    .digest("hex");
  return {
    [OP_KEY_ID_HEADER]: key.id,
    [OP_TIMESTAMP_HEADER]: String(timestamp),
    [OP_SIGNATURE_HEADER]: `v1=${digest}`,
  };
}

export type OpAuth =
  | { ok: true; keyId: string; via: "signature" | "token" }
  | { ok: false; reason: string };

/**
 * The secret as the caller presented it on the legacy path. Header-only by
 * design.
 */
function presentedOpToken(req: Request): string | undefined {
  return req.get(OP_TOKEN_HEADER) ?? undefined;
}

/** True when no configured secret, or the presented value matches it. */
export function opTokenAllows(
  expected: string | undefined,
  presented: string | undefined,
): boolean {
  if (!expected) return true;
  if (!presented) return false;
  return safeEqual(expected, presented);
}

/**
 * Authenticate a request against a rail's ring: the signed path when the
 * signature headers are present, the legacy token path otherwise. Never
 * throws; the caller answers 401 with its own message on `ok: false`.
 */
export function authenticateOpRequest(
  req: Request,
  ring: OpKey[],
  opts: { now?: number } = {},
): OpAuth {
  if (ring.length === 0) return { ok: false, reason: "rail_dark" };
  const keyId = req.get(OP_KEY_ID_HEADER);
  const timestamp = req.get(OP_TIMESTAMP_HEADER);
  const signature = req.get(OP_SIGNATURE_HEADER);
  if (
    keyId !== undefined ||
    timestamp !== undefined ||
    signature !== undefined
  ) {
    if (!keyId || !timestamp || !signature) {
      return { ok: false, reason: "signature_incomplete" };
    }
    const key = ring.find((k) => k.id === keyId);
    if (!key) return { ok: false, reason: "unknown_key" };
    if (!/^\d{1,12}$/.test(timestamp)) {
      return { ok: false, reason: "bad_timestamp" };
    }
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > signatureWindowSeconds()) {
      return { ok: false, reason: "stale_timestamp" };
    }
    if (!signature.startsWith("v1="))
      return { ok: false, reason: "bad_signature" };
    const expected = createHmac("sha256", key.secret)
      .update(
        opSigningString({
          method: req.method,
          path: `${req.baseUrl}${req.path}`,
          timestamp,
          body: rawBodyOf(req),
        }),
      )
      .digest("hex");
    return safeEqual(expected, signature.slice("v1=".length))
      ? { ok: true, keyId: key.id, via: "signature" }
      : { ok: false, reason: "bad_signature" };
  }
  const presented = presentedOpToken(req);
  if (!presented) return { ok: false, reason: "missing" };
  if (!legacyTokenPathEnabled()) return { ok: false, reason: "legacy_off" };
  // Every key is tried so a rotated-in key works on the legacy header too;
  // each compare is constant-time on its own.
  let matched: OpKey | undefined;
  for (const key of ring) {
    if (safeEqual(key.secret, presented)) matched = matched ?? key;
  }
  return matched
    ? { ok: true, keyId: matched.id, via: "token" }
    : { ok: false, reason: "wrong_token" };
}

/**
 * Express guard for the operational endpoints, named by the rail's legacy
 * token env var. `required` rails 404 while their ring is empty (fail
 * closed); an optional one (metrics) is open while unset.
 */
export function requireOpToken(
  envName: string,
  opts: { required?: boolean } = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ring = railKeyRing(envName);
    if (ring.length === 0) {
      if (opts.required) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      next();
      return;
    }
    const auth = authenticateOpRequest(req, ring);
    if (auth.ok) {
      next();
      return;
    }
    res.status(401).json({ error: "Invalid or missing operational token" });
  };
}
