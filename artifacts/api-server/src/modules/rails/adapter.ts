import { randomUUID } from "node:crypto";
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
import { isRetriable } from "../errors";
import { isPresentableAsEligible } from "../invoice/lifecycle";
import { deterministicStamp } from "./faults";
import { createHttpRailTransport, httpRailConfigFromEnv } from "./transports/http";

// One adapter interface over two accredited access-point rails (INT-01, C3).
// The rails are simulated by default (no real MBS/APP reachable until
// accreditation) but exercise the full contract: idempotent submission, stamp
// issuance, verification, failover and a circuit breaker (INT-09). R95 adds
// the HTTP transport behind the same seam, bound only when RAIL_PRIMARY_URL /
// RAIL_SECONDARY_URL is lit — see "Transport resolution" below.

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
  /**
   * The rails this transport serves (R95); undefined = every rail. Failover
   * and recovery iterate only served rails, so a deployment with one access
   * point lit never counts the other rail as a failure.
   */
  readonly rails?: readonly Rail[];
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
// payload so the same invoice yields the same IRN (idempotency at the rail);
// the derivation lives in faults.ts so the fakes mint identical stamps.
function callRail(
  rail: Rail,
  inv: CanonicalInvoice,
  idempotencyKey: string,
): StampResult {
  return {
    status: "accepted",
    rail,
    ...deterministicStamp(inv, idempotencyKey, RAIL_SECRET[rail]),
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

// ---- Transport resolution (R95) ----
//
// Three tiers, checked per call so a flipped environment is honoured without
// a restart (the payments/provider.ts posture):
//   1. a transport BOUND with setRailTransport (tests, or an explicit wiring);
//   2. the HTTP transport, when RAIL_PRIMARY_URL / RAIL_SECONDARY_URL is lit —
//      memoised on the exact env tuple so it is rebuilt only when that changes;
//   3. the in-code simulator.
// The simulator therefore stays the default until accreditation lights a URL.
let bound: RailTransport | null = null;
let envTransport: { key: string; transport: RailTransport } | null = null;

function transportFromEnv(): RailTransport {
  const cfg = httpRailConfigFromEnv();
  if (!cfg) {
    envTransport = null;
    return SIMULATOR;
  }
  const key = JSON.stringify(cfg);
  if (!envTransport || envTransport.key !== key) {
    envTransport = { key, transport: createHttpRailTransport(cfg) };
  }
  return envTransport.transport;
}

/** The transport in use: bound, else the environment's, else the simulator. */
export function currentRailTransport(): RailTransport {
  return bound ?? transportFromEnv();
}

/**
 * Bind a transport; null unbinds it, restoring environment-driven resolution
 * (the simulator when no rail URL is lit). Returns the previously bound
 * transport (or the one resolution would have used) so a test can restore it.
 */
export function setRailTransport(next: RailTransport | null): RailTransport {
  const previous = currentRailTransport();
  bound = next;
  return previous;
}

/** The rails a transport serves (every rail unless it says otherwise). */
function servedRails(transport: RailTransport): readonly Rail[] {
  return transport.rails && transport.rails.length > 0 ? transport.rails : RAILS;
}

export interface RailTransportSummary {
  transport: string;
  environment: string;
  rails: Record<Rail, { configured: boolean }>;
}

/** What the operator sees: which transport is live and which rails it serves. */
export function railTransportSummary(): RailTransportSummary {
  const transport = currentRailTransport();
  const served = new Set(servedRails(transport));
  return {
    transport: transport.name,
    environment: transport.environment,
    rails: {
      rail_primary: { configured: served.has("rail_primary") },
      rail_secondary: { configured: served.has("rail_secondary") },
    },
  };
}

// ---- Circuit breaker (persisted per rail) ----
//
// Outage policy (R96): `openedAt` is the OUTAGE INSTANCE — stamped when the
// breaker first opens and left alone while it stays open, so the health
// watch's one-alert-per-outage key (`rail:openedAt`) holds across every
// failed half-open probe. `retryAt` is the separate clock: when the next
// probe may run. A failed probe re-arms retryAt only; a success closes the
// breaker and clears both.
const FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_COOLDOWN_MS = 30_000;

export function railOpenCooldownMs(): number {
  const configured = Number(process.env.RAIL_OPEN_COOLDOWN_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_OPEN_COOLDOWN_MS;
}

export interface BreakerStatus {
  rail: Rail;
  state: "closed" | "open" | "half_open";
  failureCount: number;
  openedAt: Date | null;
  retryAt: Date | null;
}

/** The breaker as an operator or a parked submission reads it. */
export async function breakerStatus(rail: Rail): Promise<BreakerStatus> {
  const state = await ensureRailState(rail);
  return {
    rail,
    state: state.state,
    failureCount: state.failureCount,
    openedAt: state.openedAt,
    retryAt: state.retryAt,
  };
}

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

// The gate a call passes through: an open breaker whose retry-at has come
// lets ONE probe through (half_open); otherwise it refuses and says when.
// Only a SUBMIT is a probe — it always ends in recordSuccess/recordFailure,
// which moves the breaker on. A lookup (`probe: false`) is admitted on the
// same terms but never flips the state: a null lookup records nothing, and a
// breaker parked in half_open by a lookup would wave every later submit
// through without a probe (R95).
async function railGate(
  rail: Rail,
  opts: { probe: boolean } = { probe: true },
): Promise<{ allowed: boolean; retryAt: Date | null }> {
  const state = await ensureRailState(rail);
  if (state.state !== "open") return { allowed: true, retryAt: null };
  const retryAt =
    state.retryAt ??
    new Date((state.openedAt?.getTime() ?? 0) + railOpenCooldownMs());
  if (Date.now() >= retryAt.getTime()) {
    if (opts.probe) {
      await getDb()
        .update(railStatesTable)
        .set({ state: "half_open" })
        .where(eq(railStatesTable.rail, rail));
    }
    return { allowed: true, retryAt: null };
  }
  return { allowed: false, retryAt };
}

/** Whether a lookup may run: the breaker's answer, without moving it. */
async function railAvailable(rail: Rail): Promise<boolean> {
  return (await railGate(rail, { probe: false })).allowed;
}

async function recordSuccess(rail: Rail): Promise<void> {
  await getDb()
    .update(railStatesTable)
    .set({ state: "closed", failureCount: 0, openedAt: null, retryAt: null })
    .where(eq(railStatesTable.rail, rail));
}

async function recordFailure(rail: Rail): Promise<void> {
  const state = await ensureRailState(rail);
  const failureCount = state.failureCount + 1;
  if (failureCount >= FAILURE_THRESHOLD) {
    const now = new Date();
    await getDb()
      .update(railStatesTable)
      .set({
        state: "open",
        failureCount,
        // The outage instance started when the breaker FIRST opened; a
        // failed probe re-arms the retry clock only.
        openedAt: state.openedAt ?? now,
        retryAt: new Date(now.getTime() + railOpenCooldownMs()),
      })
      .where(eq(railStatesTable.rail, rail));
  } else {
    await getDb()
      .update(railStatesTable)
      .set({ failureCount })
      .where(eq(railStatesTable.rail, rail));
  }
}

export interface FailoverResult {
  result: StampResult;
  tried: StampResult[];
  /** True when every rail's breaker refused the call — nothing was sent. */
  circuitOpen: boolean;
  /** The earliest moment a rail will accept a probe, when circuitOpen. */
  retryAfter: Date | null;
}

// Submit with idempotent failover across rails and circuit-breaker awareness.
// A rejection (invalid TIN, schema) is terminal and NOT retried on the other
// rail; a transient error (timeout, unavailable) triggers failover. When every
// breaker is open the call is refused without touching a rail and the caller
// PARKS the submission until `retryAfter` (R96) rather than burning a retry.
export async function submitWithFailover(
  inv: CanonicalInvoice,
  idempotencyKey: string,
): Promise<FailoverResult> {
  const transport = currentRailTransport();
  const served = servedRails(transport);
  const tried: StampResult[] = [];
  let refused = 0;
  let retryAfter: Date | null = null;
  for (const rail of served) {
    const gate = await railGate(rail);
    if (!gate.allowed) {
      refused += 1;
      if (
        gate.retryAt &&
        (retryAfter === null || gate.retryAt.getTime() < retryAfter.getTime())
      ) {
        retryAfter = gate.retryAt;
      }
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
      return { result, tried, circuitOpen: false, retryAfter: null };
    }
    if (result.status === "rejected") {
      // Terminal business rejection; do not failover.
      await recordSuccess(rail);
      return { result, tried, circuitOpen: false, retryAfter: null };
    }
    // Transient error: count against the breaker and try the next rail.
    await recordFailure(rail);
    if (!isRetriable(result.errorCode ?? "UNKNOWN")) {
      return { result, tried, circuitOpen: false, retryAfter: null };
    }
  }
  const circuitOpen = refused === served.length;
  return {
    result: tried[tried.length - 1] ?? {
      status: "error",
      rail: RAILS[0],
      errorCode: "RAIL_UNAVAILABLE",
      raw: {},
    },
    tried,
    circuitOpen,
    retryAfter: circuitOpen ? retryAfter : null,
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
  const transport = currentRailTransport();
  const served = servedRails(transport);
  const order =
    preferred && served.includes(preferred)
      ? [preferred, ...served.filter((r) => r !== preferred)]
      : served;
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
