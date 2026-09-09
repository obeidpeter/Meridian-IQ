import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creditDataRoomCheck,
  evidenceCheck,
  heartbeatCheck,
  invoiceRoomCheck,
  releaseStatus,
  authorityRailsCheck,
  securityConfigurationCheck,
  type HeartbeatEvidence,
} from "./release-readiness-checks.ts";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

test("heartbeat evidence rejects stale and future timestamps", () => {
  assert.equal(
    heartbeatCheck(
      "scheduled_work",
      "Scheduled work",
      new Date(NOW - 60_000),
      120_000,
      true,
      NOW,
    ).status,
    "pass",
  );
  assert.equal(
    heartbeatCheck(
      "scheduled_work",
      "Scheduled work",
      new Date(NOW - 180_000),
      120_000,
      true,
      NOW,
    ).status,
    "blocked",
  );
  assert.match(
    heartbeatCheck(
      "scheduled_work",
      "Scheduled work",
      new Date(NOW + 600_000),
      120_000,
      false,
      NOW,
    ).summary,
    /future/,
  );
});

const success = new Date(NOW - 60_000);
const backupMetadata = {
  evidenceVersion: 2,
  sha256: "a".repeat(64),
  snapshotSha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
  createdAt: new Date(NOW - 120_000).toISOString(),
  bytes: 100,
  tocEntries: 10,
};
const drillMetadata = {
  evidenceVersion: 2,
  backupSha256: "a".repeat(64),
  snapshotSha256: "b".repeat(64),
  backupManifestSha256: "c".repeat(64),
  backupCreatedAt: new Date(NOW - 120_000).toISOString(),
  securityCatalogVerified: true,
  allTableCountsVerified: true,
};
const heartbeat = (key: string, row: HeartbeatEvidence, production = true) =>
  heartbeatCheck(key, key, row.lastSucceededAt, 180_000, production, NOW, row);

test("missing, invalid and failed heartbeats retain distinct evidence states without raw errors", () => {
  for (const [row, state] of [
    [{}, "missing"],
    [{ lastSucceededAt: new Date("invalid") }, "invalid"],
    [{ lastFailedAt: new Date("invalid") }, "invalid"],
    [{ lastSucceededAt: new Date(NOW + 600_000) }, "invalid"],
    [{ lastFailedAt: new Date(NOW) }, "failed"],
    [{ lastSucceededAt: success, lastFailedAt: success }, "failed"],
    [{ lastSucceededAt: success, lastFailedAt: new Date(NOW) }, "failed"],
    [
      {
        lastSucceededAt: success,
        lastError: "postgres://private:password@database",
      },
      "failed",
    ],
    [{ lastSucceededAt: new Date(NOW - 180_001) }, "stale"],
  ] as const) {
    const result = heartbeat("scheduled_work", row);
    assert.equal(result.status, "blocked");
    assert.equal(result.detail?.evidenceState, state);
    assert.equal(result.detail?.evidenceSource, "operational_heartbeats");
    assert.ok(result.detail?.owner);
    assert.ok(result.detail?.remediation);
    assert.doesNotMatch(JSON.stringify(result), /postgres:|password@/);
    assert.equal(heartbeat("scheduled_work", row, false).status, "warning");
  }
});

test("a later success clears an older failure, including the freshness boundary", () => {
  const row = {
    lastSucceededAt: new Date(NOW - 180_000),
    lastFailedAt: new Date(NOW - 180_001),
  };
  const result = heartbeat("scheduled_work", row);
  assert.equal(result.status, "pass");
  assert.equal(
    result.detail?.lastSucceededAt,
    row.lastSucceededAt.toISOString(),
  );
  assert.equal(result.detail?.lastFailedAt, row.lastFailedAt.toISOString());
});

test("backup proof requires versioned producer provenance, not just a recent success", () => {
  assert.equal(
    heartbeat("backup", { lastSucceededAt: success }).detail?.evidenceState,
    "unverified",
  );
  for (const patch of [
    { evidenceVersion: 1 },
    { sha256: "invalid" },
    { snapshotSha256: null },
    { manifestSha256: "" },
    { bytes: 0 },
    { tocEntries: -1 },
    { createdAt: "invalid" },
    { createdAt: new Date(NOW).toISOString() },
  ]) {
    assert.equal(
      heartbeat("backup", {
        lastSucceededAt: success,
        metadata: { ...backupMetadata, ...patch },
      }).detail?.evidenceState,
      "unverified",
    );
  }
  const stale = heartbeat("backup", {
    lastSucceededAt: success,
    metadata: {
      ...backupMetadata,
      createdAt: new Date(NOW - 180_001).toISOString(),
    },
  });
  assert.equal(stale.detail?.evidenceState, "stale");
  const result = heartbeat("backup", {
    lastSucceededAt: success,
    metadata: { ...backupMetadata, file: "private.dump", arbitrary: "secret" },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.detail?.provenanceVerified, true);
  assert.equal(result.detail?.offBoxRetentionVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /private.dump|secret/);
});

test("drill proof requires the retained archive digests, catalog and counts at backup time", () => {
  for (const patch of [
    { evidenceVersion: 1 },
    { backupSha256: null },
    { snapshotSha256: "" },
    { backupManifestSha256: "" },
    { securityCatalogVerified: false },
    { allTableCountsVerified: false },
    { backupCreatedAt: "invalid" },
    { backupCreatedAt: new Date(NOW - 2 * 86_400_000).toISOString() },
  ]) {
    assert.equal(
      heartbeat("restore_drill", {
        lastSucceededAt: success,
        metadata: { ...drillMetadata, ...patch },
      }).detail?.evidenceState,
      "unverified",
    );
  }
  assert.equal(
    heartbeat("restore_drill", {
      lastSucceededAt: success,
      metadata: drillMetadata,
    }).status,
    "pass",
  );
  assert.equal(
    heartbeat("restore_drill", {
      lastSucceededAt: success,
      metadata: drillMetadata,
      lastFailedAt: new Date(NOW),
    }).detail?.evidenceState,
    "failed",
  );
});

test("dated attestations distinguish missing, stale, invalid and unsupported dates", () => {
  const check = (raw: string | undefined, reference?: string) =>
    evidenceCheck({
      key: "moderated_usability",
      label: "Usability",
      envName: "USABILITY_VALIDATED_AT",
      raw,
      maxAgeMs: 180_000,
      production: true,
      now: NOW,
      requireReference: true,
      detail: { evidenceReference: reference },
    });
  assert.equal(check(undefined).detail?.evidenceState, "missing");
  assert.equal(check("2026-09-04").detail?.evidenceState, "invalid");
  assert.equal(
    check(new Date(NOW + 600_000).toISOString()).detail?.evidenceState,
    "invalid",
  );
  assert.equal(
    check(new Date(NOW - 180_001).toISOString()).detail?.evidenceState,
    "stale",
  );
  assert.equal(
    check(success.toISOString()).detail?.evidenceState,
    "unverified",
  );
  const current = check(success.toISOString(), "private-report-123");
  assert.equal(current.status, "pass");
  assert.equal(current.detail?.evidenceSource, "operator_attestation");
  assert.match(current.summary, /not independently verified/);
});

test("configured security and live rails do not claim external operational proof", () => {
  const security = securityConfigurationCheck({
    signedOnly: true,
    metricsSecured: true,
    schedulerSecured: true,
    privilegedMfa: true,
    production: true,
  });
  const rails = authorityRailsCheck({
    transport: "http",
    environment: "live",
    railsConfigured: true,
    configuredRailCount: 2,
    accreditationConfirmed: true,
    requireLive: true,
  });
  for (const result of [security, rails]) {
    assert.equal(result.status, "pass");
    assert.equal(result.detail?.evidenceState, "configuration_only");
    assert.ok(result.detail?.owner);
    assert.ok(result.detail?.remediation);
  }
  assert.match(rails.summary, /no provider transaction is verified/);
  assert.match(security.summary, /has not been verified/);
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
