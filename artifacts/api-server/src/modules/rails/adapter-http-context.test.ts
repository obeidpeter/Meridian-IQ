import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  getDb,
  pool,
  hasDatabaseContext,
  runHttpDatabaseBoundary,
  finishHttpAuthentication,
} from "@workspace/db";
import { setRailTransport, submitWithFailover } from "./adapter.ts";
import type { CanonicalInvoice } from "../invoice/canonical.ts";

test("breaker reads open and release short scopes under HTTP and background workers, including first-use initialization", async (t) => {
  let exists = false;
  let leased = 0;
  let sends = 0;
  let readFailure = false;
  const commands: string[] = [];
  t.mock.method(pool, "connect", async () => {
    leased++;
    return Object.assign(new EventEmitter(), {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        commands.push(text);
        if (text.includes('from "rail_states"')) {
          if (readFailure) throw new Error("fixture read failed");
          return {
            rows: exists
              ? [
                  [
                    "rail_primary",
                    "closed",
                    0,
                    null,
                    null,
                    null,
                    null,
                    new Date().toISOString(),
                  ],
                ]
              : [],
            rowCount: exists ? 1 : 0,
            fields: [],
          };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      release: () => {
        leased--;
      },
    });
  });
  t.mock.method(pool, "query", async (text: string) => {
    assert.equal(
      leased,
      0,
      "breaker writes remain short autocommit statements",
    );
    if (text.includes("INSERT INTO rail_states")) exists = true;
    else assert.ok(text.includes("UPDATE rail_states"), "unexpected raw query");
    return { rows: [], rowCount: 1 };
  });
  const previous = setRailTransport({
    name: "scope-probe",
    environment: "sandbox",
    rails: ["rail_primary"],
    submit: async (rail) => {
      assert.equal(
        hasDatabaseContext(),
        false,
        "rail I/O has no ambient transaction",
      );
      assert.equal(leased, 0, "rail I/O holds no application connection");
      sends++;
      return {
        status: "accepted",
        rail,
        irn: "fixture",
        csid: "fixture",
        qrPayload: "fixture",
        signedArtifactRef: "fixture",
        raw: {},
      };
    },
    lookup: async () => null,
  });
  const invoice = { invoiceNumber: "SCOPE-PROBE" } as CanonicalInvoice;
  try {
    for (const http of [true, false]) {
      exists = false;
      const invoke = async () => {
        if (http) {
          finishHttpAuthentication();
          assert.throws(() => getDb(), /explicit database context/);
        }
        assert.equal(
          (await submitWithFailover(invoice, "fixture-key")).result.status,
          "accepted",
        );
        if (http) assert.throws(() => getDb(), /explicit database context/);
      };
      await (http ? runHttpDatabaseBoundary(invoke) : invoke());
      assert.equal(leased, 0);
    }
    assert.equal(sends, 2);
    assert.equal(commands.filter((command) => command === "COMMIT").length, 4);
    readFailure = true;
    await assert.rejects(
      runHttpDatabaseBoundary(() => submitWithFailover(invoice, "fixture-key")),
      /Failed query|fixture read failed/,
    );
    assert.equal(commands.at(-1), "ROLLBACK");
    assert.equal(leased, 0);
    assert.equal(sends, 2, "failed preparation never reaches the provider");
  } finally {
    setRailTransport(previous);
  }
});
