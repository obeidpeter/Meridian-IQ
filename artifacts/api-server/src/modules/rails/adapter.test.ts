import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, railStatesTable, type Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical.ts";
import {
  currentRailTransport,
  recoverExistingStamp,
  setRailTransport,
  submitWithFailover,
  type RailTransport,
  type StampResult,
} from "./adapter.ts";

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
      .set({ state: "closed", failureCount: 0, openedAt: null })
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
