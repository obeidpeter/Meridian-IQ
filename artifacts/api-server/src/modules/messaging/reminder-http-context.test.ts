import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { getTableColumns, sql } from "drizzle-orm";
import {
  pool,
  getDb,
  runHttpDatabaseBoundary,
  finishHttpAuthentication,
  hasDatabaseContext,
  runInBypassContext,
  alertPreferencesTable,
} from "@workspace/db";
import { sweepDeadlineReminders } from "../invoice/reminders.ts";
import { sweepObligationReminders } from "../obligations/reminders.ts";
import { sweepFilingReminders } from "../filings/reminders.ts";
import { sweepWhtReminders } from "../wht/reminders.ts";
import { runClaimFirstReminderSweep } from "./reminder-sweep.ts";

test("all four reminder candidate reads and preference reads are scoped under HTTP without wrapping claims or fan-out", async (t) => {
  let leased = 0;
  let commits = 0;
  const reads: string[] = [];
  t.mock.method(pool, "query", () => assert.fail("no ambient raw fallback"));
  t.mock.method(pool, "connect", async () => {
    assert.equal(leased, 0, "stages do not hold overlapping connections");
    leased++;
    let configured = false;
    return Object.assign(new EventEmitter(), {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        if (text.includes("app.bypass")) configured = true;
        if (text === "COMMIT") commits++;
        if (text.startsWith("select ")) {
          assert.equal(leased, 1);
          assert.equal(
            configured,
            true,
            "the selected handle has explicit transaction GUCs",
          );
          reads.push(text);
        }
        let rows: unknown[][] = [];
        if (text.includes('from "feature_flags"')) rows = [[true]];
        if (text.includes('from "alert_preferences"')) {
          rows = [
            Object.values(getTableColumns(alertPreferencesTable)).map(
              (column) => {
                if (column.name === "client_party_id")
                  return "11111111-1111-4111-8111-111111111111";
                if (column.name.endsWith("_at"))
                  return new Date().toISOString();
                return false; // opt out after proving the preference stage runs
              },
            ),
          ];
        }
        return { rows, rowCount: rows.length, fields: [] };
      },
      release: () => {
        leased--;
      },
    });
  });
  await runHttpDatabaseBoundary(async () => {
    finishHttpAuthentication();
    for (const sweep of [
      sweepDeadlineReminders,
      sweepObligationReminders,
      sweepFilingReminders,
      sweepWhtReminders,
    ]) {
      assert.equal(await sweep(), 0);
      assert.equal(leased, 0);
      assert.throws(() => getDb(), /explicit database context/);
    }
    const beforeClaim = commits;
    let claimed = false;
    const now = new Date();
    assert.equal(
      await runClaimFirstReminderSweep(now, [{}], {
        batchLimit: 1,
        dueSoonDays: 3,
        staleOverdueDays: 60,
        deadlineFor: () => new Date(now.getTime() - 86_400_000),
        clientPartyIdOf: () => "11111111-1111-4111-8111-111111111111",
        firmIdOf: () => "22222222-2222-4222-8222-222222222222",
        claim: async () => {
          assert.equal(hasDatabaseContext(), false);
          assert.equal(leased, 0);
          await runInBypassContext(async () => {
            await getDb().execute(sql`SELECT 'claim'`);
          });
          assert.ok(commits > beforeClaim);
          claimed = true;
          return true;
        },
        templateKeyFor: () => "deadline_reminder",
        entityType: "invoice",
        entityRef: () => "fixture",
      }),
      1,
    );
    assert.equal(claimed, true);
    assert.equal(leased, 0);
    assert.throws(() => getDb(), /explicit database context/);
  });
  for (const table of [
    "invoices",
    "obligations",
    "filing_returns",
    "wht_credits",
    "alert_preferences",
  ]) {
    assert.ok(
      reads.some((text) => text.includes(`from "${table}"`)),
      `${table} is read inside a short context`,
    );
  }
});
