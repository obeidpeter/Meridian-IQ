import { test } from "node:test";
import assert from "node:assert/strict";
import { assessBuyerPilot } from "../buyer/pilots.ts";
import { failureRateStatus, qualityStatus } from "../clerk/assurance.ts";
import { classifySla } from "./compliance-operations.ts";
import { assessConnectionHealth } from "./integration-reliability.ts";

test("buyer pilot scoring exposes evidence blockers and a deterministic stage", () => {
  assert.deepEqual(
    assessBuyerPilot({
      tinValidated: true,
      supplierCount: 3,
      invoiceCount: 8,
      stampedCount: 8,
      responseCount: 6,
      responseRate: 0.75,
      paidSignals: 2,
    }),
    { readinessScore: 100, stage: "scale_ready", blockers: [] },
  );

  const discovery = assessBuyerPilot({
    tinValidated: false,
    supplierCount: 1,
    invoiceCount: 1,
    stampedCount: 0,
    responseCount: 0,
    responseRate: null,
    paidSignals: 0,
  });
  assert.equal(discovery.readinessScore, 0);
  assert.equal(discovery.stage, "discovery");
  assert.equal(discovery.blockers.length, 6);
});

test("compliance SLA classification is overdue, due-soon and healthy at fixed boundaries", () => {
  const now = new Date("2026-08-08T10:00:00.000Z");
  assert.equal(
    classifySla(new Date("2026-08-08T09:59:59.000Z"), now),
    "overdue",
  );
  assert.equal(
    classifySla(new Date("2026-08-11T10:00:00.000Z"), now),
    "due_soon",
  );
  assert.equal(
    classifySla(new Date("2026-08-11T10:00:01.000Z"), now),
    "healthy",
  );
});

test("connection health gives failures precedence over freshness", () => {
  const now = new Date("2026-08-08T10:00:00.000Z");
  assert.equal(
    assessConnectionHealth(
      {
        connectionStatus: "active",
        latestRunStatus: "failed",
        lastSyncAt: "2026-08-08T09:00:00.000Z",
        issue: "authentication refused",
      },
      now,
    ).operationalState,
    "incident",
  );
  assert.equal(
    assessConnectionHealth(
      {
        connectionStatus: "active",
        latestRunStatus: "succeeded",
        lastSyncAt: "2026-08-07T08:00:00.000Z",
        issue: null,
      },
      now,
    ).operationalState,
    "stale",
  );
  assert.equal(
    assessConnectionHealth(
      {
        connectionStatus: "active",
        latestRunStatus: "succeeded",
        lastSyncAt: "2026-08-08T09:00:00.000Z",
        issue: null,
      },
      now,
    ).operationalState,
    "healthy",
  );
});

test("Clerk quality gates distinguish missing, degraded and failed evidence", () => {
  assert.equal(qualityStatus(null, 0.95, 0.8), "watch");
  assert.equal(qualityStatus(0.97, 0.95, 0.8), "healthy");
  assert.equal(qualityStatus(0.9, 0.95, 0.8), "watch");
  assert.equal(qualityStatus(0.79, 0.95, 0.8), "critical");
  assert.equal(failureRateStatus(0, 0), "watch");
  assert.equal(failureRateStatus(0.01, 100), "healthy");
  assert.equal(failureRateStatus(0.03, 100), "watch");
  assert.equal(failureRateStatus(0.05, 100), "critical");
});
