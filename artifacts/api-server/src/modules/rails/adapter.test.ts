import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, railStatesTable, type Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical.ts";
import {
  breakerStatus,
  currentRailTransport,
  railOpenCooldownMs,
  railTransportSummary,
  recoverExistingStamp,
  setRailTransport,
  submitWithFailover,
  type RailTransport,
  type StampResult,
} from "./adapter.ts";
import { scriptedRail } from "./transports/scripted.ts";

// The rail adapter's transport seam (R97). Pinned:
//  - the simulator is the default transport, deterministic (same invoice →
//    same IRN/CSID) and self-describing (provider "simulator", environment
//    "sandbox"), and its lookup keeps no history (null);
//  - a bound transport replaces the simulator for submit and lookup, and
//    setRailTransport(null) restores it;
//  - a business rejection never fails over (one submit, no second rail);
//  - recoverExistingStamp asks the rail that reported the duplicate FIRST,
//    then the other, and returns null when neither knows the submission.

const party = (tin: string): CanonicalInvoice["supplier"] => ({
  legalName: `Party ${tin}`,
  tin,
  cacNumber: null,
  street: "1 Broad Street",
  city: "Lagos",
  countryCode: "NG",
});

const INV: CanonicalInvoice = {
  invoiceNumber: `INV-ADAPTER-${randomUUID().slice(0, 8)}`,
  issueDate: "2026-08-01",
  dueDate: "2026-08-31",
  invoiceTypeCode: "380",
  currencyCode: "NGN",
  supplier: party("1234567890"),
  buyer: party("0987654321"),
  lines: [
    {
      id: "l1",
      description: "Consulting",
      quantity: "1",
      unitCode: "EA",
      unitPrice: "100000.00",
      vatRate: "0.075",
      lineExtension: "100000.00",
      vatAmount: "7500.00",
    },
  ],
  lineExtensionAmount: "100000.00",
  taxExclusiveAmount: "100000.00",
  taxAmount: "7500.00",
  taxInclusiveAmount: "107500.00",
  payableAmount: "107500.00",
};

async function closeBreakers(): Promise<void> {
  for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
    await getDb()
      .update(railStatesTable)
      .set({ state: "closed", failureCount: 0, openedAt: null, retryAt: null })
      .where(eq(railStatesTable.rail, rail));
  }
}

before(async () => {
  await closeBreakers();
});

after(async () => {
  setRailTransport(null);
  await closeBreakers();
});

test("the simulator is the default: deterministic, self-describing, no history", async () => {
  setRailTransport(null);
  assert.equal(currentRailTransport().name, "simulator");
  const key = `${randomUUID()}:${INV.invoiceNumber}`;
  const a = await submitWithFailover(INV, key);
  const b = await submitWithFailover(INV, key);
  assert.equal(a.result.status, "accepted");
  assert.equal(a.result.irn, b.result.irn);
  assert.equal(a.result.csid, b.result.csid);
  assert.equal(a.result.provider, "simulator");
  assert.equal(a.result.environment, "sandbox");
  assert.equal(await recoverExistingStamp(INV, key), null);
});

test("a bound transport answers submit and lookup; null restores the simulator", async () => {
  const calls: string[] = [];
  const fake: RailTransport = {
    name: "fake-rail",
    environment: "live",
    async submit(rail) {
      calls.push(`submit:${rail}`);
      return {
        status: "rejected",
        rail,
        errorCode: "MBS_DUPLICATE",
        raw: { code: "MBS_DUPLICATE" },
        provider: "fake-rail",
        environment: "live",
      };
    },
    async lookup(rail): Promise<StampResult | null> {
      calls.push(`lookup:${rail}`);
      if (rail !== "rail_secondary") return null;
      return {
        status: "accepted",
        rail,
        irn: "IRN-FAKE",
        csid: "csid-fake",
        qrPayload: "qr",
        signedArtifactRef: "sig",
        raw: { lookedUp: true },
        provider: "fake-rail",
        environment: "live",
      };
    },
  };
  const previous = setRailTransport(fake);
  assert.equal(previous.name, "simulator");
  try {
    const key = `${randomUUID()}:${INV.invoiceNumber}`;
    const { result, tried } = await submitWithFailover(INV, key);
    // A business rejection is terminal: one rail tried, no failover.
    assert.equal(result.status, "rejected");
    assert.equal(result.errorCode, "MBS_DUPLICATE");
    assert.equal(tried.length, 1);
    assert.deepEqual(calls, ["submit:rail_primary"]);

    // Recovery asks the reporting rail first, then the other one.
    calls.length = 0;
    const found = await recoverExistingStamp(INV, key, "rail_primary");
    assert.equal(found?.irn, "IRN-FAKE");
    assert.equal(found?.environment, "live");
    assert.deepEqual(calls, ["lookup:rail_primary", "lookup:rail_secondary"]);

    // Preferring the rail that holds it makes the first lookup the hit.
    calls.length = 0;
    await recoverExistingStamp(INV, key, "rail_secondary");
    assert.deepEqual(calls, ["lookup:rail_secondary"]);
  } finally {
    setRailTransport(null);
  }
  assert.equal(currentRailTransport().name, "simulator");
});

test("recovery returns null when no rail knows the submission", async () => {
  setRailTransport({
    name: "amnesiac",
    environment: "live",
    async submit(rail) {
      return { status: "accepted", rail, raw: {} };
    },
    async lookup() {
      return null;
    },
  });
  try {
    assert.equal(await recoverExistingStamp(INV, "k", "rail_primary"), null);
  } finally {
    setRailTransport(null);
  }
});

// ---------------------------------------------------------------------------
// The breaker under an outage (R96)
// ---------------------------------------------------------------------------

test("the breaker opens after three transient errors, keeps its outage start across a failed probe, and re-arms retry-at", async () => {
  await closeBreakers();
  const calls: string[] = [];
  const failing: RailTransport = {
    name: "failing",
    environment: "sandbox",
    async submit(rail) {
      calls.push(rail);
      return { status: "error", rail, errorCode: "RAIL_TIMEOUT", raw: {} };
    },
    async lookup() {
      return null;
    },
  };
  setRailTransport(failing);
  try {
    // Each call fails over primary → secondary: two failures per rail per call.
    await submitWithFailover(INV, "k-1");
    await submitWithFailover(INV, "k-2");
    assert.equal((await breakerStatus("rail_primary")).state, "closed", "two failures stay under the threshold");
    const opened = await submitWithFailover(INV, "k-3");
    assert.equal(opened.circuitOpen, false, "the third call still reached the rails before they tripped");
    const primary = await breakerStatus("rail_primary");
    assert.equal(primary.state, "open");
    assert.ok(primary.openedAt, "the outage instance is stamped");
    assert.ok(primary.retryAt && primary.retryAt.getTime() > Date.now(), "a retry-at is armed");
    assert.ok(primary.retryAt!.getTime() <= Date.now() + railOpenCooldownMs() + 1_000);

    // Every breaker open: refused without a call, with the earliest retry-at.
    const before = calls.length;
    const refused = await submitWithFailover(INV, "k-4");
    assert.equal(refused.circuitOpen, true);
    assert.equal(refused.result.errorCode, "RAIL_UNAVAILABLE");
    assert.deepEqual(refused.tried.map((t) => t.raw.circuit), ["open", "open"]);
    assert.equal(refused.retryAfter?.getTime(), primary.retryAt?.getTime());
    assert.equal(calls.length, before, "no rail was called while refused");

    // Retry-at reached: one probe goes through, fails, and the outage start
    // stays put while retry-at moves forward.
    const probeAt = new Date(Date.now() - 1_000);
    for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
      await getDb().update(railStatesTable).set({ retryAt: probeAt }).where(eq(railStatesTable.rail, rail));
    }
    const probed = await submitWithFailover(INV, "k-5");
    assert.equal(probed.circuitOpen, false, "the probe was sent");
    assert.equal(calls.length, before + 2);
    const after = await breakerStatus("rail_primary");
    assert.equal(after.state, "open");
    assert.equal(after.openedAt?.getTime(), primary.openedAt?.getTime(), "same outage instance");
    assert.ok(after.retryAt!.getTime() > probeAt.getTime(), "retry-at re-armed");

    // A successful probe closes the breaker and clears both clocks.
    setRailTransport(null);
    for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
      await getDb().update(railStatesTable).set({ retryAt: probeAt }).where(eq(railStatesTable.rail, rail));
    }
    const recovered = await submitWithFailover(INV, "k-6");
    assert.equal(recovered.result.status, "accepted");
    const closed = await breakerStatus("rail_primary");
    assert.deepEqual([closed.state, closed.failureCount, closed.openedAt, closed.retryAt], ["closed", 0, null, null]);
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

// ---- Transport resolution (R95) ----

const RAIL_ENV_KEYS = [
  "RAIL_PRIMARY_URL",
  "RAIL_SECONDARY_URL",
  "RAIL_PRIMARY_TOKEN",
  "RAIL_SECONDARY_TOKEN",
  "RAIL_ENVIRONMENT",
] as const;

function withRailEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(RAIL_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of RAIL_ENV_KEYS) delete process.env[k];
  return fn().finally(() => {
    for (const k of RAIL_ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setRailTransport(null);
  });
}

test("resolution: the environment lights the HTTP transport, a bound transport wins, null restores env resolution", async () =>
  withRailEnv(async () => {
    assert.equal(currentRailTransport().name, "simulator");
    assert.deepEqual(railTransportSummary(), {
      transport: "simulator",
      environment: "sandbox",
      rails: { rail_primary: { configured: true }, rail_secondary: { configured: true } },
    });

    process.env.RAIL_PRIMARY_URL = "http://127.0.0.1:9/";
    process.env.RAIL_ENVIRONMENT = "live";
    const http = currentRailTransport();
    assert.equal(http.name, "http");
    assert.equal(http.environment, "live");
    assert.deepEqual(http.rails, ["rail_primary"]);
    assert.equal(currentRailTransport(), http, "memoised while the env tuple is unchanged");
    assert.deepEqual(railTransportSummary(), {
      transport: "http",
      environment: "live",
      rails: { rail_primary: { configured: true }, rail_secondary: { configured: false } },
    });

    process.env.RAIL_SECONDARY_URL = "http://127.0.0.1:9";
    const rebuilt = currentRailTransport();
    assert.notEqual(rebuilt, http, "a changed env tuple rebuilds the transport");
    assert.deepEqual(rebuilt.rails, ["rail_primary", "rail_secondary"]);

    const fake = scriptedRail({ name: "bound-fake" });
    const previous = setRailTransport(fake);
    assert.equal(previous, rebuilt, "setRailTransport hands back what resolution would have used");
    assert.equal(currentRailTransport().name, "bound-fake");
    assert.equal(railTransportSummary().transport, "bound-fake");

    setRailTransport(null);
    assert.equal(currentRailTransport().name, "http", "null restores ENV resolution, not the simulator");
    delete process.env.RAIL_PRIMARY_URL;
    delete process.env.RAIL_SECONDARY_URL;
    assert.equal(currentRailTransport().name, "simulator");
  }));

test("a transport that serves one rail: failover never counts the other rail, and one open breaker is a full outage", async () =>
  withRailEnv(async () => {
    await closeBreakers();
    const fake = scriptedRail({ name: "single-rail", rails: ["rail_primary"] });
    fake.script(INV.invoiceNumber, { outcome: "unavailable", times: 1 });
    setRailTransport(fake);
    const key = `${INV.invoiceNumber}:single`;
    const first = await submitWithFailover(INV, key);
    assert.equal(first.result.status, "error");
    assert.equal(first.result.errorCode, "RAIL_UNAVAILABLE");
    assert.equal(first.tried.length, 1, "rail_secondary is not served, so it was never tried");
    assert.equal(first.circuitOpen, false);
    assert.deepEqual(
      fake.calls.map((c) => c.rail),
      ["rail_primary"],
    );

    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount: 3, openedAt: new Date(), retryAt: new Date(Date.now() + 60_000) })
      .where(eq(railStatesTable.rail, "rail_primary"));
    const parked = await submitWithFailover(INV, key);
    assert.equal(parked.circuitOpen, true, "the only served rail refused, so every breaker is open");
    assert.ok(parked.retryAfter instanceof Date);
    assert.equal(fake.calls.length, 1, "nothing was sent while parked");
    await closeBreakers();
  }));

test("a lookup honours an open breaker but never moves it: the next SUBMIT is the probe", async () =>
  withRailEnv(async () => {
    await closeBreakers();
    const fake = scriptedRail({ name: "lookup-probe" });
    setRailTransport(fake);
    const key = `${INV.invoiceNumber}:lookup-probe`;
    // rail_primary: open but DUE (retry-at passed); rail_secondary: open and not due.
    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount: 3, openedAt: new Date(Date.now() - 60_000), retryAt: new Date(Date.now() - 1_000) })
      .where(eq(railStatesTable.rail, "rail_primary"));
    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount: 3, openedAt: new Date(), retryAt: new Date(Date.now() + 60_000) })
      .where(eq(railStatesTable.rail, "rail_secondary"));

    assert.equal(await recoverExistingStamp(INV, key), null);
    assert.deepEqual(
      fake.calls.map((c) => `${c.op}:${c.rail}`),
      ["lookup:rail_primary"],
      "the due rail was asked; the refused one was not",
    );
    assert.equal((await breakerStatus("rail_primary")).state, "open", "a null lookup leaves the breaker where it was");

    const probe = await submitWithFailover(INV, key);
    assert.equal(probe.result.status, "accepted");
    assert.equal(probe.tried.length, 1, "rail_primary took the probe; rail_secondary stayed refused");
    assert.equal((await breakerStatus("rail_primary")).state, "closed", "the submit was the probe and it closed the breaker");
    await closeBreakers();
  }));
