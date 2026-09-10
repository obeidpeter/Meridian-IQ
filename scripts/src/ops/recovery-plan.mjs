import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { TextDecoder } from "node:util";

export const RECOVERY_PLAN_MAX_BYTES = 64 * 1024;
const ROLLBACK_APPROVAL_MAX_BYTES = 64 * 1024;
const MAINTENANCE_WINDOW_MAX_MS = 4 * 3600_000;
const PLAN_APPROVAL_MAX_AGE_MS = 3600_000;

const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WRITER_GROUPS = ["api", "workers", "schedules", "otherWriters"];
const RESUME_CRITERIA = [
  "artifactIdentity",
  "migrationIntegrity",
  "securityCatalog",
  "applicationChecks",
  "operatorSignoff",
];

function fields(value, keys, label) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} has missing or unknown fields`,
  );
}

function text(value, label, max = 2000) {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      value === value.trim() &&
      Array.from(value).every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    `${label} must be nonempty bounded text without control characters`,
  );
}

function timestamp(value, label) {
  assert.match(
    value ?? "",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    `${label} must be an explicit UTC timestamp`,
  );
  const ms = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  assert.ok(
    Number.isFinite(ms) && new Date(ms).toISOString() === canonical,
    `${label} is not a valid timestamp`,
  );
  return ms;
}

export function recoveryMode(env = process.env) {
  const mode =
    env.RELEASE_RECOVERY_MODE === undefined
      ? "rollback"
      : env.RELEASE_RECOVERY_MODE;
  assert.ok(
    mode === "rollback" || mode === "maintenance-forward",
    "unknown RELEASE_RECOVERY_MODE; use rollback or maintenance-forward",
  );
  if (mode === "rollback") {
    assert.match(
      env.RELEASE_ROLLBACK_REVISION ?? "",
      REVISION,
      "rollback mode requires RELEASE_ROLLBACK_REVISION as a full SHA",
    );
    text(env.RELEASE_ROLLBACK_APPROVAL, "RELEASE_ROLLBACK_APPROVAL", 4096);
    assert.match(
      env.RELEASE_ROLLBACK_APPROVAL_SHA256 ?? "",
      SHA256,
      "independently trusted RELEASE_ROLLBACK_APPROVAL_SHA256 is required",
    );
  } else {
    assert.equal(
      env.RELEASE_TRAFFIC_DRAINED,
      "1",
      "maintenance-forward requires RELEASE_TRAFFIC_DRAINED=1 after external drain",
    );
    text(env.RELEASE_RECOVERY_PLAN, "RELEASE_RECOVERY_PLAN", 4096);
    assert.match(
      env.RELEASE_RECOVERY_PLAN_SHA256 ?? "",
      SHA256,
      "independently trusted RELEASE_RECOVERY_PLAN_SHA256 is required",
    );
  }
  return mode;
}

export function validateRollbackApproval(
  record,
  { revision, rollbackRevision, now = Date.now() },
) {
  assert.match(revision ?? "", REVISION, "candidate must be a full SHA");
  assert.match(
    rollbackRevision ?? "",
    REVISION,
    "rollback revision must be a full SHA",
  );
  assert.ok(Number.isSafeInteger(now), "now must be epoch milliseconds");
  fields(
    record,
    [
      "format",
      "mode",
      "revision",
      "rollbackRevision",
      "approved",
      "approvedBy",
      "approvedAt",
      "expiresAt",
      "qualificationEvidence",
    ],
    "rollback approval",
  );
  assert.equal(record.format, 1, "unsupported rollback approval format");
  assert.equal(record.mode, "rollback", "rollback approval mode mismatch");
  assert.equal(
    record.revision,
    revision,
    "rollback approval candidate mismatch",
  );
  assert.equal(
    record.rollbackRevision,
    rollbackRevision,
    "approved rollback revision mismatch",
  );
  assert.notEqual(
    record.rollbackRevision,
    record.revision,
    "candidate cannot approve itself as its rollback fallback",
  );
  assert.equal(record.approved, true, "rollback record is not approved");
  text(record.approvedBy, "rollback approval approvedBy", 200);
  text(record.qualificationEvidence, "rollback approval qualificationEvidence");
  const approvedAt = timestamp(
    record.approvedAt,
    "rollback approval approvedAt",
  );
  const expiresAt = timestamp(record.expiresAt, "rollback approval expiresAt");
  assert.ok(
    approvedAt <= now && now < expiresAt,
    "rollback approval is expired or future-dated",
  );
  assert.ok(
    expiresAt > approvedAt,
    "rollback approval expiry must follow approval",
  );
  return record;
}

// Validates recorded attestations, not the truth of external drain/backup evidence.
// Only the file loader below binds these records to independently approved bytes.
export function validateMaintenancePlan(
  plan,
  { revision, backupSha256, now = Date.now(), trafficDrained },
) {
  assert.equal(trafficDrained, "1", "RELEASE_TRAFFIC_DRAINED=1 is required");
  assert.match(revision ?? "", REVISION, "candidate must be a full SHA");
  assert.match(
    backupSha256 ?? "",
    SHA256,
    "verified backup SHA-256 is required",
  );
  assert.ok(Number.isSafeInteger(now), "now must be epoch milliseconds");
  fields(
    plan,
    [
      "format",
      "mode",
      "revision",
      "approved",
      "approvedBy",
      "approvedAt",
      "window",
      "drain",
      "backup",
      "forwardFix",
    ],
    "plan",
  );
  assert.equal(plan.format, 1, "unsupported recovery plan format");
  assert.equal(plan.mode, "maintenance-forward", "plan mode mismatch");
  assert.equal(plan.revision, revision, "recovery plan candidate mismatch");
  assert.equal(plan.approved, true, "recovery plan is not approved");
  text(plan.approvedBy, "approvedBy", 200);
  const approvedAt = timestamp(plan.approvedAt, "approvedAt");
  assert.ok(
    approvedAt <= now && now - approvedAt <= PLAN_APPROVAL_MAX_AGE_MS,
    "plan approval is stale or future-dated",
  );

  fields(plan.window, ["start", "end"], "window");
  const start = timestamp(plan.window.start, "window.start");
  const end = timestamp(plan.window.end, "window.end");
  assert.ok(
    end > start && end - start <= MAINTENANCE_WINDOW_MAX_MS,
    "maintenance window must be positive and at most four hours",
  );
  assert.ok(start <= now && now < end, "maintenance window is not active");

  fields(plan.drain, ["confirmedBy", "confirmedAt", ...WRITER_GROUPS], "drain");
  text(plan.drain.confirmedBy, "drain.confirmedBy", 200);
  const drainedAt = timestamp(plan.drain.confirmedAt, "drain.confirmedAt");
  assert.ok(
    start <= drainedAt && drainedAt <= approvedAt,
    "drain must be observed within the window before approval",
  );
  for (const name of WRITER_GROUPS) {
    const group = plan.drain[name];
    fields(group, ["state", "targets", "evidence"], `drain.${name}`);
    assert.ok(
      group.state === "stopped" || (name !== "api" && group.state === "absent"),
      `drain.${name} must be stopped or explicitly absent (API must be stopped)`,
    );
    text(group.evidence, `drain.${name}.evidence`);
    assert.ok(
      Array.isArray(group.targets) && group.targets.length <= 64,
      `drain.${name}.targets must be a bounded inventory`,
    );
    assert.equal(
      group.targets.length > 0,
      group.state === "stopped",
      `drain.${name} requires targets when stopped and an empty inventory when absent`,
    );
    for (const target of group.targets)
      text(target, `drain.${name}.target`, 200);
    assert.equal(
      new Set(group.targets).size,
      group.targets.length,
      `drain.${name} contains duplicate targets`,
    );
  }

  fields(
    plan.backup,
    ["sha256", "preChange", "completedAt", "evidence"],
    "backup",
  );
  assert.equal(
    plan.backup.sha256,
    backupSha256,
    "pre-change backup checksum mismatch",
  );
  assert.equal(
    plan.backup.preChange,
    true,
    "backup must be explicitly pre-change",
  );
  text(plan.backup.evidence, "backup.evidence");
  const completedAt = timestamp(plan.backup.completedAt, "backup.completedAt");
  assert.ok(
    drainedAt <= completedAt && completedAt <= approvedAt,
    "pre-change backup must complete after drain and before approval",
  );

  fields(
    plan.forwardFix,
    [
      "approved",
      "owner",
      "procedure",
      "writersRemainStopped",
      "automaticResume",
      "resumeCriteria",
    ],
    "forwardFix",
  );
  assert.equal(
    plan.forwardFix.approved,
    true,
    "forward-fix recovery is not approved",
  );
  text(plan.forwardFix.owner, "forwardFix.owner", 200);
  text(plan.forwardFix.procedure, "forwardFix.procedure");
  assert.equal(
    plan.forwardFix.writersRemainStopped,
    true,
    "all writers must remain stopped until verification",
  );
  assert.equal(
    plan.forwardFix.automaticResume,
    false,
    "automatic resume is forbidden",
  );
  fields(
    plan.forwardFix.resumeCriteria,
    RESUME_CRITERIA,
    "forwardFix.resumeCriteria",
  );
  for (const name of RESUME_CRITERIA)
    text(
      plan.forwardFix.resumeCriteria[name],
      `forwardFix.resumeCriteria.${name}`,
    );
  return plan;
}

function readRecordBytes(file, maxBytes, label) {
  const entry = lstatSync(file);
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    `${label} must be a regular non-symlink file`,
  );
  // Bound the actual read too, even if a file grows after stat. Nonblocking open
  // and the descriptor check also refuse a raced special file without hanging.
  const fd = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= maxBytes,
      `${label} must be a nonempty regular file at most 64 KiB`,
    );
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    assert.ok(size > 0 && size <= maxBytes, `${label} exceeds bounded size`);
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function parseRecord(bytes, label) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
}

export function loadRollbackApproval(
  env,
  {
    revision,
    rollbackRevision = env.RELEASE_ROLLBACK_REVISION,
    now = Date.now(),
  },
) {
  assert.equal(
    recoveryMode(env),
    "rollback",
    "rollback approval requires rollback mode",
  );
  const bytes = readRecordBytes(
    env.RELEASE_ROLLBACK_APPROVAL,
    ROLLBACK_APPROVAL_MAX_BYTES,
    "rollback approval",
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    env.RELEASE_ROLLBACK_APPROVAL_SHA256,
    "rollback approval checksum mismatch",
  );
  return validateRollbackApproval(parseRecord(bytes, "rollback approval"), {
    revision,
    rollbackRevision,
    now,
  });
}

export function loadMaintenancePlan(
  env,
  { revision, backupSha256, now = Date.now() },
) {
  assert.equal(
    recoveryMode(env),
    "maintenance-forward",
    "maintenance plan requires maintenance-forward mode",
  );
  const bytes = readRecordBytes(
    env.RELEASE_RECOVERY_PLAN,
    RECOVERY_PLAN_MAX_BYTES,
    "recovery plan",
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    env.RELEASE_RECOVERY_PLAN_SHA256,
    "recovery plan checksum mismatch",
  );
  const plan = parseRecord(bytes, "recovery plan");
  return validateMaintenancePlan(plan, {
    revision,
    backupSha256,
    now,
    trafficDrained: env.RELEASE_TRAFFIC_DRAINED,
  });
}
