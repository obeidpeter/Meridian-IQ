import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import {
  pool,
  runHttpDatabaseBoundary,
  finishHttpAuthentication,
  runRequestContext,
} from "@workspace/db";
import { fanOutAlert } from "../messaging/fan-out.ts";
import { suggestNarrationMatches } from "./narration-match.ts";
import type { ClerkGateway } from "./gateway.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

const _connectClient = () => pool.connect();
type PoolClient = Awaited<ReturnType<typeof _connectClient>>;
const firm = "11111111-1111-4111-8111-111111111111";
const otherFirm = "22222222-2222-4222-8222-222222222222";
const party = "33333333-3333-4333-8333-333333333333";

// Only transport is fake. Returning no visible rows models the RLS result;
// real PostgreSQL policy/engagement enforcement remains covered in the DB tests.
function hiddenRows(t: TestContext, table: string) {
  const calls: { text: string; params: unknown[] }[] = [];
  let leased = false;
  const client = Object.assign(new EventEmitter(), {
    query: async (
      config: string | { text: string },
      params: unknown[] = [],
    ) => {
      assert.equal(leased, true);
      const text = typeof config === "string" ? config : config.text;
      calls.push({ text, params });
      if (
        ![
          "BEGIN",
          "COMMIT",
          "ROLLBACK",
          "SET LOCAL ROLE meridian_app",
        ].includes(text) &&
        !text.startsWith("SELECT set_config(")
      ) {
        assert.ok(
          text.includes(`from "${table}"`),
          `unexpected post-denial query: ${text}`,
        );
      }
      return { rows: [], rowCount: 0, fields: [] };
    },
    release: (destroy: boolean) => {
      assert.equal(leased, true);
      assert.equal(destroy, false);
      leased = false;
    },
  });
  t.mock.method(pool, "connect", async () => {
    assert.equal(leased, false);
    leased = true;
    return client as unknown as PoolClient;
  });
  t.mock.method(pool, "query", () =>
    assert.fail("no raw database access is allowed"),
  );
  return calls;
}

function assertFirmPin(
  calls: { text: string; params: unknown[] }[],
  firmId: string,
) {
  assert.deepEqual(
    calls
      .filter((call) => call.text.includes("set_config('app.bypass'"))
      .map((call) => call.params),
    [["off"]],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.text.includes("set_config('app.firm_id'"))
      .map((call) => call.params),
    [[firmId]],
  );
}

const alert = {
  prefs: undefined,
  clientPartyId: party,
  firmId: firm,
  templateKey: "client_statement_ready" as const,
  entityType: "clerk_client_statement",
  entityId: "stmt-context-test",
  smsDefaultWhenNoPrefs: false,
};

test("Clerk alert consent is checked in the sending firm's short scope and hidden grants send nothing", async (t) => {
  const calls = hiddenRows(t, "consent_records");
  await runHttpDatabaseBoundary(async () => {
    finishHttpAuthentication();
    await fanOutAlert(alert);
  });
  assertFirmPin(calls, firm);
  assert.equal(
    calls.filter((call) => call.text.includes('from "consent_records"')).length,
    1,
  );
  assert.equal(calls.at(-1)?.text, "COMMIT");
});

test("Clerk alert helpers retain an existing caller's tenant instead of elevating to the supplied firm", async (t) => {
  const calls = hiddenRows(t, "consent_records");
  await runRequestContext({ bypass: false, firmId: otherFirm }, () =>
    fanOutAlert(alert),
  );
  assertFirmPin(calls, otherFirm);
  assert.equal(calls.filter((call) => call.text === "BEGIN").length, 1);
});

test("Clerk narration refuses an RLS-hidden statement before shortlist, audit or provider work", async (t) => {
  const calls = hiddenRows(t, "bank_statements");
  let providerCalls = 0;
  const gateway: ClerkGateway = {
    model: "context-test",
    infer: async () => {
      providerCalls += 1;
      assert.fail("hidden statements must never reach the provider");
    },
  };
  await runHttpDatabaseBoundary(async () => {
    finishHttpAuthentication();
    await assert.rejects(
      suggestNarrationMatches(party, firmPrincipal(firm), gateway),
      (error: Error & { code?: string; status?: number }) =>
        error.code === "NOT_FOUND" &&
        error.status === 404 &&
        error.message === "Statement not found",
    );
  });
  assertFirmPin(calls, firm);
  assert.equal(
    calls.filter((call) => call.text.includes('from "bank_statements"')).length,
    1,
  );
  assert.equal(calls.at(-1)?.text, "ROLLBACK");
  assert.equal(providerCalls, 0);
});
