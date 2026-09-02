import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  getDb,
  railStatesTable,
  stampRecordsTable,
  stampVerificationsTable,
  invoicesTable,
  type Rail,
} from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical";
import { canonicalJson } from "../../lib/canonical-json";
import { isRetriable } from "../errors";
import { isPresentableAsEligible } from "../invoice/lifecycle";

// One adapter interface over two accredited access-point rails (INT-01, C3).
// The rails are simulated (no real MBS/APP reachable) but exercise the full
// contract: idempotent submission, stamp issuance, verification, failover and a
// circuit breaker (INT-09).

const RAILS: Rail[] = ["rail_primary", "rail_secondary"];

export interface StampResult {
  status: "accepted" | "rejected" | "error";
  rail: Rail;
  irn?: string;
  csid?: string;
  qrPayload?: string;
  signedArtifactRef?: string;
  errorCode?: string;
  raw: Record<string, unknown>;
  // Provenance (R97): which transport answered and in which environment. The
  // pipeline copies both onto the stamp record so a sandbox stamp can never be
  // mistaken for a live one after accreditation.
  provider?: string;
  environment?: string;
}

/**
 * The transport seam (R97). Everything that actually talks to an access point
 * lives behind this interface; the pipeline and the recovery paths only ever
 * see StampResults. Today the one implementation is the simulator below; the
 * accreditation round binds real HTTP transports here without touching the
 * callers. `lookup` answers "did this rail already issue a stamp for this
 * submission?" — the operation a duplicate recovery needs and a resubmission
 * must consult before sending again.
 */
export interface RailTransport {
  readonly name: string;
  readonly environment: string;
  submit(rail: Rail, inv: CanonicalInvoice, idempotencyKey: string): Promise<StampResult>;
  lookup(
    rail: Rail,
    inv: CanonicalInvoice,
    idempotencyKey: string,
  ): Promise<StampResult | null>;
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
    provider: SIMULATOR.name,
    environment: SIMULATOR.environment,
  };
}

// The simulator: deterministic, always accepts, keeps no history — so its
// lookup answers null. A duplicate against a real rail is an
// accepted-but-unrecorded submission; the simulator cannot produce one, which
// is exactly why the recovery paths are exercised through an injected
// transport in the pipeline tests.
const SIMULATOR: RailTransport = {
  name: "simulator",
  environment: "sandbox",
  async submit(rail, inv, idempotencyKey) {
    return callRail(rail, inv, idempotencyKey);
  },
  async lookup() {
    return null;
  },
};

let transport: RailTransport = SIMULATOR;

/** The transport in use (the simulator unless one has been bound). */
export function currentRailTransport(): RailTransport {
  return transport;
}

/**
 * Bind a transport (null restores the simulator). Returns the previous one so a
 * test can restore it. This is the seam the accreditation round will drive
 * from environment configuration.
 */
export function setRailTransport(next: RailTransport | null): RailTransport {
  const previous = transport;
  transport = next ?? SIMULATOR;
  return previous;
}

// ---- Circuit breaker (persisted per rail) ----
const FAILURE_THRESHOLD = 3;
const OPEN_COOLDOWN_MS = 30_000;

async function ensureRailState(rail: Rail) {
  await getDb()
    .insert(railStatesTable)
    .values({ rail })
    .onConflictDoNothing({ target: railStatesTable.rail });
  const [row] = await getDb()
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
      await getDb()
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
  await getDb()
    .update(railStatesTable)
    .set({ state: "closed", failureCount: 0, openedAt: null })
    .where(eq(railStatesTable.rail, rail));
}

async function recordFailure(rail: Rail): Promise<void> {
  const state = await ensureRailState(rail);
  const failureCount = state.failureCount + 1;
  if (failureCount >= FAILURE_THRESHOLD) {
    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount, openedAt: new Date() })
      .where(eq(railStatesTable.rail, rail));
  } else {
    await getDb()
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
    const result = await transport.submit(rail, inv, idempotencyKey);
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

/**
 * Recover a stamp the rail says it already issued (R97). Called when a
 * submission comes back MBS_DUPLICATE — the rail accepted an earlier try whose
 * result never reached us (a crash between the call and the stamp write, a
 * reconcile re-send, an operator replay) — and by reconcile() before it
 * resubmits a stuck invoice. Asks the rail that reported the duplicate first,
 * then the other; an open breaker is honoured because a lookup is still a call.
 * Returns null when no rail knows the submission, in which case the caller
 * keeps the terminal rejection.
 */
export async function recoverExistingStamp(
  inv: CanonicalInvoice,
  idempotencyKey: string,
  preferred?: Rail,
): Promise<StampResult | null> {
  const order = preferred
    ? [preferred, ...RAILS.filter((r) => r !== preferred)]
    : RAILS;
  for (const rail of order) {
    if (!(await railAvailable(rail))) continue;
    const found = await transport.lookup(rail, inv, idempotencyKey);
    if (found && found.status === "accepted" && found.irn && found.csid) {
      await recordSuccess(rail);
      return found;
    }
  }
  return null;
}

// ---- Stamp verification with a freshness cache (CORE-04) ----
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface StampVerification {
  valid: boolean;
  rail: string;
  cached: boolean;
  // CORE-09: a stamped invoice that has been cancelled or credited must never
  // be presented as eligible, however valid its stamp remains.
  eligible: boolean;
  invoiceStatus: string | null;
}

// Lifecycle eligibility is always read live (never from the freshness cache) so
// a cancellation reflects on the very next verification (CORE-09).
async function lookupLifecycle(
  irn: string,
  csid: string,
): Promise<{ eligible: boolean; invoiceStatus: string | null }> {
  const [row] = await getDb()
    .select({ status: invoicesTable.status })
    .from(stampRecordsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, stampRecordsTable.invoiceId))
    .where(
      and(eq(stampRecordsTable.irn, irn), eq(stampRecordsTable.csid, csid)),
    )
    .limit(1);
  if (!row) return { eligible: false, invoiceStatus: null };
  return {
    eligible: isPresentableAsEligible(row.status),
    invoiceStatus: row.status,
  };
}

export async function verifyStamp(
  irn: string,
  csid: string,
): Promise<StampVerification> {
  const now = new Date();
  const [fresh] = await getDb()
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
    const lifecycle = await lookupLifecycle(irn, csid);
    return {
      valid: fresh.valid,
      rail: fresh.rail,
      cached: true,
      eligible: fresh.valid && lifecycle.eligible,
      invoiceStatus: lifecycle.invoiceStatus,
    };
  }
  // Verify against the source of truth: a stamp is valid iff an accepted
  // submission recorded this exact (IRN, CSID) pair in stamp_records. The CSID
  // is an HMAC over (IRN + idempotency key) that only the issuing rail can
  // produce, so a forged pair will never match a persisted record.
  const [record] = await getDb()
    .select({ rail: stampRecordsTable.rail })
    .from(stampRecordsTable)
    .where(
      and(eq(stampRecordsTable.irn, irn), eq(stampRecordsTable.csid, csid)),
    )
    .limit(1);
  const valid = Boolean(record);
  const matchedRail: Rail = record?.rail ?? RAILS[0];
  // Cache HITS only. This endpoint is public and unauthenticated, so caching
  // misses would let anyone grow the table without bound by spraying garbage
  // (irn, csid) pairs — and a negative row only ever saves the indexed
  // stamp_records probe above, which is as cheap as the cache lookup itself.
  // Stale rows are pruned by the pipeline retention sweep.
  if (valid) {
    await getDb().insert(stampVerificationsTable).values({
      id: randomUUID(),
      irn,
      csid,
      valid,
      rail: matchedRail,
      checkedAt: now,
      freshUntil: new Date(now.getTime() + CACHE_TTL_MS),
      raw: {},
    });
  }
  const lifecycle = valid
    ? await lookupLifecycle(irn, csid)
    : { eligible: false, invoiceStatus: null };
  return {
    valid,
    rail: matchedRail,
    cached: false,
    eligible: valid && lifecycle.eligible,
    invoiceStatus: lifecycle.invoiceStatus,
  };
}

// Bulk stamp verification for ledger analysis (ADV-02). A per-invoice call over
// a 1000-row ledger would blow the request budget, so this resolves the whole
// batch with a single indexed select against the source of truth and returns
// the set of valid "irn|csid" keys. Freshness-cache bookkeeping is skipped: a
// one-shot advisory report does not need the cache and writing 1000 rows would
// itself risk the transaction budget.
export async function verifyStampBatch(
  pairs: { irn: string; csid: string }[],
): Promise<Set<string>> {
  const irns = [...new Set(pairs.map((p) => p.irn).filter(Boolean))];
  if (irns.length === 0) return new Set();
  const records = await getDb()
    .select({ irn: stampRecordsTable.irn, csid: stampRecordsTable.csid })
    .from(stampRecordsTable)
    .where(inArray(stampRecordsTable.irn, irns));
  const valid = new Set<string>();
  for (const r of records) valid.add(`${r.irn}|${r.csid}`);
  return valid;
}
