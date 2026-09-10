import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  firmsTable,
  invoiceLinesTable,
  invoicesTable,
  outboxTable,
  partiesTable,
  railStatesTable,
  type Rail,
} from "@workspace/db";
import { setRailTransport } from "../rails/adapter";
import { startFakeRail } from "../rails/fake-rail";
import { drain, resumeWorker } from "./pipeline";
import {
  pickScenario,
  prng,
  scriptScenario,
  type SoakScenario,
} from "./soak-scenarios";
import { verifySoak, type SoakReport } from "./soak-verify";

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
//
// R126: the scenario catalogue (seeded PRNG, fault mix, rail scripting)
// lives in soak-scenarios.ts and the Verify phase in soak-verify.ts; this
// file keeps the options, the env save/restore, the fake-rail startup and
// the Seed and Drive phases.

export type { SoakScenario } from "./soak-scenarios";
export type { SoakReport } from "./soak-verify";

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
    const report = await verifySoak({
      opts,
      ids,
      scenarios,
      numbers,
      primary,
      secondary,
      violations,
      wallMs,
      settled,
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
