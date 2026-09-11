import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTIVATION_PERMIT_MAX_BYTES,
  ACTIVATION_PERMIT_MAX_TTL_MS,
  loadActivationPermit,
  validateActivationPermit,
} from "./activation-permit.mjs";

// Synthetic observations only; no fixture here authorizes any actual deployment.
const now = Date.parse("2026-09-05T12:00:00Z");
const bindings = {
  revision: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  recoveryPlanSha256: "c".repeat(64),
  backupSha256: "d".repeat(64),
  heldEvidenceSha256: "e".repeat(64),
  targetOrigin: "https://synthetic.example.invalid",
  replId: "synthetic-repl-id",
  activationId: "03a9d7ef-d433-42ce-a012-3a8f81268141",
};
const otherId = "37a206e5-269e-42e4-b84b-1f34520288fa";
const promotion = { phase: "promotion", now };
const runtime = { phase: "runtime", now };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  return {
    format: 1,
    mode: "maintenance-forward",
    activationId: bindings.activationId,
    revision: bindings.revision,
    manifestSha256: bindings.manifestSha256,
    recoveryPlanSha256: bindings.recoveryPlanSha256,
    backupSha256: bindings.backupSha256,
    heldEvidenceSha256: bindings.heldEvidenceSha256,
    catalogSource: { kind: "direct-database" },
    target: { origin: bindings.targetOrigin, replId: bindings.replId },
    approved: true,
    approvedBy: "synthetic-approver",
    approvedAt: "2026-09-05T11:55:00Z",
    expiresAt: "2026-09-05T12:10:00Z",
    authorizeStartupWrites: true,
    externalIngressAndSchedulesRemainHeld: true,
    requirePostRunReadiness: true,
  };
}

function permitFile(t, bytes = Buffer.from(JSON.stringify(fixture()))) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "meridian-activation-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic-permit.json");
  writeFileSync(file, bytes);
  return {
    RELEASE_RECOVERY_MODE: "maintenance-forward",
    RELEASE_ACTIVATION_ID: bindings.activationId,
    RELEASE_ACTIVATION_PERMIT: file,
    RELEASE_ACTIVATION_PERMIT_SHA256: digest(bytes),
  };
}

test("valid permit passes pure and trusted-file checks for both phases", (t) => {
  const permit = fixture();
  const env = permitFile(t);
  for (const options of [promotion, runtime]) {
    assert.equal(validateActivationPermit(permit, bindings, options), permit);
    assert.deepEqual(loadActivationPermit(env, bindings, options), permit);
  }
});

test("catalog source records direct database or only an approved credentialless capture hash", () => {
  assert.equal(
    validateActivationPermit(fixture(), bindings, promotion).catalogSource.kind,
    "direct-database",
  );
  const credentialless = fixture();
  credentialless.catalogSource = {
    kind: "credentialless-capture",
    captureSha256: "9".repeat(64),
  };
  assert.deepEqual(
    validateActivationPermit(credentialless, bindings, promotion).catalogSource,
    credentialless.catalogSource,
  );
  for (const mutate of [
    (source) => {
      source.credentials = "must-not-be-retained";
    },
    (source) => {
      source.catalog = {};
    },
    (source) => {
      source.captureSha256 = "9".repeat(63);
    },
  ]) {
    const permit = structuredClone(credentialless);
    mutate(permit.catalogSource);
    assert.throws(
      () => validateActivationPermit(permit, bindings, promotion),
      /missing or unknown|approved capture SHA-256/,
    );
  }
});

test("omitted phase defaults to promotion, never durable runtime admission", () => {
  const expired = Date.parse(fixture().expiresAt);
  assert.throws(
    () => validateActivationPermit(fixture(), bindings, { now: expired }),
    /expired for promotion/,
  );
  for (const phase of ["", "RUN", "hold", null, false])
    assert.throws(
      () => validateActivationPermit(fixture(), bindings, { phase, now }),
      /unknown activation validation phase/,
    );
});

test("15-minute maximum is exact and expiration is exclusive", () => {
  const permit = fixture();
  const approved = Date.parse(permit.approvedAt);
  assert.equal(
    Date.parse(permit.expiresAt) - approved,
    ACTIVATION_PERMIT_MAX_TTL_MS,
  );
  for (const time of [approved, approved + ACTIVATION_PERMIT_MAX_TTL_MS - 1])
    assert.equal(
      validateActivationPermit(permit, bindings, {
        phase: "promotion",
        now: time,
      }),
      permit,
    );
  assert.throws(
    () =>
      validateActivationPermit(permit, bindings, {
        phase: "promotion",
        now: approved + ACTIVATION_PERMIT_MAX_TTL_MS,
      }),
    /expired for promotion/,
  );
  permit.expiresAt = "2026-09-05T12:10:00.001Z";
  for (const options of [promotion, runtime])
    assert.throws(
      () => validateActivationPermit(permit, bindings, options),
      /at most 15 minutes/,
    );
});

test("later Autoscale cold starts retain admission but new promotion rejects expiry", (t) => {
  const env = permitFile(t);
  const later = now + 30 * 86400_000;
  assert.deepEqual(
    loadActivationPermit(env, bindings, { phase: "runtime", now: later }),
    fixture(),
  );
  assert.throws(
    () =>
      loadActivationPermit(env, bindings, { phase: "promotion", now: later }),
    /expired for promotion/,
  );
  assert.throws(
    () =>
      loadActivationPermit(
        { ...env, RELEASE_ACTIVATION_ID: otherId },
        { ...bindings, activationId: otherId },
        { phase: "runtime", now: later },
      ),
    /activationId mismatch/,
  );
  assert.throws(
    () =>
      loadActivationPermit(
        env,
        { ...bindings, revision: "f".repeat(40) },
        { phase: "runtime", now: later },
      ),
    /candidate mismatch/,
  );
});

test("same active permit can repeat Publish as the same logical activation, without consumption", (t) => {
  const env = permitFile(t);
  const before = readFileSync(env.RELEASE_ACTIVATION_PERMIT);
  const first = loadActivationPermit(env, bindings, promotion);
  const second = loadActivationPermit(env, bindings, {
    ...promotion,
    now: now + 60_000,
  });
  assert.deepEqual(first, second);
  assert.equal(second.activationId, bindings.activationId);
  assert.deepEqual(readFileSync(env.RELEASE_ACTIVATION_PERMIT), before);
  assert.deepEqual(loadActivationPermit(env, bindings, runtime), first);
});

for (const name of [
  "revision",
  "manifestSha256",
  "recoveryPlanSha256",
  "backupSha256",
  "heldEvidenceSha256",
  "activationId",
]) {
  test(`exact ${name} binding remains mandatory in both phases`, () => {
    const different =
      name === "activationId"
        ? otherId
        : "f".repeat(name === "revision" ? 40 : 64);
    for (const options of [promotion, runtime]) {
      const permit = { ...fixture(), [name]: different };
      assert.throws(
        () => validateActivationPermit(permit, bindings, options),
        /mismatch/,
      );
      assert.throws(
        () =>
          validateActivationPermit(
            fixture(),
            { ...bindings, [name]: different },
            options,
          ),
        /mismatch/,
      );
    }
  });
}

for (const [field, binding, different] of [
  ["origin", "targetOrigin", "https://other.example.invalid"],
  ["replId", "replId", "other-repl"],
]) {
  test(`target ${field} cannot be replayed across deployments`, () => {
    for (const options of [promotion, runtime]) {
      const permit = fixture();
      permit.target[field] = different;
      assert.throws(
        () => validateActivationPermit(permit, bindings, options),
        /target .* mismatch/,
      );
      assert.throws(
        () =>
          validateActivationPermit(
            fixture(),
            { ...bindings, [binding]: different },
            options,
          ),
        /target .* mismatch/,
      );
    }
  });
}

const invalidPermits = [
  [
    "unsupported format",
    (p) => {
      p.format = 2;
    },
    /unsupported/,
  ],
  [
    "rollback permit",
    (p) => {
      p.mode = "rollback";
    },
    /mode mismatch/,
  ],
  [
    "unapproved activation",
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
    "oversized approver",
    (p) => {
      p.approvedBy = "a".repeat(201);
    },
    /bounded text/,
  ],
  [
    "control characters",
    (p) => {
      p.approvedBy = "approver\nforged";
    },
    /control characters/,
  ],
  [
    "no startup-write authorization",
    (p) => {
      p.authorizeStartupWrites = false;
    },
    /startup writes/,
  ],
  [
    "string startup-write authorization",
    (p) => {
      p.authorizeStartupWrites = "true";
    },
    /startup writes/,
  ],
  [
    "early ingress or schedule resume",
    (p) => {
      p.externalIngressAndSchedulesRemainHeld = false;
    },
    /remain held/,
  ],
  [
    "no post-RUN readiness",
    (p) => {
      p.requirePostRunReadiness = false;
    },
    /readiness/,
  ],
  [
    "future approval",
    (p) => {
      p.approvedAt = "2026-09-05T12:00:01Z";
    },
    /future-dated/,
  ],
  [
    "zero TTL",
    (p) => {
      p.expiresAt = p.approvedAt;
    },
    /positive/,
  ],
  [
    "negative TTL",
    (p) => {
      p.expiresAt = "2026-09-05T11:54:59Z";
    },
    /positive/,
  ],
  [
    "unbounded TTL",
    (p) => {
      p.expiresAt = "2026-09-06T12:00:00Z";
    },
    /at most 15 minutes/,
  ],
  [
    "invalid approval date",
    (p) => {
      p.approvedAt = "2026-02-30T11:55:00Z";
    },
    /valid timestamp/,
  ],
  [
    "invalid expiry date",
    (p) => {
      p.expiresAt = "2026-02-30T12:10:00Z";
    },
    /valid timestamp/,
  ],
  [
    "ambiguous approval time",
    (p) => {
      p.approvedAt = "2026-09-05 11:55:00";
    },
    /UTC timestamp/,
  ],
  [
    "missing expiry",
    (p) => {
      delete p.expiresAt;
    },
    /missing or unknown/,
  ],
  [
    "unknown override",
    (p) => {
      p.skipVerification = true;
    },
    /missing or unknown/,
  ],
  [
    "unknown target field",
    (p) => {
      p.target.deploymentId = "invented-id";
    },
    /missing or unknown/,
  ],
  [
    "missing catalog source",
    (p) => {
      delete p.catalogSource;
    },
    /missing or unknown/,
  ],
];
for (const [name, mutate, pattern] of invalidPermits) {
  test(`rejects ${name}, including runtime admission`, () => {
    const permit = fixture();
    mutate(permit);
    for (const options of [promotion, runtime])
      assert.throws(
        () => validateActivationPermit(permit, bindings, options),
        pattern,
      );
  });
}

test("malformed or missing independent bindings refuse before admission", () => {
  for (const key of Object.keys(bindings)) {
    const expected = { ...bindings };
    delete expected[key];
    assert.throws(
      () => validateActivationPermit(fixture(), expected, promotion),
      /missing or unknown/,
    );
    expected[key] = "";
    assert.throws(() =>
      validateActivationPermit(fixture(), expected, promotion),
    );
  }
  for (const value of [undefined, null, [], "approved"])
    assert.throws(
      () => validateActivationPermit(value, bindings, promotion),
      /must be an object/,
    );
  for (const time of [NaN, Infinity, "2026-09-05", 1.5])
    assert.throws(
      () =>
        validateActivationPermit(fixture(), bindings, {
          phase: "runtime",
          now: time,
        }),
      /epoch milliseconds/,
    );
});

test("target origin rejects aliases, credentials, paths, queries and remote HTTP", () => {
  for (const targetOrigin of [
    "https://synthetic.example.invalid/",
    "https://synthetic.example.invalid/api",
    "https://user:password@synthetic.example.invalid",
    "https://synthetic.example.invalid?x=1",
    "https://synthetic.example.invalid#fragment",
    "https://SYNTHETIC.EXAMPLE.INVALID",
    "https://synthetic.example.invalid:443",
    "http://synthetic.example.invalid",
    "file:///tmp/test",
  ]) {
    const permit = fixture();
    permit.target.origin = targetOrigin;
    assert.throws(
      () =>
        validateActivationPermit(
          permit,
          { ...bindings, targetOrigin },
          promotion,
        ),
      /canonical origin|requires HTTPS/,
    );
  }
  for (const targetOrigin of [
    "http://localhost:4100",
    "http://127.0.0.1:4100",
    "http://[::1]:4100",
  ]) {
    const permit = fixture();
    permit.target.origin = targetOrigin;
    assert.equal(
      validateActivationPermit(
        permit,
        { ...bindings, targetOrigin },
        promotion,
      ),
      permit,
    );
  }
});

test("loader never infers maintenance mode, trusted digest or control-plane activation ID", (t) => {
  const env = permitFile(t);
  for (const mode of [undefined, "", "rollback", "other"])
    assert.throws(
      () =>
        loadActivationPermit(
          { ...env, RELEASE_RECOVERY_MODE: mode },
          bindings,
          promotion,
        ),
      /requires maintenance-forward/,
    );
  for (const hash of [undefined, "", "auto", "b".repeat(63)])
    assert.throws(
      () =>
        loadActivationPermit(
          { ...env, RELEASE_ACTIVATION_PERMIT_SHA256: hash },
          bindings,
          runtime,
        ),
      /independently trusted/,
    );
  for (const activationId of [
    undefined,
    "",
    "host-deployment-id",
    "00000000-0000-0000-0000-000000000000",
  ])
    assert.throws(
      () =>
        loadActivationPermit(
          { ...env, RELEASE_ACTIVATION_ID: activationId },
          bindings,
          runtime,
        ),
      /independently configured canonical UUID/,
    );
  assert.throws(
    () =>
      loadActivationPermit(
        { ...env, RELEASE_ACTIVATION_ID: otherId },
        bindings,
        runtime,
      ),
    /differs from RELEASE_ACTIVATION_ID/,
  );
  assert.throws(
    () =>
      loadActivationPermit(
        env,
        { ...bindings, activationId: otherId },
        runtime,
      ),
    /differs from RELEASE_ACTIVATION_ID/,
  );
});

test("loader requires a trusted hash of exact bytes, including on late cold starts", (t) => {
  const env = permitFile(t);
  const late = { phase: "runtime", now: now + 86400_000 };
  assert.throws(
    () =>
      loadActivationPermit(
        { ...env, RELEASE_ACTIVATION_PERMIT_SHA256: "f".repeat(64) },
        bindings,
        late,
      ),
    /checksum mismatch/,
  );
  writeFileSync(
    env.RELEASE_ACTIVATION_PERMIT,
    JSON.stringify(fixture(), null, 2),
  );
  assert.throws(
    () => loadActivationPermit(env, bindings, late),
    /checksum mismatch/,
  );
});

test("loader validates content, not only the approved hash", (t) => {
  const permit = fixture();
  permit.authorizeStartupWrites = false;
  const env = permitFile(t, Buffer.from(JSON.stringify(permit)));
  assert.throws(
    () => loadActivationPermit(env, bindings, promotion),
    /startup writes/,
  );
  assert.throws(
    () => loadActivationPermit(env, bindings, runtime),
    /startup writes/,
  );
});

test("loader bounds file reads and refuses absent, non-file, empty and invalid JSON", (t) => {
  const env = permitFile(t);
  for (const file of [undefined, ""])
    assert.throws(
      () =>
        loadActivationPermit(
          { ...env, RELEASE_ACTIVATION_PERMIT: file },
          bindings,
          runtime,
        ),
      /RELEASE_ACTIVATION_PERMIT/,
    );
  assert.throws(
    () =>
      loadActivationPermit(
        {
          ...env,
          RELEASE_ACTIVATION_PERMIT: `${env.RELEASE_ACTIVATION_PERMIT}.missing`,
        },
        bindings,
        runtime,
      ),
    /ENOENT/,
  );
  assert.throws(
    () =>
      loadActivationPermit(
        {
          ...env,
          RELEASE_ACTIVATION_PERMIT: path.dirname(
            env.RELEASE_ACTIVATION_PERMIT,
          ),
        },
        bindings,
        runtime,
      ),
    /regular non-symlink file/,
  );
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(ACTIVATION_PERMIT_MAX_BYTES + 1),
  ])
    assert.throws(
      () => loadActivationPermit(permitFile(t, bytes), bindings, runtime),
      /at most 64 KiB/,
    );
  for (const bytes of [
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.from("\ufeff{}"),
  ])
    assert.throws(
      () => loadActivationPermit(permitFile(t, bytes), bindings, runtime),
      /valid UTF-8 JSON/,
    );
  const maximum = Buffer.alloc(ACTIVATION_PERMIT_MAX_BYTES, " ");
  maximum.write(JSON.stringify(fixture()));
  assert.deepEqual(
    loadActivationPermit(permitFile(t, maximum), bindings, runtime),
    fixture(),
  );
});
