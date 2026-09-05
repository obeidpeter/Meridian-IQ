import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest } from "./build-manifest.mjs";
import {
  maintenanceIdentity,
  maintenanceResponse,
  startMaintenanceServer,
} from "./maintenance-server.mjs";
import {
  loadHeldEvidence,
  postdeploy,
  validateHeldEvidence,
  verifyDeployment,
  verifyHeldDeployment,
} from "./postdeploy.mjs";

const revision = "a".repeat(40);
const catalog = {
  postgresMajor: 16,
  role: {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolcanlogin: false,
    schema_create: false,
  },
  memberships: [],
  tables: [
    {
      name: "invoices",
      rls: true,
      forced: true,
      app_owner: false,
      columns: ["firm_id"],
      grants: ["SELECT"],
    },
  ],
  columns: [{ table_name: "invoices", column_name: "firm_id" }],
  policies: [
    {
      tablename: "invoices",
      qual: "firm_id = current_setting('app.firm_id')::uuid",
    },
  ],
  triggers: [
    {
      table_name: "invoices",
      name: "guard",
      enabled: "O",
      definition: "BEFORE UPDATE",
    },
  ],
  functions: [{ name: "guard", definition: "RAISE EXCEPTION" }],
  constraints: [
    {
      name: "positive",
      validated: true,
      definition: "CHECK (content_revision > 0)",
    },
  ],
  indexes: [
    {
      name: "unique_line",
      valid: true,
      ready: true,
      definition:
        "CREATE UNIQUE INDEX unique_line ON public.invoices USING btree (firm_id)",
    },
  ],
  migrations: [{ version: 54, name: "import_runs" }],
};

function fixture(t) {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "meridian-postdeploy-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith("meridian-postdeploy-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const stopped = (name) => ({
    state: "stopped",
    targets: [name],
    evidence: "Synthetic stopped-writer observation",
  });
  const plan = {
    format: 1,
    mode: "maintenance-forward",
    revision,
    approved: true,
    approvedBy: "synthetic-approver",
    approvedAt: at(-1),
    window: { start: at(-30), end: at(60) },
    drain: {
      confirmedBy: "synthetic-operator",
      confirmedAt: at(-20),
      api: stopped("api"),
      workers: stopped("workers"),
      schedules: stopped("schedules"),
      otherWriters: {
        state: "absent",
        targets: [],
        evidence: "Synthetic inventory",
      },
    },
    backup: {
      sha256: "b".repeat(64),
      preChange: true,
      completedAt: at(-15),
      evidence: "Synthetic archive",
    },
    forwardFix: {
      approved: true,
      owner: "synthetic-owner",
      procedure: "Review offline forward fix",
      writersRemainStopped: true,
      automaticResume: false,
      resumeCriteria: {
        artifactIdentity: "Exact artifact",
        migrationIntegrity: "Retained migrations",
        securityCatalog: "Catalog parity",
        applicationChecks: "Recovery checks",
        operatorSignoff: "Explicit signoff",
      },
    },
  };
  const manifest = {
    format: 1,
    source: { revision },
    ci: { runId: "123", repository: "fixture/repository" },
    contractVersion: "fixture-contract",
    database: catalog,
    assets: [
      {
        file: "artifacts/landing/dist/public/index.html",
        url: "/index.html",
        sha256: digest("immutable page"),
      },
    ],
    mobile: {
      format: 1,
      domain: "fixture.invalid",
      basePath: "/mobile/",
      replId: null,
    },
  };
  const env = {
    RELEASE_MANIFEST: path.join(root, "manifest.json"),
    RELEASE_MANIFEST_SHA256: digest(JSON.stringify(manifest)),
    RELEASE_RUNTIME_STATE: "HOLD",
    RELEASE_RECOVERY_MODE: "maintenance-forward",
    RELEASE_TRAFFIC_DRAINED: "1",
    RELEASE_RECOVERY_PLAN: path.join(root, "plan.json"),
    RELEASE_RECOVERY_PLAN_SHA256: digest(JSON.stringify(plan)),
    RELEASE_BASE_URL: "https://fixture.invalid",
    REPL_ID: "11111111-1111-4111-8111-111111111111",
    RELEASE_BACKUP_SHA256: plan.backup.sha256,
    DATABASE_URL: "postgres://localhost/synthetic-only",
  };
  writeFileSync(env.RELEASE_MANIFEST, JSON.stringify(manifest));
  writeFileSync(env.RELEASE_RECOVERY_PLAN, JSON.stringify(plan));
  const identity = maintenanceIdentity(manifest, env);
  const output = path.join(root, "held-evidence.json");
  const fetcher = async (url, options) => {
    assert.equal(url.origin, env.RELEASE_BASE_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    if (url.pathname.startsWith("/api/"))
      return Response.json(maintenanceResponse(identity), {
        status: url.pathname === "/api/healthz" ? 200 : 503,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    assert.equal(url.pathname, "/index.html");
    return new Response("immutable page");
  };
  const deps = { catalog: () => structuredClone(catalog), fetcher };
  return { root, manifest, plan, env, identity, output, deps, fetcher };
}

test("held verification emits honest independently hashable evidence only after all checks", async (t) => {
  const f = fixture(t);
  const evidence = await postdeploy(
    ["--held", "--evidence-out", f.output],
    f.env,
    f.deps,
  );
  assert.equal(evidence.apiReadinessVerified, false);
  assert.equal(evidence.kind, "held-verification");
  assert.ok(
    Object.values(evidence.checks).every((checked) => checked === true),
  );
  const bytes = readFileSync(f.output);
  const env = {
    ...f.env,
    RELEASE_HELD_EVIDENCE: f.output,
    RELEASE_HELD_EVIDENCE_SHA256: digest(bytes),
  };
  assert.deepEqual(loadHeldEvidence(env, f.manifest), evidence);
  assert.throws(
    () =>
      loadHeldEvidence(
        { ...env, RELEASE_HELD_EVIDENCE_SHA256: undefined },
        f.manifest,
      ),
    /independently trusted/,
  );
  assert.throws(
    () =>
      loadHeldEvidence(
        { ...env, RELEASE_HELD_EVIDENCE_SHA256: "0".repeat(64) },
        f.manifest,
      ),
    /checksum mismatch/,
  );
  await assert.rejects(
    postdeploy(["--held", "--evidence-out", f.output], f.env, f.deps),
    /EEXIST/,
  );
  assert.deepEqual(
    readFileSync(f.output),
    bytes,
    "existing evidence is not overwritten",
  );
});

test("held probes use a real builtins HTTP server while immutable sibling assets stay separate", async (t) => {
  const f = fixture(t);
  const server = await startMaintenanceServer(f.identity, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = "http://127.0.0.1:" + server.address().port;
  const fetcher = (url, options) =>
    url.pathname.startsWith("/api/")
      ? fetch(new URL(url.pathname, origin), options)
      : f.fetcher(url, options);
  await verifyHeldDeployment(
    f.env.RELEASE_BASE_URL,
    f.manifest,
    f.identity,
    fetcher,
  );
  await assert.rejects(
    verifyDeployment(f.env.RELEASE_BASE_URL, f.manifest, fetcher),
    /API liveness failed/,
  );
  const response = await fetch(origin + "/api/readyz");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  for (const request of [
    "CONNECT localhost:80 HTTP/1.1\r\nHost: localhost\r\n\r\n",
    "GET /api/healthz HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  ]) {
    const received = await new Promise((resolve, reject) => {
      const socket = connect(server.address().port, "127.0.0.1");
      let bytes = "";
      socket.setTimeout(2000, () =>
        socket.destroy(new Error("socket timeout")),
      );
      socket.on("error", reject);
      socket.on("connect", () => socket.write(request));
      socket.on("data", (chunk) => {
        bytes += chunk;
      });
      socket.on("end", () => resolve(bytes));
    });
    assert.match(received, /^HTTP\/1.1 503/);
  }
});

test("held verification rejects running API, ready responses, permissive business routes and cached health", async (t) => {
  const f = fixture(t);
  const cases = [
    {
      route: "/api/healthz",
      body: {
        status: "ok",
        buildRevision: revision,
        contractVersion: f.manifest.contractVersion,
      },
    },
    {
      route: "/api/healthz",
      body: { ...maintenanceResponse(f.identity), apiImported: true },
    },
    {
      route: "/api/healthz",
      body: {
        ...maintenanceResponse(f.identity),
        buildRevision: "f".repeat(40),
      },
    },
    {
      route: "/api/healthz",
      body: {
        ...maintenanceResponse(f.identity),
        manifestSha256: "f".repeat(64),
      },
    },
    {
      route: "/api/healthz",
      body: {
        ...maintenanceResponse(f.identity),
        target: { origin: "https://elsewhere.invalid", replId: f.env.REPL_ID },
      },
    },
    { route: "/api/healthz", headers: {} },
    { route: "/api/readyz", status: 200 },
    { route: "/api/invoices", status: 401 },
    { route: "/api/__maintenance_probe__", status: 404 },
    { route: "/index.html", asset: "stale page" },
  ];
  for (const change of cases) {
    const fetcher = async (url, options) => {
      if (url.pathname !== change.route) return f.fetcher(url, options);
      if (change.asset) return new Response(change.asset);
      return Response.json(change.body ?? maintenanceResponse(f.identity), {
        status: change.status ?? (url.pathname === "/api/healthz" ? 200 : 503),
        headers: change.headers ?? { "cache-control": "no-store" },
      });
    };
    await assert.rejects(
      postdeploy(["--held", "--evidence-out", f.output], f.env, {
        ...f.deps,
        fetcher,
      }),
    );
    assert.equal(
      existsSync(f.output),
      false,
      "failed checks must not emit evidence",
    );
  }
});

test("held catalog, CI, recovery-plan and target failures cannot emit evidence", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    postdeploy(["--held", "--evidence-out", f.output], f.env, {
      catalog: () => {
        const bad = structuredClone(catalog);
        bad.triggers[0].enabled = "D";
        return bad;
      },
      fetcher: () => assert.fail("catalog failure must precede network probes"),
    }),
    /trigger disabled/,
  );
  for (const changes of [
    { RELEASE_RECOVERY_PLAN_SHA256: "0".repeat(64) },
    { RELEASE_BACKUP_SHA256: "0".repeat(64) },
    { RELEASE_BASE_URL: "https://elsewhere.invalid" },
    { RELEASE_RUNTIME_STATE: "RUN" },
    { RELEASE_TRAFFIC_DRAINED: "0" },
  ]) {
    await assert.rejects(
      postdeploy(
        ["--held", "--evidence-out", f.output],
        { ...f.env, ...changes },
        f.deps,
      ),
    );
    assert.equal(existsSync(f.output), false);
  }
  const bad = {
    ...f.manifest,
    ci: { runId: "not-a-run", repository: "fixture/repository" },
  };
  const bytes = JSON.stringify(bad);
  writeFileSync(f.env.RELEASE_MANIFEST, bytes);
  await assert.rejects(
    postdeploy(
      ["--held", "--evidence-out", f.output],
      {
        ...f.env,
        RELEASE_MANIFEST_SHA256: digest(bytes),
      },
      f.deps,
    ),
    /CI run identity/,
  );
  assert.equal(existsSync(f.output), false);
});

test("ordinary postdeploy is real API readiness only after explicit RUN and keeps ingress held", async (t) => {
  const f = fixture(t);
  await assert.rejects(postdeploy([], f.env, f.deps), /explicit RUN/);
  const runEnv = {
    ...f.env,
    RELEASE_RUNTIME_STATE: "RUN",
    RELEASE_ACTIVATION_ID: "22222222-2222-4222-8222-222222222222",
    RELEASE_HELD_EVIDENCE_SHA256: "c".repeat(64),
    RELEASE_ACTIVATION_PERMIT: path.join(f.root, "activation-permit.json"),
  };
  // A selected, already admitted deployment remains verifiable after TTL; this
  // synthetic permit is test data, not a claim about a real Publish or backup.
  const permit = {
    format: 1,
    mode: "maintenance-forward",
    activationId: runEnv.RELEASE_ACTIVATION_ID,
    revision,
    manifestSha256: runEnv.RELEASE_MANIFEST_SHA256,
    target: f.identity.target,
    recoveryPlanSha256: runEnv.RELEASE_RECOVERY_PLAN_SHA256,
    backupSha256: runEnv.RELEASE_BACKUP_SHA256,
    heldEvidenceSha256: runEnv.RELEASE_HELD_EVIDENCE_SHA256,
    approved: true,
    approvedBy: "synthetic-approver",
    approvedAt: new Date(Date.now() - 7 * 86400_000).toISOString(),
    expiresAt: new Date(Date.now() - 7 * 86400_000 + 10 * 60_000).toISOString(),
    authorizeStartupWrites: true,
    externalIngressAndSchedulesRemainHeld: true,
    requirePostRunReadiness: true,
  };
  const bytes = JSON.stringify(permit);
  writeFileSync(runEnv.RELEASE_ACTIVATION_PERMIT, bytes);
  runEnv.RELEASE_ACTIVATION_PERMIT_SHA256 = digest(bytes);
  for (const changes of [
    { RELEASE_BASE_URL: "https://wrong.invalid" },
    { REPL_ID: "wrong-target" },
    { RELEASE_ACTIVATION_ID: "33333333-3333-4333-8333-333333333333" },
    { RELEASE_ACTIVATION_PERMIT_SHA256: undefined },
    { RELEASE_ACTIVATION_PERMIT: undefined },
    { RELEASE_TRAFFIC_DRAINED: "0" },
    { RELEASE_RECOVERY_MODE: "rollback" },
    { RELEASE_BACKUP_SHA256: "0".repeat(64) },
    { RELEASE_HELD_EVIDENCE_SHA256: "0".repeat(64) },
  ]) {
    let touched = false;
    await assert.rejects(
      postdeploy(
        [],
        { ...runEnv, ...changes },
        {
          catalog: () => {
            touched = true;
            return catalog;
          },
          fetcher: () => {
            touched = true;
            return f.fetcher();
          },
        },
      ),
    );
    assert.equal(
      touched,
      false,
      "invalid admission must fail before catalog or HTTP IO",
    );
  }
  const fetcher = async (url) => {
    if (url.pathname === "/api/healthz")
      return Response.json({
        status: "ok",
        buildRevision: revision,
        contractVersion: f.manifest.contractVersion,
      });
    if (url.pathname === "/api/readyz")
      return Response.json({ status: "ready" });
    return new Response("immutable page");
  };
  await postdeploy([], runEnv, { ...f.deps, fetcher });
  assert.equal(
    existsSync(f.output),
    false,
    "RUN readiness is not held evidence",
  );
  const forged = async (url, options) =>
    url.pathname === "/api/healthz"
      ? Response.json({ ...maintenanceResponse(f.identity), status: "ok" })
      : fetcher(url, options);
  await assert.rejects(
    verifyDeployment(f.env.RELEASE_BASE_URL, f.manifest, forged),
    /not real API readiness/,
  );
});

test("invalid postdeploy actions fail before any IO", async () => {
  for (const args of [
    ["--resume"],
    ["--held"],
    ["--held", "--evidence-out"],
    ["--run"],
    ["--held", "--evidence-out", "file", "--skip-ready"],
    ["--evidence-out", "file"],
    ["--held", "--output", "file"],
  ])
    await assert.rejects(
      postdeploy(
        args,
        {},
        {
          catalog: () => assert.fail("invalid actions must not query"),
          fetcher: () => assert.fail("invalid actions must not fetch"),
        },
      ),
      /use postdeploy/,
    );
});

test("held evidence rejects stale/future time, all scope changes, omitted checks and fake API readiness", async (t) => {
  const f = fixture(t);
  const evidence = await postdeploy(
    ["--held", "--evidence-out", f.output],
    f.env,
    f.deps,
  );
  for (const mutate of [
    (value) => {
      value.revision = "f".repeat(40);
    },
    (value) => {
      value.manifestSha256 = "f".repeat(64);
    },
    (value) => {
      value.recoveryPlanSha256 = "f".repeat(64);
    },
    (value) => {
      value.backupSha256 = "f".repeat(64);
    },
    (value) => {
      value.target.replId = "wrong-target";
    },
    (value) => {
      value.target.extra = "unknown";
    },
    (value) => {
      value.verifiedAt = "2000-01-01T00:00:00.000Z";
    },
    (value) => {
      value.verifiedAt = "2999-01-01T00:00:00.000Z";
    },
    (value) => {
      value.verifiedAt = "2026-02-30T00:00:00.000Z";
    },
    (value) => {
      delete value.checks.businessRejected;
    },
    (value) => {
      value.apiReadinessVerified = true;
    },
    (value) => {
      value.extra = true;
    },
  ]) {
    const copy = structuredClone(evidence);
    mutate(copy);
    assert.throws(() => validateHeldEvidence(copy, f.identity));
  }
  const env = { ...f.env, RELEASE_HELD_EVIDENCE: f.output };
  for (const bytes of [
    Buffer.from("{}"),
    Buffer.alloc(16 * 1024 + 1),
    Buffer.from([0xff]),
    Buffer.from("\ufeff{}"),
  ]) {
    writeFileSync(f.output, bytes);
    env.RELEASE_HELD_EVIDENCE_SHA256 = digest(bytes);
    assert.throws(() => loadHeldEvidence(env, f.manifest));
  }
});

test("manifest asset URLs cannot redirect probes outside the selected target", async (t) => {
  const f = fixture(t);
  for (const url of [
    "//elsewhere.invalid/steal",
    "/\\elsewhere.invalid/steal",
    "https://elsewhere.invalid/steal",
  ]) {
    const manifest = {
      ...f.manifest,
      assets: [{ ...f.manifest.assets[0], url }],
    };
    await assert.rejects(
      verifyHeldDeployment(
        f.env.RELEASE_BASE_URL,
        manifest,
        f.identity,
        f.fetcher,
      ),
      /invalid asset URL/,
    );
  }
});
