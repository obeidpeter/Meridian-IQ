import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  auditEventsTable,
  invoiceLifecycleEventsTable,
  invoicesTable,
  operatorCasesTable,
  outboxTable,
  railStatesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  type OutboxEvent,
  type Rail,
  type StampRecord,
} from "@workspace/db";
import type { FakeRail } from "../rails/fake-rail";
import { MIX, type SoakScenario } from "./soak-scenarios";

// The rail soak's Verify phase (R126, split from soak.ts): after the drive
// settles, every invariant the platform promises is checked per invoice, in
// the original order, pushing into the SAME violations array the drive
// phase already holds (an unsettled soak's violation must survive into
// `ok`). The seven selects run inside one bypass context exactly as before.

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

export interface SoakVerifyInput {
  opts: { invoices: number; workers: number; seed: number };
  ids: string[];
  scenarios: Map<string, SoakScenario>;
  numbers: Map<string, string>;
  primary: FakeRail;
  secondary: FakeRail;
  violations: string[];
  wallMs: number;
  settled: boolean;
}

type SoakInvoice = { id: string; status: string };
type RailStateRow = typeof railStatesTable.$inferSelect;

// The evidence the per-invoice checks read and the tallies they mutate IN
// PLACE (the loop's former closure variables): violations is the shared
// array, tally/stampedVia/durations accumulate across invoices.
interface SoakEvidence {
  violations: string[];
  numbers: Map<string, string>;
  primary: FakeRail;
  secondary: FakeRail;
  stampByInvoice: Map<string, StampRecord>;
  lifecycle: { invoiceId: string | null; toStatus: string }[];
  audits: { entityId: string | null; action: string }[];
  attempts: {
    invoiceId: string | null;
    status: string;
    requestPayload: unknown;
  }[];
  cases: { invoiceId: string | null }[];
  outboxByInvoice: Map<string, OutboxEvent>;
  durations: number[];
  stampedVia: Record<Rail, number>;
  tally: { stamped: number; failed: number; recoveredStamps: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

// Every soak invoice ends stamped or failed, failed ONLY when the rail
// rejected it; nothing is left pending, processing or half-done.
function checkOutcome(
  bag: SoakEvidence,
  invoice: SoakInvoice,
  scenario: SoakScenario,
): void {
  const expectFailed = scenario === "reject";
  if (invoice.status === "stamped") bag.tally.stamped += 1;
  else if (invoice.status === "failed") bag.tally.failed += 1;
  else
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} ended ${invoice.status}`,
    );
  if (expectFailed && invoice.status !== "failed") {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} should have failed, ended ${invoice.status}`,
    );
  }
  if (!expectFailed && invoice.status !== "stamped") {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} should have stamped, ended ${invoice.status}`,
    );
  }
}

// Exactly one stamp per stamped invoice, and its IRN is the one the
// stamping rail actually holds for that idempotency key.
function checkStamp(
  bag: SoakEvidence,
  invoice: SoakInvoice,
  scenario: SoakScenario,
): void {
  const stamp = bag.stampByInvoice.get(invoice.id);
  if (invoice.status === "stamped") {
    if (!stamp)
      bag.violations.push(
        `${scenario}: stamped invoice ${invoice.id} has no stamp record`,
      );
    else {
      bag.stampedVia[stamp.rail] += 1;
      const key = `${invoice.id}:${bag.numbers.get(invoice.id)}`;
      const held = (
        stamp.rail === "rail_primary" ? bag.primary : bag.secondary
      ).held.get(key);
      if (!held)
        bag.violations.push(
          `${scenario}: ${stamp.rail} does not hold key ${key}`,
        );
      else if (held.irn !== stamp.irn || held.csid !== stamp.csid) {
        bag.violations.push(
          `${scenario}: stamp for ${invoice.id} differs from what ${stamp.rail} holds`,
        );
      }
      if (stamp.provider !== "http" || stamp.environment !== "sandbox") {
        bag.violations.push(
          `${scenario}: stamp for ${invoice.id} carries ${stamp.provider}/${stamp.environment}`,
        );
      }
    }
  } else if (stamp) {
    bag.violations.push(
      `${scenario}: ${invoice.status} invoice ${invoice.id} has a stamp record`,
    );
  }
}

// Exactly one lifecycle transition and exactly one stamped/recovered (or
// rejected) audit row per invoice; at most one accepted submission; a Desk
// case for every rejection and for nothing else.
function checkEvidence(
  bag: SoakEvidence,
  invoice: SoakInvoice,
  scenario: SoakScenario,
): void {
  const transitions = bag.lifecycle.filter((l) => l.invoiceId === invoice.id);
  const terminal = transitions.filter(
    (l) => l.toStatus === "stamped" || l.toStatus === "failed",
  );
  if (terminal.length !== 1) {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} has ${terminal.length} terminal lifecycle transitions`,
    );
  }
  const actions = bag.audits
    .filter((a) => a.entityId === invoice.id)
    .map((a) => a.action);
  const stampAudits = actions.filter(
    (a) => a === "invoice.stamped" || a === "invoice.stamp_recovered",
  ).length;
  const rejectAudits = actions.filter((a) => a === "invoice.rejected").length;
  if (invoice.status === "stamped" && stampAudits !== 1) {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} has ${stampAudits} stamp audit rows`,
    );
  }
  if (invoice.status === "failed" && rejectAudits !== 1) {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} has ${rejectAudits} rejected audit rows`,
    );
  }
  if (actions.includes("invoice.stamp_recovered"))
    bag.tally.recoveredStamps += 1;
  const rows = bag.attempts.filter((a) => a.invoiceId === invoice.id);
  const acceptedSubmits = rows.filter(
    (a) =>
      a.status === "accepted" &&
      !(a.requestPayload as { lookup?: boolean })?.lookup,
  ).length;
  if (acceptedSubmits > 1) {
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} has ${acceptedSubmits} accepted submissions`,
    );
  }
  if (rows.length === 0)
    bag.violations.push(
      `${scenario}: invoice ${invoice.id} has no attempt rows`,
    );
  const caseCount = bag.cases.filter((c) => c.invoiceId === invoice.id).length;
  if (invoice.status === "failed" && caseCount !== 1) {
    bag.violations.push(
      `${scenario}: failed invoice ${invoice.id} has ${caseCount} Desk cases`,
    );
  }
  if (invoice.status === "stamped" && caseCount !== 0) {
    bag.violations.push(
      `${scenario}: stamped invoice ${invoice.id} has a Desk case`,
    );
  }
}

// The outbox row ends done (or dead for a rejection), released, and its
// lifetime feeds the per-invoice latency percentiles.
function checkOutbox(
  bag: SoakEvidence,
  invoice: SoakInvoice,
  scenario: SoakScenario,
): void {
  const event = bag.outboxByInvoice.get(invoice.id);
  if (!event)
    bag.violations.push(`${scenario}: invoice ${invoice.id} has no outbox row`);
  else {
    const expectedOutbox = invoice.status === "failed" ? "dead" : "done";
    if (event.status !== expectedOutbox) {
      bag.violations.push(
        `${scenario}: outbox row for ${invoice.id} is ${event.status}, expected ${expectedOutbox}`,
      );
    }
    if (event.status === "processing" || event.lockedAt) {
      bag.violations.push(
        `${scenario}: outbox row for ${invoice.id} is still claimed`,
      );
    }
    bag.durations.push(event.updatedAt.getTime() - event.createdAt.getTime());
  }
}

// No outbox rows for unknown invoices, and exactly one per soak invoice.
function checkOutboxPopulation(
  bag: SoakEvidence,
  outbox: OutboxEvent[],
  ids: string[],
  invoices: SoakInvoice[],
): void {
  const extraOutbox = outbox.filter(
    (row) => !invoices.some((i) => i.id === row.aggregateId),
  );
  if (extraOutbox.length > 0)
    bag.violations.push(
      `${extraOutbox.length} outbox rows for unknown invoices`,
    );
  const multiRows = ids.filter(
    (id) => outbox.filter((r) => r.aggregateId === id).length > 1,
  );
  if (multiRows.length > 0)
    bag.violations.push(
      `${multiRows.length} invoices have more than one outbox row`,
    );
}

// The breakers end in a coherent state: never a stale half-open probe, never
// closed while still counting failures.
function summarizeBreakers(
  bag: SoakEvidence,
  breakers: RailStateRow[],
): SoakReport["stats"]["breakers"] {
  const breakerReport = {
    rail_primary: { state: "?", failureCount: 0, lastErrorCode: null },
    rail_secondary: { state: "?", failureCount: 0, lastErrorCode: null },
  } as SoakReport["stats"]["breakers"];
  for (const row of breakers) {
    if (row.rail !== "rail_primary" && row.rail !== "rail_secondary") continue;
    breakerReport[row.rail] = {
      state: row.state,
      failureCount: row.failureCount,
      lastErrorCode: row.lastErrorCode,
    };
    if (row.state === "half_open") {
      bag.violations.push(
        `${row.rail} ended half_open: a probe slot was never released`,
      );
    }
    if (
      row.state === "closed" &&
      row.failureCount !== 0 &&
      row.failureCount >= 3
    ) {
      bag.violations.push(
        `${row.rail} is closed with failureCount ${row.failureCount}`,
      );
    }
  }
  return breakerReport;
}

export async function verifySoak(input: SoakVerifyInput): Promise<SoakReport> {
  const {
    opts,
    ids,
    scenarios,
    numbers,
    primary,
    secondary,
    violations,
    wallMs,
    settled,
  } = input;
  return runInBypassContext(async () => {
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
    const outboxByInvoice = new Map(
      outbox.map((row) => [row.aggregateId, row]),
    );
    const bag: SoakEvidence = {
      violations,
      numbers,
      primary,
      secondary,
      stampByInvoice,
      lifecycle,
      audits,
      attempts,
      cases,
      outboxByInvoice,
      durations: [],
      stampedVia: { rail_primary: 0, rail_secondary: 0 },
      tally: { stamped: 0, failed: 0, recoveredStamps: 0 },
    };

    for (const invoice of invoices) {
      const scenario = scenarios.get(invoice.id) ?? "accept";
      byScenario[scenario] += 1;
      checkOutcome(bag, invoice, scenario);
      checkStamp(bag, invoice, scenario);
      checkEvidence(bag, invoice, scenario);
      checkOutbox(bag, invoice, scenario);
    }
    checkOutboxPopulation(bag, outbox, ids, invoices);
    const retries = outbox.reduce(
      (sum, row) => sum + Math.max(0, row.attempts - 1),
      0,
    );
    const parks = outbox.reduce((sum, row) => sum + row.parkCount, 0);

    const breakerReport = summarizeBreakers(bag, breakers);

    const sorted = bag.durations.slice().sort((a, b) => a - b);
    return {
      ok: violations.length === 0,
      violations,
      stats: {
        invoices: opts.invoices,
        workers: opts.workers,
        seed: opts.seed,
        wallMs,
        settled,
        stamped: bag.tally.stamped,
        failed: bag.tally.failed,
        byScenario,
        retries,
        parks,
        recoveredStamps: bag.tally.recoveredStamps,
        stampedVia: bag.stampedVia,
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
          secondary: secondary.calls.filter((c) => c.method === "POST").length,
        },
      },
    } satisfies SoakReport;
  });
}
