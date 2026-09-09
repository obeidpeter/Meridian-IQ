import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  auditEventsTable,
  firmsTable,
  invoiceLifecycleEventsTable,
  invoiceLinesTable,
  invoicesTable,
  operatorCasesTable,
  outboxTable,
  partiesTable,
  railStatesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  type Rail,
} from "@workspace/db";
import { setRailTransport } from "../rails/adapter";
import { startFakeRail, type FakeRail } from "../rails/fake-rail";
import type { RailFault } from "../rails/faults";
import { drain, resumeWorker } from "./pipeline";

// The rail soak (R102): drives the real submission pipeline — outbox claim,
// HTTP transport, breakers, failover, recovery, dead-lettering — against two
// conformance fake rails under a seeded mix of faults, with several drain
// loops running at once (the multi-worker shape), then checks the invariants
// the platform promises whatever the rails did:
//
//   - every soak invoice ends stamped or failed, failed ONLY when the rail
//     rejected it; nothing is left pending, processing or half-done;
//   - exactly one stamp per stamped invoice, and its IRN is the one the
//     stamping rail actually holds for that idempotency key;
//   - exactly one lifecycle transition and exactly one stamped/recovered
//     (or rejected) audit row per invoice — no duplicate side effects across
//     retries, failovers, recoveries or concurrent workers;
//   - at most one accepted submission per invoice, a Desk case for every
//     rejection and for nothing else;
//   - the breakers end in a coherent state: never a stale half-open probe.
//
// `rail-soak.test.ts` runs a CI-sized soak; `pnpm --filter
// @workspace/api-server run soak` runs a large one and prints the report.

export interface SoakOptions {
  /** Invoices to push through. */
  invoices: number;
  /** Concurrent drain loops (the multi-worker shape in one process). */
  workers: number;
  /** PRNG seed — the same seed scripts the same faults. */
  seed: number;
  /** Wall-clock cap; the soak reports a violation if it does not settle. */
  deadlineMs: number;
  /** Per-call transport budget (a scripted timeout costs this much). */
  railTimeoutMs?: number;
  /** Breaker cooldown, kept short so an opened breaker probes during the soak. */
  cooldownMs?: number;
  /** Log a line per phase. */
  log?: (line: string) => void;
}

export type SoakScenario =
  | "accept"
  | "reject"
  | "primary_unavailable"
  | "primary_timeout"
  | "rate_limited"
  | "duplicate_recovered"
  | "malformed_then_recovered"
  | "lookup_error_then_recovered"
  | "primary_unauthorized";

export interface SoakReport {
  ok: boolean;
  violations: string[];
  stats: {
    invoices: number;
    workers: number;
    seed: number;
    wallMs: number;
    settled: boolean;
    stamped: number;
    failed: number;
    byScenario: Record<SoakScenario, number>;
    retries: number;
    parks: number;
    recoveredStamps: number;
    stampedVia: Record<Rail, number>;
    perInvoiceMs: { p50: number; p95: number; max: number };
    throughputPerSecond: number;
    breakers: Record<
      Rail,
      { state: string; failureCount: number; lastErrorCode: string | null }
    >;
    railCalls: { primary: number; secondary: number };
  };
}

// mulberry32: a tiny seeded PRNG so a soak is repeatable.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fault mix. Weights are relative; the scenario names double as the
// expectation each invoice is checked against.
const MIX: Array<[SoakScenario, number]> = [
  ["accept", 60],
  ["reject", 6],
  ["primary_unavailable", 8],
  ["primary_timeout", 5],
  ["rate_limited", 5],
  ["duplicate_recovered", 5],
  ["malformed_then_recovered", 4],
  ["lookup_error_then_recovered", 4],
  ["primary_unauthorized", 3],
];

function pickScenario(random: () => number): SoakScenario {
  const total = MIX.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [scenario, weight] of MIX) {
    roll -= weight;
    if (roll < 0) return scenario;
  }
  return "accept";
}

function scriptScenario(
  scenario: SoakScenario,
  invoiceNumber: string,
  primary: FakeRail,
  secondary: FakeRail,
): void {
  const on = (rail: FakeRail, fault: RailFault) =>
    rail.script(invoiceNumber, fault);
  switch (scenario) {
    case "accept":
      return;
    case "reject":
      on(primary, { outcome: "reject", code: "MBS_INVALID_TIN" });
      on(secondary, { outcome: "reject", code: "MBS_INVALID_TIN" });
      return;
    case "primary_unavailable":
      on(primary, { outcome: "unavailable", times: 1 });
      return;
    case "primary_timeout":
      on(primary, { outcome: "timeout", times: 1 });
      return;
    case "rate_limited":
      on(primary, { outcome: "rate_limit", times: 1, retryAfterSeconds: 1 });
      on(secondary, { outcome: "rate_limit", times: 1, retryAfterSeconds: 1 });
      return;
    case "duplicate_recovered":
      on(primary, { outcome: "duplicate", holdsStamp: true });
      return;
    case "malformed_then_recovered":
      // A garbled 2xx from a rail that DID stamp: the same try fails over
      // to the secondary, which may stamp it too, or a retry meets 409 on
      // the primary and recovers — either way exactly one stamp is recorded.
      on(primary, { outcome: "malformed", holdsStamp: true, times: 1 });
      on(secondary, { outcome: "unavailable", times: 1 });
      return;
    case "lookup_error_then_recovered":
      on(primary, { outcome: "duplicate", holdsStamp: true });
      on(primary, { outcome: "unavailable", op: "lookup", times: 1 });
      on(secondary, { outcome: "unavailable", op: "lookup", times: 1 });
      return;
    case "primary_unauthorized":
      on(primary, { outcome: "unauthorized", times: 1 });
      return;
  }
}

const RAIL_ENV_KEYS = [
  "RAIL_PRIMARY_URL",
  "RAIL_SECONDARY_URL",
  "RAIL_PRIMARY_TOKEN",
  "RAIL_SECONDARY_TOKEN",
  "RAIL_ENVIRONMENT",
  "RAIL_TIMEOUT_MS",
  "RAIL_OPEN_COOLDOWN_MS",
  "OUTBOX_MAX_BACKOFF_MS",
] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

async function resetBreakers(): Promise<void> {
  await runInBypassContext(async () => {
    for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
      await getDb()
        .insert(railStatesTable)
        .values({ rail })
        .onConflictDoNothing({ target: railStatesTable.rail });
      await getDb()
        .update(railStatesTable)
        .set({
          state: "closed",
          failureCount: 0,
          openedAt: null,
          retryAt: null,
          probeStartedAt: null,
          lastErrorCode: null,
        })
        .where(eq(railStatesTable.rail, rail));
    }
  });
}

export async function runRailSoak(opts: SoakOptions): Promise<SoakReport> {
  const log = opts.log ?? (() => undefined);
  const random = prng(opts.seed);
  const salt = randomUUID().slice(0, 8);
  const saved = Object.fromEntries(
    RAIL_ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  const primaryToken = `soak-primary-${salt}`;
  const secondaryToken = `soak-secondary-${salt}`;
  const primary = await startFakeRail({ token: primaryToken });
  const secondary = await startFakeRail({ token: secondaryToken });
  const violations: string[] = [];
  const started = Date.now();

  try {
    process.env.RAIL_PRIMARY_URL = primary.url;
    process.env.RAIL_PRIMARY_TOKEN = primaryToken;
    process.env.RAIL_SECONDARY_URL = secondary.url;
    process.env.RAIL_SECONDARY_TOKEN = secondaryToken;
    process.env.RAIL_ENVIRONMENT = "sandbox";
    process.env.RAIL_TIMEOUT_MS = String(opts.railTimeoutMs ?? 300);
    process.env.RAIL_OPEN_COOLDOWN_MS = String(opts.cooldownMs ?? 500);
    process.env.OUTBOX_MAX_BACKOFF_MS = "1000";
    setRailTransport(null);
    resumeWorker();
    await resetBreakers();

    // ---- Seed ----
    const firmId = randomUUID();
    const supplierId = randomUUID();
    const buyerId = randomUUID();
    const scenarios = new Map<string, SoakScenario>();
    const numbers = new Map<string, string>();
    const ids: string[] = [];
    await runInBypassContext(async () => {
      await getDb()
        .insert(firmsTable)
        .values({ id: firmId, name: `soak-${salt}` });
      await getDb()
        .insert(partiesTable)
        .values([
          {
            id: supplierId,
            type: "client_business",
            legalName: `Soak Supplier ${salt}`,
            tin: `soak-${salt}-s`,
            tinValidated: true,
            street: "1 Soak Road",
            city: "Lagos",
          },
          {
            id: buyerId,
            type: "buyer",
            legalName: `Soak Buyer ${salt}`,
            tin: `soak-${salt}-b`,
            tinValidated: true,
            street: "2 Soak Road",
            city: "Lagos",
          },
        ]);
      const CHUNK = 200;
      for (let i = 0; i < opts.invoices; i += CHUNK) {
        const size = Math.min(CHUNK, opts.invoices - i);
        const batch = Array.from({ length: size }, (_, j) => {
          const id = randomUUID();
          const invoiceNumber = `SOAK-${opts.seed}-${i + j}-${salt}`;
          const scenario = pickScenario(random);
          scenarios.set(id, scenario);
          numbers.set(id, invoiceNumber);
          ids.push(id);
          scriptScenario(scenario, invoiceNumber, primary, secondary);
          return { id, invoiceNumber };
        });
        await getDb()
          .insert(invoicesTable)
          .values(
            batch.map(({ id, invoiceNumber }) => ({
              id,
              firmId,
              supplierPartyId: supplierId,
              buyerPartyId: buyerId,
              invoiceNumber,
              issueDate: "2026-08-01",
              dueDate: "2026-08-31",
              status: "submitted" as const,
              subtotal: "100000.00",
              vatTotal: "7500.00",
              grandTotal: "107500.00",
            })),
          );
        await getDb()
          .insert(invoiceLinesTable)
          .values(
            batch.map(({ id }) => ({
              invoiceId: id,
              lineNo: 1,
              description: `Soak ${salt}`,
              quantity: "1.0000",
              unitPrice: "100000.00",
              vatRate: "0.0750",
              lineExtension: "100000.00",
              vatAmount: "7500.00",
            })),
          );
        await getDb()
          .insert(outboxTable)
          .values(
            batch.map(({ id }) => ({
              aggregateType: "invoice",
              aggregateId: id,
              type: "invoice.submit",
              payload: { invoiceId: id },
            })),
          );
      }
    });
    log(`seeded ${opts.invoices} invoices (${salt}); ${opts.workers} workers`);

    // ---- Drive ----
    const deadline = started + opts.deadlineMs;
    const liveCount = async (): Promise<number> =>
      runInBypassContext(async () => {
        const [row] = await getDb()
          .select({ n: sql<number>`count(*)::int` })
          .from(outboxTable)
          .where(
            and(
              inArray(outboxTable.aggregateId, ids),
              inArray(outboxTable.status, ["pending", "processing"]),
            ),
          );
        return Number(row?.n ?? 0);
      });
    // The time machine: a backoff or a park that would wait seconds is made
    // due at once, so the soak exercises retries rather than the clock.
    const rewindDue = async (): Promise<void> =>
      runInBypassContext(async () => {
        await getDb()
          .update(outboxTable)
          .set({ nextAttemptAt: new Date() })
          .where(
            and(
              inArray(outboxTable.aggregateId, ids),
              eq(outboxTable.status, "pending"),
              sql`${outboxTable.nextAttemptAt} > now()`,
            ),
          );
      });
    let settled = false;
    const worker = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const did = await drain(20);
        if (did === 0) {
          if ((await liveCount()) === 0) {
            settled = true;
            return;
          }
          await rewindDue();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    };
    await Promise.all(Array.from({ length: opts.workers }, () => worker()));
    settled = settled || (await liveCount()) === 0;
    const wallMs = Date.now() - started;
    log(`drained in ${wallMs} ms; settled=${settled}`);
    if (!settled)
      violations.push(`did not settle within ${opts.deadlineMs} ms`);

    // ---- Verify ----
    const report = await runInBypassContext(async () => {
      const invoices = await getDb()
        .select({ id: invoicesTable.id, status: invoicesTable.status })
        .from(invoicesTable)
        .where(inArray(invoicesTable.id, ids));
      const stamps = await getDb()
        .select()
        .from(stampRecordsTable)
        .where(inArray(stampRecordsTable.invoiceId, ids));
      const outbox = await getDb()
        .select()
        .from(outboxTable)
        .where(inArray(outboxTable.aggregateId, ids));
      const lifecycle = await getDb()
        .select({
          invoiceId: invoiceLifecycleEventsTable.invoiceId,
          toStatus: invoiceLifecycleEventsTable.toStatus,
        })
        .from(invoiceLifecycleEventsTable)
        .where(inArray(invoiceLifecycleEventsTable.invoiceId, ids));
      const audits = await getDb()
        .select({
          entityId: auditEventsTable.entityId,
          action: auditEventsTable.action,
        })
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.entityType, "invoice"),
            inArray(auditEventsTable.entityId, ids),
          ),
        );
      const attempts = await getDb()
        .select({
          invoiceId: submissionAttemptsTable.invoiceId,
          status: submissionAttemptsTable.status,
          requestPayload: submissionAttemptsTable.requestPayload,
        })
        .from(submissionAttemptsTable)
        .where(inArray(submissionAttemptsTable.invoiceId, ids));
      const cases = await getDb()
        .select({ invoiceId: operatorCasesTable.invoiceId })
        .from(operatorCasesTable)
        .where(inArray(operatorCasesTable.invoiceId, ids));
      const breakers = await getDb().select().from(railStatesTable);

      const stampByInvoice = new Map(stamps.map((s) => [s.invoiceId, s]));
      const byScenario = Object.fromEntries(MIX.map(([s]) => [s, 0])) as Record<
        SoakScenario,
        number
      >;
      const stampedVia: Record<Rail, number> = {
        rail_primary: 0,
        rail_secondary: 0,
      };
      let stamped = 0;
      let failed = 0;
      let recoveredStamps = 0;
      const durations: number[] = [];
      const outboxByInvoice = new Map(
        outbox.map((row) => [row.aggregateId, row]),
      );

      for (const invoice of invoices) {
        const scenario = scenarios.get(invoice.id) ?? "accept";
        byScenario[scenario] += 1;
        const expectFailed = scenario === "reject";
        if (invoice.status === "stamped") stamped += 1;
        else if (invoice.status === "failed") failed += 1;
        else
          violations.push(
            `${scenario}: invoice ${invoice.id} ended ${invoice.status}`,
          );
        if (expectFailed && invoice.status !== "failed") {
          violations.push(
            `${scenario}: invoice ${invoice.id} should have failed, ended ${invoice.status}`,
          );
        }
        if (!expectFailed && invoice.status !== "stamped") {
          violations.push(
            `${scenario}: invoice ${invoice.id} should have stamped, ended ${invoice.status}`,
          );
        }
        const stamp = stampByInvoice.get(invoice.id);
        if (invoice.status === "stamped") {
          if (!stamp)
            violations.push(
              `${scenario}: stamped invoice ${invoice.id} has no stamp record`,
            );
          else {
            stampedVia[stamp.rail] += 1;
            const key = `${invoice.id}:${numbers.get(invoice.id)}`;
            const held = (
              stamp.rail === "rail_primary" ? primary : secondary
            ).held.get(key);
            if (!held)
              violations.push(
                `${scenario}: ${stamp.rail} does not hold key ${key}`,
              );
            else if (held.irn !== stamp.irn || held.csid !== stamp.csid) {
              violations.push(
                `${scenario}: stamp for ${invoice.id} differs from what ${stamp.rail} holds`,
              );
            }
            if (stamp.provider !== "http" || stamp.environment !== "sandbox") {
              violations.push(
                `${scenario}: stamp for ${invoice.id} carries ${stamp.provider}/${stamp.environment}`,
              );
            }
          }
        } else if (stamp) {
          violations.push(
            `${scenario}: ${invoice.status} invoice ${invoice.id} has a stamp record`,
          );
        }
        const transitions = lifecycle.filter((l) => l.invoiceId === invoice.id);
        const terminal = transitions.filter(
          (l) => l.toStatus === "stamped" || l.toStatus === "failed",
        );
        if (terminal.length !== 1) {
          violations.push(
            `${scenario}: invoice ${invoice.id} has ${terminal.length} terminal lifecycle transitions`,
          );
        }
        const actions = audits
          .filter((a) => a.entityId === invoice.id)
          .map((a) => a.action);
        const stampAudits = actions.filter(
          (a) => a === "invoice.stamped" || a === "invoice.stamp_recovered",
        ).length;
        const rejectAudits = actions.filter(
          (a) => a === "invoice.rejected",
        ).length;
        if (invoice.status === "stamped" && stampAudits !== 1) {
          violations.push(
            `${scenario}: invoice ${invoice.id} has ${stampAudits} stamp audit rows`,
          );
        }
        if (invoice.status === "failed" && rejectAudits !== 1) {
          violations.push(
            `${scenario}: invoice ${invoice.id} has ${rejectAudits} rejected audit rows`,
          );
        }
        if (actions.includes("invoice.stamp_recovered")) recoveredStamps += 1;
        const rows = attempts.filter((a) => a.invoiceId === invoice.id);
        const acceptedSubmits = rows.filter(
          (a) =>
            a.status === "accepted" &&
            !(a.requestPayload as { lookup?: boolean })?.lookup,
        ).length;
        if (acceptedSubmits > 1) {
          violations.push(
            `${scenario}: invoice ${invoice.id} has ${acceptedSubmits} accepted submissions`,
          );
        }
        if (rows.length === 0)
          violations.push(
            `${scenario}: invoice ${invoice.id} has no attempt rows`,
          );
        const caseCount = cases.filter(
          (c) => c.invoiceId === invoice.id,
        ).length;
        if (invoice.status === "failed" && caseCount !== 1) {
          violations.push(
            `${scenario}: failed invoice ${invoice.id} has ${caseCount} Desk cases`,
          );
        }
        if (invoice.status === "stamped" && caseCount !== 0) {
          violations.push(
            `${scenario}: stamped invoice ${invoice.id} has a Desk case`,
          );
        }
        const event = outboxByInvoice.get(invoice.id);
        if (!event)
          violations.push(
            `${scenario}: invoice ${invoice.id} has no outbox row`,
          );
        else {
          const expectedOutbox = invoice.status === "failed" ? "dead" : "done";
          if (event.status !== expectedOutbox) {
            violations.push(
              `${scenario}: outbox row for ${invoice.id} is ${event.status}, expected ${expectedOutbox}`,
            );
          }
          if (event.status === "processing" || event.lockedAt) {
            violations.push(
              `${scenario}: outbox row for ${invoice.id} is still claimed`,
            );
          }
          durations.push(event.updatedAt.getTime() - event.createdAt.getTime());
        }
      }
      const extraOutbox = outbox.filter(
        (row) => !invoices.some((i) => i.id === row.aggregateId),
      );
      if (extraOutbox.length > 0)
        violations.push(
          `${extraOutbox.length} outbox rows for unknown invoices`,
        );
      const multiRows = ids.filter(
        (id) => outbox.filter((r) => r.aggregateId === id).length > 1,
      );
      if (multiRows.length > 0)
        violations.push(
          `${multiRows.length} invoices have more than one outbox row`,
        );
      const retries = outbox.reduce(
        (sum, row) => sum + Math.max(0, row.attempts - 1),
        0,
      );
      const parks = outbox.reduce((sum, row) => sum + row.parkCount, 0);

      const breakerReport = {
        rail_primary: { state: "?", failureCount: 0, lastErrorCode: null },
        rail_secondary: { state: "?", failureCount: 0, lastErrorCode: null },
      } as SoakReport["stats"]["breakers"];
      for (const row of breakers) {
        if (row.rail !== "rail_primary" && row.rail !== "rail_secondary")
          continue;
        breakerReport[row.rail] = {
          state: row.state,
          failureCount: row.failureCount,
          lastErrorCode: row.lastErrorCode,
        };
        if (row.state === "half_open") {
          violations.push(
            `${row.rail} ended half_open: a probe slot was never released`,
          );
        }
        if (
          row.state === "closed" &&
          row.failureCount !== 0 &&
          row.failureCount >= 3
        ) {
          violations.push(
            `${row.rail} is closed with failureCount ${row.failureCount}`,
          );
        }
      }

      const sorted = durations.slice().sort((a, b) => a - b);
      return {
        ok: violations.length === 0,
        violations,
        stats: {
          invoices: opts.invoices,
          workers: opts.workers,
          seed: opts.seed,
          wallMs,
          settled,
          stamped,
          failed,
          byScenario,
          retries,
          parks,
          recoveredStamps,
          stampedVia,
          perInvoiceMs: {
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            max: sorted[sorted.length - 1] ?? 0,
          },
          throughputPerSecond:
            wallMs > 0
              ? Math.round((opts.invoices / wallMs) * 1000 * 10) / 10
              : 0,
          breakers: breakerReport,
          railCalls: {
            primary: primary.calls.filter((c) => c.method === "POST").length,
            secondary: secondary.calls.filter((c) => c.method === "POST")
              .length,
          },
        },
      } satisfies SoakReport;
    });
    return report;
  } finally {
    setRailTransport(null);
    for (const key of RAIL_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([primary.close(), secondary.close()]);
  }
}
