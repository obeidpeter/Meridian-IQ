import { test, expect, describe } from "vitest";
import type {
  StatementConnectorInfo,
  StatementSyncRun,
} from "@workspace/api-client-react";
import {
  CONNECTION_STATUS_TONE,
  SYNC_RUN_TONE,
  connectorConfigurationComplete,
  connectorFieldState,
  connectorLabel,
  lastSyncLabel,
  syncRunSummary,
} from "./statement-connections-card";

// Bank-feed connections: declared-field validation and small display helpers.
// The card itself is render-on-success (a 404 from a server without the rail
// hides the whole section), which the e2e journeys cover.

const connector = (
  over: Partial<StatementConnectorInfo> = {},
): StatementConnectorInfo => ({
  key: "mono",
  name: "Mono",
  description: "Open banking",
  mode: "sandbox",
  configured: true,
  configurationFields: [
    {
      key: "apiKey",
      label: "API key",
      required: true,
      secret: true,
      placeholder: "demo_…",
      help: "Provider credential",
    },
  ],
  ...over,
});

describe("connectorConfigurationComplete", () => {
  test("requires every declared required field", () => {
    expect(connectorConfigurationComplete(connector(), {})).toBe(false);
    expect(connectorConfigurationComplete(connector(), { apiKey: "  " })).toBe(
      false,
    );
    expect(
      connectorConfigurationComplete(connector(), { apiKey: "demo_key" }),
    ).toBe(true);
  });

  test("never enables an unconfigured live connector", () => {
    expect(
      connectorConfigurationComplete(connector({ configured: false }), {
        apiKey: "demo_key",
      }),
    ).toBe(false);
  });
});

describe("connectorFieldState", () => {
  const one = [connector()];

  test("still-loading registry shows the skeleton", () => {
    expect(connectorFieldState(undefined, false)).toBe("loading");
  });

  test("a failed fetch is an inline error, never an eternal skeleton", () => {
    expect(connectorFieldState(undefined, true)).toBe("error");
  });

  test("a loaded registry is empty or ready by its length", () => {
    expect(connectorFieldState([], false)).toBe("empty");
    expect(connectorFieldState(one, false)).toBe("ready");
  });
});

describe("connectorLabel", () => {
  const connectors = [connector({ description: "Nigerian open banking" })];

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
