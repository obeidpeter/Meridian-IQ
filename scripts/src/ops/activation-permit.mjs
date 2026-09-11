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

export const ACTIVATION_PERMIT_MAX_BYTES = 64 * 1024;
export const ACTIVATION_PERMIT_MAX_TTL_MS = 15 * 60_000;

const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH_BINDINGS = [
  "manifestSha256",
  "recoveryPlanSha256",
  "backupSha256",
  "heldEvidenceSha256",
];

function validateCatalogSource(value) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "activation catalogSource must be an object",
  );
  if (value.kind === "direct-database") {
    fields(value, ["kind"], "activation catalogSource");
    return;
  }
  fields(
    value,
    ["kind", "captureSha256"],
    "activation catalogSource",
  );
  assert.equal(
    value.kind,
    "credentialless-capture",
    "unsupported activation catalog source",
  );
  assert.match(
    value.captureSha256 ?? "",
    SHA256,
    "credentialless activation record requires approved capture SHA-256",
  );
}

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

function text(value, label, max = 200) {
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

function origin(value, label) {
  text(value, label, 2048);
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    `${label} requires HTTPS except for loopback tests`,
  );
  assert.equal(value, url.origin, `${label} must be a canonical origin only`);
}

// Bindings must come from verified artifacts and independently controlled target
// configuration, never from the permit being checked. This validates attestations
// and byte identity; the caller must verify held evidence/catalog/CI separately.
export function validateActivationPermit(
  permit,
  expected,
  { phase = "promotion", now = Date.now() } = {},
) {
  assert.ok(
    phase === "promotion" || phase === "runtime",
    "unknown activation validation phase",
  );
  assert.ok(Number.isSafeInteger(now), "now must be epoch milliseconds");
  fields(
    expected,
    ["revision", ...HASH_BINDINGS, "targetOrigin", "replId", "activationId"],
    "expected activation bindings",
  );
  assert.match(
    expected.revision ?? "",
    REVISION,
    "expected candidate must be a full SHA",
  );
  assert.match(
    expected.activationId ?? "",
    UUID,
    "expected activationId must be a canonical UUID",
  );
  origin(expected.targetOrigin, "expected targetOrigin");
  text(expected.replId, "expected replId");
  for (const name of HASH_BINDINGS)
    assert.match(
      expected[name] ?? "",
      SHA256,
      `expected ${name} must be a SHA-256`,
    );

  fields(
    permit,
    [
      "format",
      "mode",
      "activationId",
      "revision",
      ...HASH_BINDINGS,
      "catalogSource",
      "target",
      "approved",
      "approvedBy",
      "approvedAt",
      "expiresAt",
      "authorizeStartupWrites",
      "externalIngressAndSchedulesRemainHeld",
      "requirePostRunReadiness",
    ],
    "activation permit",
  );
  assert.equal(permit.format, 1, "unsupported activation permit format");
  assert.equal(
    permit.mode,
    "maintenance-forward",
    "activation permit mode mismatch",
  );
  assert.equal(
    permit.activationId,
    expected.activationId,
    "activationId mismatch",
  );
  assert.equal(
    permit.revision,
    expected.revision,
    "activation candidate mismatch",
  );
  for (const name of HASH_BINDINGS)
    assert.equal(permit[name], expected[name], `activation ${name} mismatch`);
  validateCatalogSource(permit.catalogSource);
  fields(permit.target, ["origin", "replId"], "activation target");
  assert.equal(
    permit.target.origin,
    expected.targetOrigin,
    "activation target origin mismatch",
  );
  assert.equal(
    permit.target.replId,
    expected.replId,
    "activation target replId mismatch",
  );
  assert.equal(permit.approved, true, "activation is not approved");
  text(permit.approvedBy, "activation approvedBy");
  assert.equal(
    permit.authorizeStartupWrites,
    true,
    "API startup writes require explicit approval",
  );
  assert.equal(
    permit.externalIngressAndSchedulesRemainHeld,
    true,
    "external ingress and schedules must remain held after RUN",
  );
  assert.equal(
    permit.requirePostRunReadiness,
    true,
    "actual API readiness must be verified after RUN",
  );

  const approvedAt = timestamp(permit.approvedAt, "activation approvedAt");
  const expiresAt = timestamp(permit.expiresAt, "activation expiresAt");
  assert.ok(
    expiresAt > approvedAt &&
      expiresAt - approvedAt <= ACTIVATION_PERMIT_MAX_TTL_MS,
    "activation approval window must be positive and at most 15 minutes",
  );
  assert.ok(approvedAt <= now, "activation approval is future-dated");
  if (phase === "promotion")
    assert.ok(now < expiresAt, "activation permit expired for promotion");

  // No consumption or single-use claim: repeated Publish within the window is
  // the same logical activation. Runtime admission remains valid on later cold
  // starts only while all independently trusted bindings still match. Revocation
  // and HOLD selection belong to the operator-controlled wrapper, not a TTL.
  // Runtime validation cannot prove a prior Publish took place: the Publish
  // path must always enforce promotion freshness before provisioning RUN.
  return permit;
}

function readPermitBytes(file) {
  text(file, "RELEASE_ACTIVATION_PERMIT", 4096);
  const entry = lstatSync(file);
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    "activation permit must be a regular non-symlink file",
  );
  const fd = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() &&
        stat.size > 0 &&
        stat.size <= ACTIVATION_PERMIT_MAX_BYTES,
      "activation permit must be a nonempty regular file at most 64 KiB",
    );
    // Do not trust stat alone if the file grows or is replaced during the read.
    const bytes = Buffer.alloc(ACTIVATION_PERMIT_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    assert.ok(
      size > 0 && size <= ACTIVATION_PERMIT_MAX_BYTES,
      "activation permit exceeds bounded size",
    );
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

// Only this loader verifies the independently supplied approval digest. It does
// not execute RUN, query a database, create a permit, or persist admission state.
export function loadActivationPermit(env, expected, options) {
  assert.equal(
    env.RELEASE_RECOVERY_MODE,
    "maintenance-forward",
    "activation requires maintenance-forward mode",
  );
  assert.match(
    env.RELEASE_ACTIVATION_PERMIT_SHA256 ?? "",
    SHA256,
    "independently trusted RELEASE_ACTIVATION_PERMIT_SHA256 is required",
  );
  assert.match(
    env.RELEASE_ACTIVATION_ID ?? "",
    UUID,
    "RELEASE_ACTIVATION_ID must be an independently configured canonical UUID",
  );
  assert.equal(
    expected?.activationId,
    env.RELEASE_ACTIVATION_ID,
    "expected activationId differs from RELEASE_ACTIVATION_ID",
  );
  const bytes = readPermitBytes(env.RELEASE_ACTIVATION_PERMIT);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    env.RELEASE_ACTIVATION_PERMIT_SHA256,
    "activation permit checksum mismatch",
  );
  let permit;
  try {
    permit = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error("activation permit must contain valid UTF-8 JSON");
  }
  return validateActivationPermit(permit, expected, options);
}
