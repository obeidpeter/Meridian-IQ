import { test, expect, describe } from "vitest";
import type { StatementSyncRun } from "@workspace/api-client-react";
import {
  CONNECTION_STATUS_TONE,
  SYNC_RUN_TONE,
  connectorLabel,
  lastSyncLabel,
  parseConnectionConfig,
  syncRunSummary,
} from "./statement-connections-card";

// Bank-feed connections: the JSON-config gate and the small display helpers.
// The card itself is render-on-success (a 404 from a server without the rail
// hides the whole section), which the e2e journeys cover.

describe("parseConnectionConfig", () => {
  test("an empty or whitespace-only field is simply 'no config'", () => {
    expect(parseConnectionConfig("")).toEqual({ ok: true, config: undefined });
    expect(parseConnectionConfig("   ")).toEqual({
      ok: true,
      config: undefined,
    });
  });

  test("a JSON object passes through parsed", () => {
    expect(parseConnectionConfig('{"apiKey": "k1", "n": 2}')).toEqual({
      ok: true,
      config: { apiKey: "k1", n: 2 },
    });
  });

  test("malformed JSON fails with the not-valid-JSON message", () => {
    const res = parseConnectionConfig("{nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Config is not valid JSON.");
  });

  test("valid JSON that is not a plain object fails — the server would 400 it", () => {
    for (const text of ['"a string"', "[1,2]", "42", "null", "true"]) {
      const res = parseConnectionConfig(text);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("JSON object");
    }
  });
});

describe("connectorLabel", () => {
  const connectors = [
    { key: "mono", name: "Mono", description: "Nigerian open banking" },
  ];

  test("resolves the human name from the registry", () => {
    expect(connectorLabel("mono", connectors)).toBe("Mono");
  });

  test("falls back to the raw key when the registry hasn't loaded or lacks it", () => {
    expect(connectorLabel("okra", connectors)).toBe("okra");
    expect(connectorLabel("mono", undefined)).toBe("mono");
  });
});

describe("lastSyncLabel", () => {
  test("a never-synced connection says so instead of showing a blank date", () => {
    expect(lastSyncLabel(null)).toBe("Never synced");
    expect(lastSyncLabel(undefined)).toBe("Never synced");
  });

  test("a synced connection leads with 'Last sync'", () => {
    expect(lastSyncLabel("2026-07-01T09:00:00Z")).toMatch(/^Last sync /);
  });
});

describe("syncRunSummary", () => {
  const run = (over: Partial<StatementSyncRun>): StatementSyncRun => ({
    id: "r1",
    connectionId: "c1",
    status: "succeeded",
    startedAt: "2026-07-01T09:00:00Z",
    ...over,
  });

  test("a success reports the pulled line count (0 when the wire omits it)", () => {
    expect(syncRunSummary(run({ linesPulled: 12 }))).toBe("Pulled 12 line(s)");
    expect(syncRunSummary(run({}))).toBe("Pulled 0 line(s)");
  });

  test("a failure relays the server's error, with a fallback", () => {
    expect(
      syncRunSummary(run({ status: "failed", error: "credentials expired" })),
    ).toBe("credentials expired");
    expect(syncRunSummary(run({ status: "failed" }))).toBe("Sync failed.");
  });

  test("a still-running 202 says so", () => {
    expect(syncRunSummary(run({ status: "running" }))).toBe("Sync running…");
  });
});

describe("status tones", () => {
  test("connection and run statuses each carry a badge tone", () => {
    expect(CONNECTION_STATUS_TONE.active).toBe("emerald");
    expect(CONNECTION_STATUS_TONE.disabled).toBe("slate");
    expect(SYNC_RUN_TONE.running).toBe("amber");
    expect(SYNC_RUN_TONE.succeeded).toBe("emerald");
    expect(SYNC_RUN_TONE.failed).toBe("red");
  });
});
