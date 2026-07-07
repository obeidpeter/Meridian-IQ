import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  db,
  railStatesTable,
  stampRecordsTable,
  stampVerificationsTable,
  type Rail,
} from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical";
import { canonicalJson } from "../../lib/canonical-json";
import { isRetriable } from "../errors";

// One adapter interface over two accredited access-point rails (INT-01, C3).
// The rails are simulated (no real MBS/APP reachable) but exercise the full
// contract: idempotent submission, stamp issuance, verification, failover and a
// circuit breaker (INT-09). A sandbox harness injects faults for testing (INT-02).

export const RAILS: Rail[] = ["rail_primary", "rail_secondary"];

export interface StampResult {
  status: "accepted" | "rejected" | "error";
  rail: Rail;
  irn?: string;
  csid?: string;
  qrPayload?: string;
  signedArtifactRef?: string;
  errorCode?: string;
  raw: Record<string, unknown>;
}

// ---- Sandbox harness: fault injection ----
type RailMode = "ok" | "timeout" | "unavailable" | `reject:${string}`;
const railModes = new Map<Rail, RailMode>();
const perInvoiceModes = new Map<string, RailMode>();

export function setRailMode(rail: Rail, mode: RailMode): void {
  railModes.set(rail, mode);
}
export function setInvoiceMode(invoiceNumber: string, mode: RailMode): void {
  perInvoiceModes.set(invoiceNumber, mode);
}
export function resetSandbox(): void {
  railModes.clear();
  perInvoiceModes.clear();
}

const RAIL_SECRET: Record<Rail, string> = {
  rail_primary: "sandbox-rail-primary-secret",
  rail_secondary: "sandbox-rail-secondary-secret",
};

// A single simulated rail call. Deterministic stamp derived from the canonical
// payload so the same invoice yields the same IRN (idempotency at the rail).
function callRail(
  rail: Rail,
  inv: CanonicalInvoice,
  idempotencyKey: string,
): StampResult {
  const mode = perInvoiceModes.get(inv.invoiceNumber) ?? railModes.get(rail) ?? "ok";
  if (mode === "timeout") {
    return { status: "error", rail, errorCode: "RAIL_TIMEOUT", raw: { mode } };
  }
  if (mode === "unavailable") {
    return {
      status: "error",
      rail,
      errorCode: "RAIL_UNAVAILABLE",
      raw: { mode },
    };
  }
  if (mode.startsWith("reject:")) {
    return {
      status: "rejected",
      rail,
      errorCode: mode.slice("reject:".length),
      raw: { mode },
    };
  }
  const digest = createHash("sha256")
    .update(canonicalJson(inv))
    .digest("hex");
  const irn = `IRN-${digest.slice(0, 16).toUpperCase()}`;
  const csid = createHmac("sha256", RAIL_SECRET[rail])
    .update(irn + idempotencyKey)
    .digest("hex")
    .slice(0, 24);
  const signedArtifactRef = createHmac("sha256", RAIL_SECRET[rail])
    .update(canonicalJson(inv))
    .digest("base64");
  const qrPayload = Buffer.from(
    JSON.stringify({ irn, csid, tin: inv.supplier.tin, total: inv.payableAmount }),
  ).toString("base64");
  return {
    status: "accepted",
    rail,
    irn,
    csid,
    qrPayload,
    signedArtifactRef,
    raw: { accepted: true },
  };
}

// ---- Circuit breaker (persisted per rail) ----
const FAILURE_THRESHOLD = 3;
const OPEN_COOLDOWN_MS = 30_000;

async function ensureRailState(rail: Rail) {
  await db
    .insert(railStatesTable)
    .values({ rail })
    .onConflictDoNothing({ target: railStatesTable.rail });
  const [row] = await db
    .select()
    .from(railStatesTable)
    .where(eq(railStatesTable.rail, rail))
    .limit(1);
  return row;
}

async function railAvailable(rail: Rail): Promise<boolean> {
  const state = await ensureRailState(rail);
  if (state.state === "open") {
    const openedAt = state.openedAt?.getTime() ?? 0;
    if (Date.now() - openedAt >= OPEN_COOLDOWN_MS) {
      await db
        .update(railStatesTable)
        .set({ state: "half_open" })
        .where(eq(railStatesTable.rail, rail));
      return true;
    }
    return false;
  }
  return true;
}

async function recordSuccess(rail: Rail): Promise<void> {
  await db
    .update(railStatesTable)
    .set({ state: "closed", failureCount: 0, openedAt: null })
    .where(eq(railStatesTable.rail, rail));
}

async function recordFailure(rail: Rail): Promise<void> {
  const state = await ensureRailState(rail);
  const failureCount = state.failureCount + 1;
  if (failureCount >= FAILURE_THRESHOLD) {
    await db
      .update(railStatesTable)
      .set({ state: "open", failureCount, openedAt: new Date() })
      .where(eq(railStatesTable.rail, rail));
  } else {
    await db
      .update(railStatesTable)
      .set({ failureCount })
      .where(eq(railStatesTable.rail, rail));
  }
}

// Submit with idempotent failover across rails and circuit-breaker awareness.
// A rejection (invalid TIN, schema) is terminal and NOT retried on the other
// rail; a transient error (timeout, unavailable) triggers failover.
export async function submitWithFailover(
  inv: CanonicalInvoice,
  idempotencyKey: string,
): Promise<{ result: StampResult; tried: StampResult[] }> {
  const tried: StampResult[] = [];
  for (const rail of RAILS) {
    if (!(await railAvailable(rail))) {
      tried.push({
        status: "error",
        rail,
        errorCode: "RAIL_UNAVAILABLE",
        raw: { circuit: "open" },
      });
      continue;
    }
    const result = callRail(rail, inv, idempotencyKey);
    tried.push(result);
    if (result.status === "accepted") {
      await recordSuccess(rail);
      return { result, tried };
    }
    if (result.status === "rejected") {
      // Terminal business rejection; do not failover.
      await recordSuccess(rail);
      return { result, tried };
    }
    // Transient error: count against the breaker and try the next rail.
    await recordFailure(rail);
    if (!isRetriable(result.errorCode ?? "UNKNOWN")) {
      return { result, tried };
    }
  }
  return {
    result: tried[tried.length - 1] ?? {
      status: "error",
      rail: RAILS[0],
      errorCode: "RAIL_UNAVAILABLE",
      raw: {},
    },
    tried,
  };
}

// ---- Stamp verification with a freshness cache (CORE-04) ----
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function verifyStamp(
  irn: string,
  csid: string,
): Promise<{ valid: boolean; rail: string; cached: boolean }> {
  const now = new Date();
  const [fresh] = await db
    .select()
    .from(stampVerificationsTable)
    .where(
      and(
        eq(stampVerificationsTable.irn, irn),
        eq(stampVerificationsTable.csid, csid),
        gt(stampVerificationsTable.freshUntil, now),
      ),
    )
    .limit(1);
  if (fresh) {
    return { valid: fresh.valid, rail: fresh.rail, cached: true };
  }
  // Verify against the source of truth: a stamp is valid iff an accepted
  // submission recorded this exact (IRN, CSID) pair in stamp_records. The CSID
  // is an HMAC over (IRN + idempotency key) that only the issuing rail can
  // produce, so a forged pair will never match a persisted record.
  const [record] = await db
    .select({ rail: stampRecordsTable.rail })
    .from(stampRecordsTable)
    .where(
      and(eq(stampRecordsTable.irn, irn), eq(stampRecordsTable.csid, csid)),
    )
    .limit(1);
  const valid = Boolean(record);
  const matchedRail: Rail = record?.rail ?? RAILS[0];
  await db.insert(stampVerificationsTable).values({
    id: randomUUID(),
    irn,
    csid,
    valid,
    rail: matchedRail,
    checkedAt: now,
    freshUntil: new Date(now.getTime() + CACHE_TTL_MS),
    raw: {},
  });
  return { valid, rail: matchedRail, cached: false };
}
