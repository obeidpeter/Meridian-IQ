import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creditDataRoomCheck,
  evidenceCheck,
  heartbeatCheck,
  invoiceRoomCheck,
  releaseStatus,
} from "./release-readiness-checks.ts";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

test("heartbeat evidence rejects stale and future timestamps", () => {
  assert.equal(
    heartbeatCheck(
      "backup",
      "Backup",
      new Date(NOW - 60_000),
      120_000,
      true,
      NOW,
    ).status,
    "pass",
  );
  assert.equal(
    heartbeatCheck(
      "backup",
      "Backup",
      new Date(NOW - 180_000),
      120_000,
      true,
      NOW,
    ).status,
    "blocked",
  );
  assert.match(
    heartbeatCheck(
      "backup",
      "Backup",
      new Date(NOW + 600_000),
      120_000,
      false,
      NOW,
    ).summary,
    /future/,
  );
});

test("dated evidence fails closed in production", () => {
  assert.equal(
    evidenceCheck({
      key: "e",
      label: "Evidence",
      envName: "EVIDENCE_AT",
      raw: undefined,
      maxAgeMs: 1,
      production: true,
      now: NOW,
    }).status,
    "blocked",
  );
  assert.equal(
    evidenceCheck({
      key: "e",
      label: "Evidence",
      envName: "EVIDENCE_AT",
      raw: "invalid",
      maxAgeMs: 1,
      production: false,
      now: NOW,
    }).status,
    "warning",
  );
});

test("invoice room activation requires both security settings", () => {
  assert.equal(
    invoiceRoomCheck({
      active: false,
      encryptionKeyConfigured: false,
      publicUrlConfigured: false,
      production: true,
    }).status,
    "pass",
  );
  assert.equal(
    invoiceRoomCheck({
      active: true,
      encryptionKeyConfigured: true,
      publicUrlConfigured: false,
      production: true,
    }).status,
    "blocked",
  );
});

test("release status uses the most severe check", () => {
  const check = (status: "pass" | "warning" | "blocked") => ({
    key: status,
    label: status,
    status,
    summary: status,
    detail: null,
  });
  assert.equal(releaseStatus([check("pass")]), "ready");
  assert.equal(releaseStatus([check("pass"), check("warning")]), "warning");
  assert.equal(releaseStatus([check("warning"), check("blocked")]), "blocked");
});

test("credit readiness preserves the public detail vocabulary", () => {
  const result = creditDataRoomCheck({
    creditReadinessEnabled: true,
    creditPilotFirms: 2,
    bankDataRoomActive: false,
    activationReady: false,
    blockers: ["bank_data_room_disabled"],
    observableBusinesses: 2,
    targetBusinesses: 5,
    latestBacktestPassed: false,
  });
  assert.equal(result.status, "warning");
  assert.equal(result.detail?.bankDataRoomEnabled, false);
  assert.equal("bankDataRoomActive" in (result.detail ?? {}), false);
});
