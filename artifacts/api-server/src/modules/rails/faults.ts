import { createHash, createHmac } from "node:crypto";
import type { Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical";
import { canonicalJson } from "../../lib/canonical-json";
import type { StampResult } from "./contracts";

// The rail fault vocabulary (R95). ONE table that the HTTP transport, the
// in-process scripted fake and the conformance fake-rail server all agree
// on: an outcome names what an access point did, the table says which HTTP
// status carries it on the wire and which catalogue code / StampResult status
// the transport must classify it as. A test that scripts an outcome and a
// transport that maps a response therefore cannot drift apart.

export type RailFaultOutcome =
  | "accept"
  | "reject"
  | "duplicate"
  | "timeout"
  | "rate_limit"
  | "unavailable"
  | "unauthorized"
  | "malformed";

export const RAIL_FAULT_OUTCOMES: readonly RailFaultOutcome[] = [
  "accept",
  "reject",
  "duplicate",
  "timeout",
  "rate_limit",
  "unavailable",
  "unauthorized",
  "malformed",
];

export function isRailFaultOutcome(value: unknown): value is RailFaultOutcome {
  return (
    typeof value === "string" &&
    (RAIL_FAULT_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Which call a fault applies to. */
export type RailFaultOp = "submit" | "lookup";

export function isRailFaultOp(value: unknown): value is RailFaultOp {
  return value === "submit" || value === "lookup";
}

export interface RailFault {
  outcome: RailFaultOutcome;
  /** Business rejection code for `reject` (default MBS_SCHEMA_INVALID). */
  code?: string;
  /** How many calls this fault applies to; unset = every call until reset. */
  times?: number;
  /**
   * For `duplicate` and `malformed`: the rail really holds a stamp for the
   * submission, so a lookup (or a re-send of the same key) recovers it.
   * Without it the duplicate is unrecoverable (the case that keeps the
   * terminal failure).
   */
  holdsStamp?: boolean;
  /**
   * `submit` (default) faults the POST; `lookup` faults the GET a recovery
   * makes — on the wire an HTTP error, in the transport a RailLookupError,
   * never a miss.
   */
  op?: RailFaultOp;
  /** For `rate_limit`: the Retry-After the rail demands, in seconds (default 1). */
  retryAfterSeconds?: number;
}

export interface RailFaultShape {
  /** 0 = no response at all (the client's timeout classifies it). */
  httpStatus: number;
  status: StampResult["status"];
  errorCode?: string;
}

export const RAIL_FAULT_TABLE: Record<RailFaultOutcome, RailFaultShape> = {
  accept: { httpStatus: 201, status: "accepted" },
  reject: {
    httpStatus: 422,
    status: "rejected",
    errorCode: "MBS_SCHEMA_INVALID",
  },
  duplicate: {
    httpStatus: 409,
    status: "rejected",
    errorCode: "MBS_DUPLICATE",
  },
  timeout: { httpStatus: 0, status: "error", errorCode: "RAIL_TIMEOUT" },
  rate_limit: {
    httpStatus: 429,
    status: "error",
    errorCode: "RAIL_RATE_LIMITED",
  },
  unavailable: {
    httpStatus: 503,
    status: "error",
    errorCode: "RAIL_UNAVAILABLE",
  },
  unauthorized: {
    httpStatus: 401,
    status: "error",
    errorCode: "RAIL_UNAUTHORIZED",
  },
  malformed: { httpStatus: 200, status: "error", errorCode: "RAIL_PROTOCOL" },
};

// A rejection code as the wire may carry it: short, printable, no spaces —
// a catalogue key or an access point's own reference ("E-1001",
// "mbs.invalid_tin"). Anything else falls back to MBS_SCHEMA_INVALID so a
// rail can never inject an arbitrary lifecycle reason or Desk-case code.
// Shared by the transport and the scripted fake so a scripted code the
// wire would never deliver is never asserted in a pipeline test.
export const MAX_REJECTION_CODE_LENGTH = 64;
const REJECTION_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitiseRejectionCode(code: unknown): string | null {
  return typeof code === "string" && REJECTION_CODE.test(code) ? code : null;
}

/**
 * A lookup that could not be answered — timeout, 5xx, refused credentials,
 * an unreadable body. Distinct from a miss (null): the stamp may well exist,
 * so callers retry rather than fail the invoice.
 */
export class RailLookupError extends Error {
  readonly rail: Rail;
  readonly code: string;

  constructor(rail: Rail, code: string, message?: string) {
    super(message ?? `rail lookup failed on ${rail}: ${code}`);
    this.name = "RailLookupError";
    this.rail = rail;
    this.code = code;
  }
}

/** The four fields an accepted submission carries on the wire. */
export interface StampFields {
  irn: string;
  csid: string;
  qrPayload: string;
  signedArtifactRef: string;
}

/**
 * Deterministic stamp derivation shared by the simulator and both fakes: the
 * same canonical invoice always yields the same IRN (idempotency at the
 * rail), the CSID is an HMAC over (IRN + idempotency key) that only the
 * issuing side can produce, and the QR payload carries the verify facts.
 */
export function deterministicStamp(
  inv: CanonicalInvoice,
  idempotencyKey: string,
  secret: string,
): StampFields {
  const digest = createHash("sha256").update(canonicalJson(inv)).digest("hex");
  const irn = `IRN-${digest.slice(0, 16).toUpperCase()}`;
  const csid = createHmac("sha256", secret)
    .update(irn + idempotencyKey)
    .digest("hex")
    .slice(0, 24);
  const signedArtifactRef = createHmac("sha256", secret)
    .update(canonicalJson(inv))
    .digest("base64");
  const qrPayload = Buffer.from(
    JSON.stringify({
      irn,
      csid,
      tin: inv.supplier.tin,
      total: inv.payableAmount,
    }),
  ).toString("base64");
  return { irn, csid, qrPayload, signedArtifactRef };
}

/**
 * A scripted fault register: faults queue per (op, invoice number) — FIFO,
 * each consumed `times` calls, unbounded when unset; `"*"` scripts every
 * invoice not otherwise scripted. Shared by the scripted transport and the
 * fake rail server so a scenario reads the same in both.
 */
export class FaultScript {
  private readonly queues = new Map<string, RailFault[]>();

  script(invoiceNumber: string, fault: RailFault): void {
    const key = `${fault.op ?? "submit"}:${invoiceNumber}`;
    const queue = this.queues.get(key) ?? [];
    queue.push({ ...fault });
    this.queues.set(key, queue);
  }

  /** Consume the next fault for this call (exact key first, then "*"). */
  next(invoiceNumber: string, op: RailFaultOp = "submit"): RailFault | null {
    for (const name of [invoiceNumber, "*"]) {
      const key = `${op}:${name}`;
      const queue = this.queues.get(key);
      const head = queue?.[0];
      if (!queue || !head) continue;
      if (head.times !== undefined) {
        head.times -= 1;
        if (head.times <= 0) queue.shift();
        if (queue.length === 0) this.queues.delete(key);
      }
      return { ...head };
    }
    return null;
  }

  reset(): void {
    this.queues.clear();
  }
}

/**
 * The StampResult a classified submit outcome yields — what the scripted
 * transport answers directly and what the HTTP transport must arrive at
 * after mapping the fake rail's wire response.
 */
export function classifiedResult(
  rail: Rail,
  fault: RailFault,
  ctx: {
    inv: CanonicalInvoice;
    idempotencyKey: string;
    secret: string;
    provider: string;
    environment: string;
  },
): StampResult {
  const shape = RAIL_FAULT_TABLE[fault.outcome];
  const base = { rail, provider: ctx.provider, environment: ctx.environment };
  if (fault.outcome === "accept") {
    return {
      ...base,
      status: "accepted",
      ...deterministicStamp(ctx.inv, ctx.idempotencyKey, ctx.secret),
      raw: { accepted: true, httpStatus: shape.httpStatus },
    };
  }
  const errorCode =
    fault.outcome === "reject"
      ? (sanitiseRejectionCode(fault.code) ?? shape.errorCode)
      : shape.errorCode;
  const raw: Record<string, unknown> = {
    code: errorCode,
    httpStatus: shape.httpStatus,
    outcome: fault.outcome,
  };
  if (fault.outcome === "rate_limit") {
    raw.retryAfterMs = Math.max(0, fault.retryAfterSeconds ?? 1) * 1000;
  }
  return { ...base, status: shape.status, errorCode, raw };
}
