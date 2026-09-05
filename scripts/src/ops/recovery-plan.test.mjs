import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadMaintenancePlan,
  loadRollbackApproval,
  recoveryMode,
  validateRollbackApproval,
  validateMaintenancePlan,
  RECOVERY_PLAN_MAX_BYTES,
} from "./recovery-plan.mjs";

// Synthetic evidence only. This fixture must never be used as an operator plan.
const revision = "a".repeat(40);
const backupSha256 = "b".repeat(64);
const now = Date.parse("2026-09-04T12:00:00Z");
const context = { revision, backupSha256, now, trafficDrained: "1" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stopped = (target) => ({
  state: "stopped",
  targets: [target],
  evidence: `Synthetic fixture: ${target} stopped, active writers zero`,
});

function rollbackFixture() {
  return {
    format: 1,
    mode: "rollback",
    revision,
    rollbackRevision: "c".repeat(40),
    approved: true,
    approvedBy: "fixture-approver",
    approvedAt: "2026-09-04T11:50:00Z",
    expiresAt: "2026-09-04T13:00:00Z",
    qualificationEvidence: "Synthetic immutable CI and staging evidence",
  };
}

function rollbackFile(t, value = rollbackFixture()) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "meridian-rollback-approval-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic-rollback-approval.json");
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(file, bytes);
  return {
    RELEASE_ROLLBACK_REVISION: value.rollbackRevision,
    RELEASE_ROLLBACK_APPROVAL: file,
    RELEASE_ROLLBACK_APPROVAL_SHA256: digest(bytes),
  };
}

function fixture() {
  return {
    format: 1,
    mode: "maintenance-forward",
    revision,
    approved: true,
    approvedBy: "fixture-approver",
    approvedAt: "2026-09-04T11:50:00Z",
    window: { start: "2026-09-04T11:00:00Z", end: "2026-09-04T13:00:00Z" },
    drain: {
      confirmedBy: "fixture-operator",
      confirmedAt: "2026-09-04T11:10:00Z",
      api: stopped("fixture/api/replica-1"),
      workers: stopped("fixture/workers/pipeline"),
      schedules: stopped("fixture/schedules/sweep"),
      otherWriters: {
        state: "absent",
        targets: [],
        evidence: "Synthetic fixture inventory confirms no other writers",
      },
    },
    backup: {
      sha256: backupSha256,
      preChange: true,
      completedAt: "2026-09-04T11:40:00Z",
      evidence: "Synthetic immutable archive observation, not a real backup",
    },
    forwardFix: {
      approved: true,
      owner: "fixture-recovery-owner",
      procedure:
        "Synthetic procedure: diagnose offline, review and verify a forward fix",
      writersRemainStopped: true,
      automaticResume: false,
      resumeCriteria: {
        artifactIdentity: "Verify exact approved full SHA and asset hashes",
        migrationIntegrity:
          "Verify migration ledger and retained financial rows",
        securityCatalog: "Compare roles, RLS, grants, triggers and constraints",
        applicationChecks:
          "Pass isolated application probes while writers stay stopped",
        operatorSignoff:
          "Recovery owner records explicit approval before any writer resumes",
      },
    },
  };
}

function planFile(t, bytes = Buffer.from(JSON.stringify(fixture()))) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "meridian-recovery-plan-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic-plan.json");
  writeFileSync(file, bytes);
  return {
    RELEASE_RECOVERY_MODE: "maintenance-forward",
    RELEASE_TRAFFIC_DRAINED: "1",
    RELEASE_RECOVERY_PLAN: file,
    RELEASE_RECOVERY_PLAN_SHA256: digest(bytes),
  };
}

test("rollback stays the default and requires approval record configuration", (t) => {
  const rollback = rollbackFile(t);
  assert.equal(
    recoveryMode(rollback),
    "rollback",
  );
  assert.equal(
    recoveryMode({
      ...rollback,
      RELEASE_RECOVERY_MODE: "rollback",
    }),
    "rollback",
  );
  for (const rollback of [undefined, "", "main", revision.slice(0, 7)])
    assert.throws(
      () => recoveryMode({ ...rollbackFile(t), RELEASE_ROLLBACK_REVISION: rollback }),
      /RELEASE_ROLLBACK_REVISION/,
    );
  assert.throws(
    () => recoveryMode({ RELEASE_ROLLBACK_REVISION: "c".repeat(40) }),
    /RELEASE_ROLLBACK_APPROVAL/,
  );
});

test("rollback approval binds exact bytes, candidate, fallback, review and expiry", (t) => {
  const record = rollbackFixture();
  const context = {
    revision,
    rollbackRevision: record.rollbackRevision,
    now,
  };
  assert.equal(validateRollbackApproval(record, context), record);
  assert.deepEqual(loadRollbackApproval(rollbackFile(t, record), context), record);
  for (const [change, expected] of [
    [{ revision: "d".repeat(40) }, /candidate mismatch/],
    [{ rollbackRevision: "d".repeat(40) }, /revision mismatch/],
    [{ now: Date.parse(record.expiresAt) }, /expired/],
  ])
    assert.throws(
      () => loadRollbackApproval(rollbackFile(t, record), { ...context, ...change }),
      expected,
    );
  for (const mutate of [
    (value) => (value.approved = false),
    (value) => (value.rollbackRevision = value.revision),
    (value) => (value.extra = true),
  ]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.throws(() =>
      validateRollbackApproval(invalid, {
        ...context,
        rollbackRevision: invalid.rollbackRevision,
      }),
    );
  }
  const env = rollbackFile(t, record);
  writeFileSync(env.RELEASE_ROLLBACK_APPROVAL, "{}");
  assert.throws(() => loadRollbackApproval(env, context), /checksum mismatch/);
});

test("unknown modes never fall back or enable maintenance", () => {
  for (const mode of [
    "",
    "forward",
    "ROLLBACK",
    " maintenance-forward",
    null,
    true,
  ]) {
    assert.throws(
      () =>
        recoveryMode({
          RELEASE_RECOVERY_MODE: mode,
          RELEASE_ROLLBACK_REVISION: revision,
        }),
      /unknown RELEASE_RECOVERY_MODE/,
    );
  }
});

test("maintenance requires independent plan variables and exact external drain confirmation", (t) => {
  const env = planFile(t);
  assert.equal(recoveryMode(env), "maintenance-forward");
  for (const drained of [undefined, "", "0", "true", true, 1]) {
    assert.throws(
      () => recoveryMode({ ...env, RELEASE_TRAFFIC_DRAINED: drained }),
      /RELEASE_TRAFFIC_DRAINED/,
    );
    assert.throws(
      () =>
        validateMaintenancePlan(fixture(), {
          ...context,
          trafficDrained: drained,
        }),
      /RELEASE_TRAFFIC_DRAINED/,
    );
  }
  for (const file of [undefined, "", " "])
    assert.throws(
      () => recoveryMode({ ...env, RELEASE_RECOVERY_PLAN: file }),
      /RELEASE_RECOVERY_PLAN/,
    );
  for (const hash of [undefined, "", "a".repeat(40), "G".repeat(64)])
    assert.throws(
      () => recoveryMode({ ...env, RELEASE_RECOVERY_PLAN_SHA256: hash }),
      /trusted RELEASE_RECOVERY_PLAN_SHA256/,
    );
});

test("valid independently bound synthetic plan passes without a DB or any production action", (t) => {
  const plan = fixture();
  assert.equal(validateMaintenancePlan(plan, context), plan);
  assert.deepEqual(loadMaintenancePlan(planFile(t), context), plan);
});

test("four-hour window and one-hour approval limits are inclusive but cannot be exceeded", () => {
  const plan = fixture();
  plan.window.start = "2026-09-04T09:00:00Z";
  plan.drain.confirmedAt = "2026-09-04T10:10:00Z";
  plan.backup.completedAt = "2026-09-04T10:40:00Z";
  plan.approvedAt = "2026-09-04T11:00:00Z";
  assert.equal(validateMaintenancePlan(plan, context), plan);
  assert.throws(
    () => validateMaintenancePlan(plan, { ...context, now: now + 1 }),
    /stale/,
  );
  plan.window.start = "2026-09-04T08:59:59.999Z";
  assert.throws(
    () => validateMaintenancePlan(plan, context),
    /at most four hours/,
  );
});

test("other writers can be present only with a stopped inventory and evidence", () => {
  const plan = fixture();
  plan.drain.otherWriters = stopped("fixture/operator/database-session");
  assert.equal(validateMaintenancePlan(plan, context), plan);
  plan.drain.otherWriters.state = "running";
  assert.throws(
    () => validateMaintenancePlan(plan, context),
    /must be stopped/,
  );
});

const invalidPlans = [
  [
    "wrong candidate",
    (p) => {
      p.revision = "c".repeat(40);
    },
    /candidate mismatch/,
  ],
  [
    "abbreviated candidate",
    (p) => {
      p.revision = revision.slice(0, 7);
    },
    /candidate mismatch/,
  ],
  [
    "wrong backup",
    (p) => {
      p.backup.sha256 = "c".repeat(64);
    },
    /backup checksum mismatch/,
  ],
  [
    "unapproved plan",
    (p) => {
      p.approved = false;
    },
    /not approved/,
  ],
  [
    "string approval",
    (p) => {
      p.approved = "true";
    },
    /not approved/,
  ],
  [
    "missing approver",
    (p) => {
      p.approvedBy = "";
    },
    /approvedBy/,
  ],
  [
    "future approval",
    (p) => {
      p.approvedAt = "2026-09-04T12:01:00Z";
    },
    /future-dated/,
  ],
  [
    "stale approval",
    (p) => {
      p.approvedAt = "2026-09-04T10:59:59Z";
    },
    /stale/,
  ],
  [
    "expired window",
    (p) => {
      p.window.end = "2026-09-04T12:00:00Z";
    },
    /not active/,
  ],
  [
    "future window",
    (p) => {
      p.window.start = "2026-09-04T12:00:01Z";
    },
    /not active/,
  ],
  [
    "oversized window",
    (p) => {
      p.window.end = "2026-09-04T15:00:01Z";
    },
    /at most four hours/,
  ],
  [
    "reversed window",
    (p) => {
      p.window.end = "2026-09-04T10:59:00Z";
    },
    /positive/,
  ],
  [
    "invalid date",
    (p) => {
      p.approvedAt = "2026-02-30T11:50:00Z";
    },
    /valid timestamp/,
  ],
  [
    "ambiguous timestamp",
    (p) => {
      p.approvedAt = "2026-09-04 11:50:00";
    },
    /UTC timestamp/,
  ],
  [
    "drain after approval",
    (p) => {
      p.drain.confirmedAt = "2026-09-04T11:51:00Z";
    },
    /drain must be observed/,
  ],
  [
    "drain outside window",
    (p) => {
      p.drain.confirmedAt = "2026-09-04T10:59:00Z";
    },
    /drain must be observed/,
  ],
  [
    "missing drain operator",
    (p) => {
      p.drain.confirmedBy = "";
    },
    /confirmedBy/,
  ],
  [
    "running API",
    (p) => {
      p.drain.api.state = "running";
    },
    /must be stopped/,
  ],
  [
    "absent API",
    (p) => {
      p.drain.api.state = "absent";
      p.drain.api.targets = [];
    },
    /API must be stopped/,
  ],
  [
    "empty stopped inventory",
    (p) => {
      p.drain.workers.targets = [];
    },
    /requires targets/,
  ],
  [
    "inconsistent absent inventory",
    (p) => {
      p.drain.otherWriters.targets = ["writer"];
    },
    /empty inventory/,
  ],
  [
    "duplicate target",
    (p) => {
      p.drain.workers.targets.push(p.drain.workers.targets[0]);
    },
    /duplicate targets/,
  ],
  [
    "oversized inventory",
    (p) => {
      p.drain.workers.targets = Array.from({ length: 65 }, (_, i) => String(i));
    },
    /bounded inventory/,
  ],
  [
    "pre-drain backup",
    (p) => {
      p.backup.completedAt = "2026-09-04T11:09:59Z";
    },
    /after drain/,
  ],
  [
    "backup after approval",
    (p) => {
      p.backup.completedAt = "2026-09-04T11:50:01Z";
    },
    /before approval/,
  ],
  [
    "not pre-change",
    (p) => {
      p.backup.preChange = false;
    },
    /pre-change/,
  ],
  [
    "missing backup observation",
    (p) => {
      p.backup.evidence = "";
    },
    /backup.evidence/,
  ],
  [
    "unapproved forward fix",
    (p) => {
      p.forwardFix.approved = false;
    },
    /not approved/,
  ],
  [
    "missing recovery owner",
    (p) => {
      p.forwardFix.owner = "";
    },
    /forwardFix.owner/,
  ],
  [
    "missing procedure",
    (p) => {
      p.forwardFix.procedure = "";
    },
    /forwardFix.procedure/,
  ],
  [
    "writers can resume early",
    (p) => {
      p.forwardFix.writersRemainStopped = false;
    },
    /remain stopped/,
  ],
  [
    "automatic resume",
    (p) => {
      p.forwardFix.automaticResume = true;
    },
    /automatic resume/,
  ],
  [
    "missing signoff criterion",
    (p) => {
      delete p.forwardFix.resumeCriteria.operatorSignoff;
    },
    /missing or unknown/,
  ],
  [
    "blank verification criterion",
    (p) => {
      p.forwardFix.resumeCriteria.securityCatalog = "";
    },
    /securityCatalog/,
  ],
  [
    "oversized text",
    (p) => {
      p.forwardFix.procedure = "x".repeat(2001);
    },
    /bounded text/,
  ],
  [
    "control characters",
    (p) => {
      p.approvedBy = "operator\nforged";
    },
    /control characters/,
  ],
  [
    "unknown field",
    (p) => {
      p.skipVerification = true;
    },
    /missing or unknown/,
  ],
  [
    "unknown nested field",
    (p) => {
      p.forwardFix.skipVerification = true;
    },
    /missing or unknown/,
  ],
  [
    "wrong format",
    (p) => {
      p.format = 2;
    },
    /unsupported/,
  ],
  [
    "wrong plan mode",
    (p) => {
      p.mode = "rollback";
    },
    /mode mismatch/,
  ],
];

for (const [name, mutate, expected] of invalidPlans) {
  test(`rejects ${name}`, () => {
    const plan = fixture();
    mutate(plan);
    assert.throws(() => validateMaintenancePlan(plan, context), expected);
  });
}

for (const group of ["api", "workers", "schedules", "otherWriters"]) {
  test(`requires enumerated ${group} drain evidence`, () => {
    const plan = fixture();
    plan.drain[group].evidence = "";
    assert.throws(() => validateMaintenancePlan(plan, context), /evidence/);
    delete plan.drain[group];
    assert.throws(
      () => validateMaintenancePlan(plan, context),
      /missing or unknown/,
    );
  });
}

test("expected bindings and clock cannot be omitted or malformed", () => {
  for (const revision of [undefined, "main", "a".repeat(39)])
    assert.throws(
      () => validateMaintenancePlan(fixture(), { ...context, revision }),
      /full SHA/,
    );
  for (const backupSha256 of [undefined, "latest", "b".repeat(63)])
    assert.throws(
      () => validateMaintenancePlan(fixture(), { ...context, backupSha256 }),
      /verified backup/,
    );
  for (const now of [NaN, Infinity, "2026-09-04", 1.5])
    assert.throws(
      () => validateMaintenancePlan(fixture(), { ...context, now }),
      /epoch milliseconds/,
    );
  for (const value of [null, [], "approved"])
    assert.throws(
      () => validateMaintenancePlan(value, context),
      /must be an object/,
    );
});

test("file checksum is over exact bytes, not a self-declared or recomputed trusted hash", (t) => {
  const env = planFile(t);
  assert.throws(
    () =>
      loadMaintenancePlan(
        { ...env, RELEASE_RECOVERY_PLAN_SHA256: "c".repeat(64) },
        context,
      ),
    /checksum mismatch/,
  );
  writeFileSync(env.RELEASE_RECOVERY_PLAN, JSON.stringify(fixture(), null, 2));
  assert.throws(() => loadMaintenancePlan(env, context), /checksum mismatch/);
});

test("exactly 64 KiB is readable and validated rather than truncated", (t) => {
  const bytes = Buffer.alloc(RECOVERY_PLAN_MAX_BYTES, " ");
  bytes.write(JSON.stringify(fixture()));
  assert.deepEqual(loadMaintenancePlan(planFile(t, bytes), context), fixture());
});

test("loader enforces candidate, backup, time and approval after verifying bytes", (t) => {
  const env = planFile(t);
  assert.throws(
    () => loadMaintenancePlan(env, { ...context, revision: "c".repeat(40) }),
    /candidate mismatch/,
  );
  assert.throws(
    () =>
      loadMaintenancePlan(env, { ...context, backupSha256: "c".repeat(64) }),
    /backup checksum mismatch/,
  );
  assert.throws(
    () => loadMaintenancePlan(env, { ...context, now: now + 4 * 3600_000 }),
    /stale/,
  );
  const plan = fixture();
  plan.approved = false;
  assert.throws(
    () =>
      loadMaintenancePlan(
        planFile(t, Buffer.from(JSON.stringify(plan))),
        context,
      ),
    /not approved/,
  );
  assert.throws(
    () => loadMaintenancePlan(rollbackFile(t), context),
    /requires maintenance-forward/,
  );
});

test("loader refuses missing, non-file, empty, oversized, malformed and non-UTF-8 input", (t) => {
  const env = planFile(t);
  assert.throws(
    () =>
      loadMaintenancePlan(
        {
          ...env,
          RELEASE_RECOVERY_PLAN: `${env.RELEASE_RECOVERY_PLAN}.missing`,
        },
        context,
      ),
    /ENOENT/,
  );
  assert.throws(
    () =>
      loadMaintenancePlan(
        {
          ...env,
          RELEASE_RECOVERY_PLAN: path.dirname(env.RELEASE_RECOVERY_PLAN),
        },
        context,
      ),
    /regular non-symlink file/,
  );
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(RECOVERY_PLAN_MAX_BYTES + 1),
  ])
    assert.throws(
      () => loadMaintenancePlan(planFile(t, bytes), context),
      /at most 64 KiB/,
    );
  for (const bytes of [
    Buffer.from("{"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\ufeff{}"),
  ])
    assert.throws(
      () => loadMaintenancePlan(planFile(t, bytes), context),
      /valid UTF-8 JSON/,
    );
});
