import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  getDb,
  withDatabaseContext,
  pool,
  railStatesTable,
  stampRecordsTable,
  stampVerificationsTable,
  invoicesTable,
  type Rail,
} from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical";
import { isRetriable } from "../errors";
import { isPresentableAsEligible } from "../invoice/lifecycle";
import { RailLookupError, deterministicStamp } from "./faults";
import {
  createHttpRailTransport,
  httpRailConfigFromEnv,
  railTimeoutMs,
} from "./transports/http";
import type { RailTransport, StampResult } from "./contracts";

export type { RailTransport, StampResult } from "./contracts";

// One adapter interface over two accredited access-point rails (INT-01, C3).
// The rails are simulated by default (no real MBS/APP reachable until
// accreditation) but exercise the full contract: idempotent submission, stamp
// issuance, verification, failover and a circuit breaker (INT-09). R95 adds
// the HTTP transport behind the same seam, bound only when RAIL_PRIMARY_URL /
// RAIL_SECONDARY_URL is lit — see "Transport resolution" below.

const RAILS: Rail[] = ["rail_primary", "rail_secondary"];

// Sandbox signing material for deterministic simulator output only. Live
// transports own deployment credentials outside this module.
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
  return transport.rails && transport.rails.length > 0
    ? transport.rails
    : RAILS;
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

/**
 * How long a worker may hold the half-open probe slot (R102): one submit
 * and one lookup at the transport budget, plus slack. A probe that dies
 * with the slot (a crashed instance) is taken over once the lease passes.
 */
export function probeLeaseMs(): number {
  return 2 * railTimeoutMs() + 5_000;
}

export interface BreakerStatus {
  rail: Rail;
  state: "closed" | "open" | "half_open";
  failureCount: number;
  openedAt: Date | null;
  retryAt: Date | null;
  /** When the current half-open probe took the slot (R102). */
  probeStartedAt: Date | null;
  /** The catalogue code of the failure that last counted against the rail (R102). */
  lastErrorCode: string | null;
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
    probeStartedAt: state.probeStartedAt,
    lastErrorCode: state.lastErrorCode,
  };
}

// Read the breaker row, creating it once. A plain SELECT first (R95): an
// upsert on every gate would queue behind another worker's uncommitted
// breaker write for as long as that worker's rail call takes.
async function ensureRailState(rail: Rail) {
  // HTTP-triggered workers retain the HTTP boundary between their short
  // transactions. Scope the read, never the external rail call that follows.
  const read = () =>
    withDatabaseContext({ bypass: true, firmId: null }, () =>
      getDb()
        .select()
        .from(railStatesTable)
        .where(eq(railStatesTable.rail, rail))
        .limit(1),
    );
  const [existing] = await read();
  if (existing) return existing;
  await pool.query(
    "INSERT INTO rail_states (rail) VALUES ($1) ON CONFLICT (rail) DO NOTHING",
    [rail],
  );
  const [row] = await read();
  return row;
}

// ---- Breaker bookkeeping OUTSIDE the event transaction (R102) ----
//
// Every breaker WRITE below is one short autocommit statement on the raw
// `pool`, never a statement inside the worker's event transaction: a write
// there held the rail_states row lock for the length of the rail call, so a
// second worker's gate queued behind the first worker's timeout, and two
// workers failing over in opposite orders could deadlock. It also means a
// failure the rail really produced is remembered even when the event's own
// writes are rolled back — a breaker must not forget an outage because a
// later write failed. Reads stay plain SELECTs, which never wait.
//
// The half-open PROBE is a slot claimed atomically (`UPDATE … WHERE state =
// 'open' AND retry_at <= now()` — exactly one worker wins), stamped with
// probe_started_at and released by recordSuccess/recordFailure. Every other
// worker is refused until the probe's lease ends; a probe that dies with the
// slot is taken over once its lease has passed.

// The gate a call passes through: an open breaker whose retry-at has come
// lets ONE probe through (half_open); otherwise it refuses and says when.
// Only a SUBMIT is a probe — it always ends in recordSuccess/recordFailure,
// which moves the breaker on. A lookup (`probe: false`) is admitted on the
// same terms but never claims the slot: a null lookup records nothing, and
// a breaker parked in half_open by a lookup would wave every later submit
// through without a probe (R95).
async function railGate(
  rail: Rail,
  opts: { probe: boolean } = { probe: true },
): Promise<{ allowed: boolean; retryAt: Date | null }> {
  const state = await ensureRailState(rail);
  const now = Date.now();
  if (state.state === "closed") return { allowed: true, retryAt: null };
  if (state.state === "open") {
    const retryAt =
      state.retryAt ??
      new Date((state.openedAt?.getTime() ?? 0) + railOpenCooldownMs());
    if (now < retryAt.getTime()) return { allowed: false, retryAt };
    if (!opts.probe) return { allowed: true, retryAt: null };
    return claimProbe(rail);
  }
  // half_open: a probe holds the slot (or died holding it).
  if (!opts.probe) return { allowed: true, retryAt: null };
  const leaseEnd = new Date(
    (state.probeStartedAt?.getTime() ?? 0) + probeLeaseMs(),
  );
  if (now < leaseEnd.getTime()) return { allowed: false, retryAt: leaseEnd };
  return claimProbe(rail);
}

/** Take the half-open slot if it is free (retry-at passed) or stale (lease passed). */
async function claimProbe(
  rail: Rail,
): Promise<{ allowed: boolean; retryAt: Date | null }> {
  const lease = probeLeaseMs();
  const { rowCount } = await pool.query(
    `UPDATE rail_states
        SET state = 'half_open', probe_started_at = now(), updated_at = now()
      WHERE rail = $1
        AND (
          (state = 'open'
             AND COALESCE(retry_at, COALESCE(opened_at, to_timestamp(0)) + ($2::int * interval '1 millisecond')) <= now())
          OR (state = 'half_open'
             AND COALESCE(probe_started_at, to_timestamp(0)) + ($3::int * interval '1 millisecond') <= now())
        )`,
    [rail, railOpenCooldownMs(), lease],
  );
  if (rowCount === 1) return { allowed: true, retryAt: null };
  // Another worker holds the probe (or the breaker just moved): wait it out.
  return { allowed: false, retryAt: new Date(Date.now() + lease) };
}

/** Whether a lookup may run: the breaker's answer, without moving it. */
async function railAvailable(rail: Rail): Promise<boolean> {
  return (await railGate(rail, { probe: false })).allowed;
}

async function recordSuccess(rail: Rail): Promise<void> {
  await pool.query(
    `UPDATE rail_states
        SET state = 'closed', failure_count = 0, opened_at = NULL, retry_at = NULL,
            probe_started_at = NULL, last_error_code = NULL, updated_at = now()
      WHERE rail = $1`,
    [rail],
  );
}

// One statement, so two workers failing at once cannot lose a count: the
// threshold opens the breaker (or re-arms an open/half-open one — the
// outage instance `opened_at` is kept, only retry_at moves), the code is
// remembered for the alert and the Desk, and the probe slot is released.
async function recordFailure(rail: Rail, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE rail_states
        SET failure_count = failure_count + 1,
            last_error_code = $2,
            state = CASE WHEN failure_count + 1 >= $3 THEN 'open'::circuit_state ELSE state END,
            opened_at = CASE WHEN failure_count + 1 >= $3 THEN COALESCE(opened_at, now()) ELSE opened_at END,
            retry_at = CASE WHEN failure_count + 1 >= $3 THEN now() + ($4::int * interval '1 millisecond') ELSE retry_at END,
            probe_started_at = NULL,
            updated_at = now()
      WHERE rail = $1`,
    [rail, errorCode.slice(0, 64), FAILURE_THRESHOLD, railOpenCooldownMs()],
  );
}

export interface FailoverResult {
  result: StampResult;
  /** Every rail considered, breaker refusals included (a refusal carries raw.circuit). */
  tried: StampResult[];
  /** The rails actually CALLED, in order — what the attempts table records. */
  sent: StampResult[];
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
  const sent: StampResult[] = [];
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
    sent.push(result);
    if (result.status === "accepted") {
      await recordSuccess(rail);
      return { result, tried, sent, circuitOpen: false, retryAfter: null };
    }
    if (result.status === "rejected") {
      // Terminal business rejection; do not failover.
      await recordSuccess(rail);
      return { result, tried, sent, circuitOpen: false, retryAfter: null };
    }
    // Transient error: count against the breaker and try the next rail.
    await recordFailure(rail, result.errorCode ?? "UNKNOWN");
    if (!isRetriable(result.errorCode ?? "UNKNOWN")) {
      return { result, tried, sent, circuitOpen: false, retryAfter: null };
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
    sent,
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
  // A lookup the rail could not answer (RailLookupError) counts against that
  // rail's breaker and is remembered: if no rail answered definitively and
  // none held the stamp, the error is re-raised so the caller RETRIES —
  // the stamp may exist, and "no rail knows it" must only ever mean 404.
  let unanswered: RailLookupError | null = null;
  let asked = 0;
  for (const rail of order) {
    if (!(await railAvailable(rail))) continue;
    asked += 1;
    let found: StampResult | null;
    try {
      found = await transport.lookup(rail, inv, idempotencyKey);
    } catch (err) {
      if (!(err instanceof RailLookupError)) throw err;
      await recordFailure(rail, err.code);
      unanswered = err;
      continue;
    }
    if (found && found.status === "accepted" && found.irn && found.csid) {
      await recordSuccess(rail);
      return found;
    }
  }
  if (unanswered) throw unanswered;
  // Every served rail refused the lookup: nobody was asked, so "no rail
  // knows the submission" would be a guess — the caller retries instead.
  if (asked === 0) {
    throw new RailLookupError(order[0] ?? "rail_primary", "RAIL_UNAVAILABLE");
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
    await getDb()
      .insert(stampVerificationsTable)
      .values({
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
