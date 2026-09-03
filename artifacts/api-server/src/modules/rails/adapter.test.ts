import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, railStatesTable, type Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical.ts";
import {
  breakerStatus,
  currentRailTransport,
  probeLeaseMs,
  railOpenCooldownMs,
  railTransportSummary,
  recoverExistingStamp,
  setRailTransport,
  submitWithFailover,
  type RailTransport,
  type StampResult,
} from "./adapter.ts";
import { RailLookupError } from "./faults.ts";
import { scriptedRail } from "./transports/scripted.ts";
import { clearRailEnv } from "../../test-helpers/rail-env.ts";

// The rail adapter's transport seam (R97). Pinned:
//  - the simulator is the default transport, deterministic (same invoice →
//    same IRN/CSID) and self-describing (provider "simulator", environment
//    "sandbox"), and its lookup keeps no history (null);
//  - a bound transport replaces the simulator for submit and lookup, and
//    setRailTransport(null) restores it;
//  - a business rejection never fails over (one submit, no second rail);
//  - recoverExistingStamp asks the rail that reported the duplicate FIRST,
//    then the other, and returns null when neither knows the submission;
//  - a lookup a rail could not ANSWER (RailLookupError) counts against that
//    rail's breaker and is re-thrown only when no rail held the stamp (R95).
//
// RAIL_* is cleared for the whole file: with nothing bound the adapter
// resolves from the environment, and a shell exporting RAIL_PRIMARY_URL
// must not turn setRailTransport(null) into a real HTTP dial.

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
}

let restoreRailEnv: () => void = () => {};

before(async () => {
  restoreRailEnv = clearRailEnv();
  await closeBreakers();
});

after(async () => {
  setRailTransport(null);
  restoreRailEnv();
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

test("resolution: the environment lights the HTTP transport, a bound transport wins, null restores env resolution", async () => {
  try {
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
  } finally {
    // The file-level clear/restore brackets the whole run; this test is the
    // one that lights keys, so it puts them out.
    delete process.env.RAIL_PRIMARY_URL;
    delete process.env.RAIL_SECONDARY_URL;
    delete process.env.RAIL_ENVIRONMENT;
    setRailTransport(null);
  }
});

test("a transport that serves one rail: failover never counts the other rail, and one open breaker is a full outage", async () => {
  await closeBreakers();
  const fake = scriptedRail({ name: "single-rail", rails: ["rail_primary"] });
  fake.script(INV.invoiceNumber, { outcome: "unavailable", times: 1 });
  setRailTransport(fake);
  try {
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
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

test("a lookup honours an open breaker but never moves it: the next SUBMIT is the probe", async () => {
  await closeBreakers();
  const fake = scriptedRail({ name: "lookup-probe" });
  setRailTransport(fake);
  try {
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
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

// ---- Lookup errors, sent vs tried, the shared rejection-code sanitiser (R95) ----

test("a lookup error counts against that rail's breaker and is re-thrown only when no rail held the stamp; a hit anywhere wins; three errors open the breaker", async () => {
  await closeBreakers();
  const fake = scriptedRail({ name: "lookup-errors" });
  setRailTransport(fake);
  try {
    const key = `${INV.invoiceNumber}:lookup-errors`;
    // Lookups run rail_primary then rail_secondary (no preferred rail), and a
    // lookup fault is consumed by the first GET — rail_primary's. The
    // secondary's lookup misses (nothing held).
    fake.script(INV.invoiceNumber, { op: "lookup", outcome: "unavailable", times: 1 });
    await assert.rejects(
      recoverExistingStamp(INV, key),
      (err: unknown) => {
        assert.ok(err instanceof RailLookupError, "a RailLookupError, not a plain throw");
        assert.equal(err.code, "RAIL_UNAVAILABLE");
        assert.equal(err.rail, "rail_primary");
        return true;
      },
    );
    assert.deepEqual(
      fake.calls.map((c) => `${c.op}:${c.rail}:${c.outcome}`),
      ["lookup:rail_primary:unavailable", "lookup:rail_secondary:lookup_miss"],
      "the miss on rail_secondary did not turn the error into a null",
    );
    assert.equal((await breakerStatus("rail_primary")).failureCount, 1, "the unanswered lookup counted");
    assert.equal((await breakerStatus("rail_secondary")).failureCount, 0, "a miss is an answer, not a failure");

    // The stamp IS held (on the fake, any rail's GET finds it): primary
    // still cannot answer, secondary hits — a hit anywhere wins.
    fake.hold(INV.invoiceNumber);
    fake.script(INV.invoiceNumber, { op: "lookup", outcome: "unavailable", times: 1 });
    const found = await recoverExistingStamp(INV, key);
    assert.equal(found?.status, "accepted");
    assert.equal(found?.rail, "rail_secondary");
    assert.match(found?.irn ?? "", /^IRN-[0-9A-F]{16}$/);
    assert.equal((await breakerStatus("rail_primary")).failureCount, 2);
    assert.deepEqual([(await breakerStatus("rail_secondary")).state, (await breakerStatus("rail_secondary")).failureCount], ["closed", 0]);

    // The third unanswered lookup opens rail_primary's breaker; the hit on
    // rail_secondary still answers.
    fake.script(INV.invoiceNumber, { op: "lookup", outcome: "unavailable", times: 1 });
    assert.equal((await recoverExistingStamp(INV, key))?.rail, "rail_secondary");
    const primary = await breakerStatus("rail_primary");
    assert.equal(primary.state, "open", "three lookup errors open the breaker");
    assert.equal(primary.failureCount, 3);
    assert.ok(primary.openedAt && primary.retryAt);

    // While open, rail_primary is not even asked.
    const before = fake.calls.length;
    assert.equal((await recoverExistingStamp(INV, key))?.rail, "rail_secondary");
    assert.deepEqual(
      fake.calls.slice(before).map((c) => `${c.op}:${c.rail}:${c.outcome}`),
      ["lookup:rail_secondary:lookup_hit"],
    );
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

test("submitWithFailover reports the rails SENT apart from the rails TRIED: a breaker refusal is tried, never sent", async () => {
  await closeBreakers();
  const fake = scriptedRail({ name: "sent-vs-tried" });
  setRailTransport(fake);
  try {
    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount: 3, openedAt: new Date(Date.now() - 10_000), retryAt: new Date(Date.now() + 60_000) })
      .where(eq(railStatesTable.rail, "rail_primary"));
    const key = `${INV.invoiceNumber}:sent-vs-tried`;
    const { result, tried, sent, circuitOpen } = await submitWithFailover(INV, key);
    assert.equal(result.status, "accepted");
    assert.equal(circuitOpen, false, "one refusal is not a full outage");
    assert.equal(tried.length, 2, "both rails were considered");
    assert.deepEqual(tried[0]?.raw, { circuit: "open" }, "the refusal is on the tried list");
    assert.equal(tried[0]?.rail, "rail_primary");
    assert.equal(sent.length, 1, "only the rail actually called is on the sent list");
    assert.equal(sent[0]?.rail, "rail_secondary");
    assert.equal(sent[0], result, "the accepted result is the one sent");
    assert.deepEqual(
      fake.calls.map((c) => c.rail),
      ["rail_secondary"],
    );
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

test("the scripted fake runs a scripted rejection code through the shared sanitiser: garbage falls back to MBS_SCHEMA_INVALID, a wire-shaped code passes", async () => {
  await closeBreakers();
  const fake = scriptedRail({ name: "sanitised" });
  setRailTransport(fake);
  try {
    const key = `${INV.invoiceNumber}:sanitised`;
    fake.script(INV.invoiceNumber, { outcome: "reject", code: "not a code!", times: 1 });
    const garbage = await submitWithFailover(INV, key);
    assert.equal(garbage.result.status, "rejected");
    assert.equal(garbage.result.errorCode, "MBS_SCHEMA_INVALID", "spaces and punctuation the wire never carries");
    assert.equal(garbage.result.raw.code, "MBS_SCHEMA_INVALID", "raw carries the sanitised code, not the script's");

    fake.script(INV.invoiceNumber, { outcome: "reject", code: "E-1001", times: 1 });
    const wire = await submitWithFailover(INV, key);
    assert.equal(wire.result.status, "rejected");
    assert.equal(wire.result.errorCode, "E-1001", "an access point's own reference passes through");
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

// ---- Probe slot and raw-pool bookkeeping (R102) ----

test("probe slot: two workers on a due-open breaker — exactly one probes, the other is refused until the lease ends", async () => {
  await closeBreakers();
  await getDb()
    .update(railStatesTable)
    .set({
      state: "open",
      failureCount: 3,
      openedAt: new Date(Date.now() - 60_000),
      retryAt: new Date(Date.now() - 1_000),
      probeStartedAt: null,
    })
    .where(eq(railStatesTable.rail, "rail_primary"));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = scriptedRail({ name: "slow-probe", rails: ["rail_primary"] });
  const slow: RailTransport = {
    name: "slow-probe",
    environment: "sandbox",
    rails: ["rail_primary"],
    async submit(rail, inv, key) {
      await gate;
      return inner.submit(rail, inv, key);
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(slow);
  try {
    const key = `${INV.invoiceNumber}:probe-slot`;
    const first = submitWithFailover(INV, key);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const during = await breakerStatus("rail_primary");
    assert.equal(during.state, "half_open", "the first worker holds the probe slot");
    assert.ok(during.probeStartedAt instanceof Date);

    const second = await submitWithFailover(INV, `${key}-2`);
    assert.equal(second.circuitOpen, true, "the second worker is refused while the probe is in flight");
    assert.ok(second.retryAfter && second.retryAfter.getTime() > Date.now(), "and told when the lease ends");
    assert.equal(inner.calls.length, 0, "the refused worker sent nothing");

    release();
    const done = await first;
    assert.equal(done.result.status, "accepted");
    const after = await breakerStatus("rail_primary");
    assert.equal(after.state, "closed");
    assert.equal(after.failureCount, 0);
    assert.equal(after.probeStartedAt, null);
    assert.equal(after.lastErrorCode, null);
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

test("probe slot: a probe that died with the slot is taken over once its lease passes; a failed probe records its code and re-arms", async () => {
  await closeBreakers();
  await getDb()
    .update(railStatesTable)
    .set({
      state: "half_open",
      failureCount: 3,
      openedAt: new Date(Date.now() - 120_000),
      retryAt: new Date(Date.now() - 60_000),
      probeStartedAt: new Date(Date.now() - probeLeaseMs() - 1_000),
    })
    .where(eq(railStatesTable.rail, "rail_primary"));
  const fake = scriptedRail({ name: "takeover", rails: ["rail_primary"] });
  fake.script(INV.invoiceNumber, { outcome: "unauthorized", times: 1 });
  setRailTransport(fake);
  try {
    const key = `${INV.invoiceNumber}:takeover`;
    const probe = await submitWithFailover(INV, key);
    assert.equal(probe.circuitOpen, false, "the stale slot was taken over");
    assert.equal(probe.result.errorCode, "RAIL_UNAUTHORIZED");
    const after = await breakerStatus("rail_primary");
    assert.equal(after.state, "open");
    assert.equal(after.failureCount, 4);
    assert.equal(after.lastErrorCode, "RAIL_UNAUTHORIZED");
    assert.equal(after.probeStartedAt, null, "the slot is released with the verdict");
    assert.ok(after.retryAt && after.retryAt.getTime() > Date.now(), "retry-at re-armed");
    assert.ok(
      after.openedAt && after.openedAt.getTime() < Date.now() - 100_000,
      "the outage instance is kept",
    );

    await getDb()
      .update(railStatesTable)
      .set({ state: "half_open", probeStartedAt: new Date() })
      .where(eq(railStatesTable.rail, "rail_primary"));
    const refused = await submitWithFailover(INV, `${key}-2`);
    assert.equal(refused.circuitOpen, true, "a live lease is honoured");
    assert.equal(fake.calls.length, 1);
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});

test("recovery: when every served rail refuses the lookup, nobody was asked — a retry, never a miss", async () => {
  await closeBreakers();
  for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
    await getDb()
      .update(railStatesTable)
      .set({ state: "open", failureCount: 3, openedAt: new Date(), retryAt: new Date(Date.now() + 60_000) })
      .where(eq(railStatesTable.rail, rail));
  }
  const fake = scriptedRail({ name: "all-refused" });
  fake.hold(INV.invoiceNumber);
  setRailTransport(fake);
  try {
    await assert.rejects(
      recoverExistingStamp(INV, `${INV.invoiceNumber}:refused`),
      (err: unknown) => err instanceof RailLookupError && err.code === "RAIL_UNAVAILABLE",
    );
    assert.equal(fake.calls.length, 0, "no rail was asked");
  } finally {
    setRailTransport(null);
    await closeBreakers();
  }
});
