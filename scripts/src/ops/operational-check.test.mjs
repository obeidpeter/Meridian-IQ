import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  operationalCheck,
  operationalCheckExitCode,
} from "./operational-check.mjs";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const SECRET = "private-fixture-signing-secret-123456789";
const env = {
  OPS_CHECK_BASE_URL: "https://approved.invalid",
  EXPECTED_BUILD_REVISION: "a".repeat(40),
  METRICS_KEY_ID: "fixture",
  METRICS_KEY_SECRET: SECRET,
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const metrics = () =>
  new Response(
    "# TYPE process_uptime_seconds gauge\nprocess_uptime_seconds 123.5\n",
    { headers: { "content-type": "text/plain; version=0.0.4" } },
  );
const fixture = (url, options) => {
  if (url.pathname === "/api/readyz") return json({ status: "ready" });
  if (url.pathname === "/api/healthz")
    return json({ status: "ok", buildRevision: env.EXPECTED_BUILD_REVISION });
  assert.equal(url.pathname, "/api/metrics");
  return options.headers["x-op-signature"]
    ? metrics()
    : json({ error: "unauthorized" }, 401);
};
const run = (environment = env, fetchImpl = fixture) =>
  operationalCheck(environment, { fetchImpl, now: () => NOW });

test("read-only checks verify revision and signed-only metrics without publishing secrets", async () => {
  const calls = [];
  const report = await run(env, (url, options) => {
    calls.push(url.pathname);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers["x-op-token"], undefined);
    if (options.headers["x-op-signature"]) {
      const timestamp = String(NOW / 1000);
      const bodyHash = createHash("sha256").update("").digest("hex");
      const signature = createHmac("sha256", SECRET)
        .update(`${timestamp}.GET./api/metrics.${bodyHash}`)
        .digest("hex");
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(options.headers).filter(([key]) =>
            key.startsWith("x-op-"),
          ),
        ),
        {
          "x-op-key-id": "fixture",
          "x-op-timestamp": timestamp,
          "x-op-signature": `v1=${signature}`,
        },
      );
    } else {
      assert.equal(options.headers["x-op-key-id"], undefined);
    }
    return fixture(url, options);
  });
  assert.deepEqual(calls, [
    "/api/readyz",
    "/api/healthz",
    "/api/metrics",
    "/api/metrics",
  ]);
  assert.equal(operationalCheckExitCode(report), 0);
  assert.equal(report.scope, "endpoint_checks_only");
  assert.ok(
    report.checks.every(
      (check) => check.lastSucceededAt === new Date(NOW).toISOString(),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-fixture|approved.invalid|x-op-|process_uptime_seconds/,
  );
});

test("missing target or independent revision and invalid config fail before any network call", async () => {
  for (const [override, code] of [
    [{ OPS_CHECK_BASE_URL: undefined }, "target_missing"],
    [{ EXPECTED_BUILD_REVISION: undefined }, "expected_revision_missing"],
    [
      { EXPECTED_BUILD_REVISION: "unknown" },
      "expected_revision_must_be_full_git_sha",
    ],
    [
      { EXPECTED_BUILD_REVISION: "aaaaaaa" },
      "expected_revision_must_be_full_git_sha",
    ],
    [
      { OPS_CHECK_BASE_URL: "https://user:secret@approved.invalid" },
      "invalid_target",
    ],
    [
      { OPS_CHECK_BASE_URL: "https://approved.invalid/api/internal/sweep" },
      "invalid_target",
    ],
    [
      { OPS_CHECK_BASE_URL: "https://approved.invalid/?secret=private" },
      "invalid_target",
    ],
    [
      { OPS_CHECK_BASE_URL: "https://approved.invalid/#private" },
      "invalid_target",
    ],
    [{ OPS_CHECK_BASE_URL: "http://approved.invalid" }, "invalid_target"],
    [{ OPS_CHECK_BASE_URL: "http://127.0.0.1" }, "invalid_target"],
    [{ OPS_CHECK_BASE_URL: "not-a-url" }, "invalid_target"],
    [{ OPS_CHECK_TIMEOUT_MS: "30001" }, "invalid_timeout"],
    [{ OPS_CHECK_TIMEOUT_MS: "0" }, "invalid_timeout"],
    [{ OPS_CHECK_METRICS_REQUIRED: "no" }, "invalid_boolean_setting"],
    [{ METRICS_KEY_SECRET: undefined }, "invalid_metrics_credentials"],
    [{ METRICS_KEY_SECRET: "short" }, "invalid_metrics_credentials"],
  ]) {
    const report = await run({ ...env, ...override }, () =>
      assert.fail("must not make a request"),
    );
    assert.equal(operationalCheckExitCode(report), 1);
    assert.equal(report.checks[0].code, code);
    assert.doesNotMatch(
      JSON.stringify(report),
      /user:secret|secret=private|private-fixture/,
    );
  }
});

test("explicit HTTP loopback opt-in permits only loopback fixtures", async () => {
  const report = await run({
    ...env,
    OPS_CHECK_BASE_URL: "http://127.0.0.1:9876",
    OPS_CHECK_ALLOW_HTTP_LOOPBACK: "1",
  });
  assert.equal(report.status, "passed");
  assert.equal(
    (
      await run({
        ...env,
        OPS_CHECK_BASE_URL: "http://external.invalid",
        OPS_CHECK_ALLOW_HTTP_LOOPBACK: "1",
      })
    ).status,
    "failed",
  );
});

test("missing metrics credentials fail by default; explicit optional omission is visibly skipped", async () => {
  const noKey = {
    ...env,
    METRICS_KEY_ID: undefined,
    METRICS_KEY_SECRET: undefined,
  };
  const required = await run(noKey);
  assert.equal(required.checks.at(-1).status, "missing");
  assert.equal(required.checks.at(-1).lastSucceededAt, null);
  assert.equal(operationalCheckExitCode(required), 1);
  const optional = await run({ ...noKey, OPS_CHECK_METRICS_REQUIRED: "false" });
  assert.equal(optional.checks.at(-1).status, "skipped");
  assert.equal(operationalCheckExitCode(optional), 0);
});

test("ring and legacy-secret configurations use signatures, malformed rings never fall back", async () => {
  for (const credentials of [
    { METRICS_KEYS: `rotate:${SECRET},next:${SECRET}` },
    { METRICS_TOKEN: SECRET },
  ]) {
    const report = await run(
      {
        ...env,
        METRICS_KEY_ID: undefined,
        METRICS_KEY_SECRET: undefined,
        ...credentials,
      },
      (url, options) => {
        assert.equal(options.headers["x-op-token"], undefined);
        if (options.headers["x-op-signature"])
          assert.equal(
            options.headers["x-op-key-id"],
            credentials.METRICS_KEYS ? "rotate" : "legacy",
          );
        return fixture(url, options);
      },
    );
    assert.equal(report.status, "passed");
  }
  for (const ring of [
    `one:${SECRET},one:${SECRET}`,
    `one:${SECRET},broken`,
    "one:short",
  ]) {
    const report = await run(
      {
        ...env,
        METRICS_KEY_ID: undefined,
        METRICS_KEY_SECRET: undefined,
        METRICS_KEYS: ring,
        METRICS_TOKEN: SECRET,
      },
      () => assert.fail("invalid ring"),
    );
    assert.equal(report.checks[0].code, "invalid_metrics_credentials");
  }
});

test("failed readiness, revision provenance, redirects and invalid bodies fail with sanitized codes", async () => {
  for (const [route, response, code] of [
    [
      "/api/readyz",
      () => json({ status: "unavailable", private: SECRET }),
      "not_ready",
    ],
    [
      "/api/readyz",
      () => json({ private: SECRET }, 503),
      "unexpected_http_status",
    ],
    [
      "/api/healthz",
      () => json({ status: "ok", buildRevision: "b".repeat(40) }),
      "revision_mismatch",
    ],
    [
      "/api/healthz",
      () => json({ status: "ok", buildRevision: SECRET }),
      "revision_evidence_missing",
    ],
    [
      "/api/readyz",
      () =>
        new Response(SECRET, {
          headers: { "content-type": "application/json" },
        }),
      "invalid_json_response",
    ],
    ["/api/readyz", () => new Response("login"), "invalid_json_response"],
    [
      "/api/readyz",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://private.invalid/${SECRET}` },
        }),
      "redirect_refused",
    ],
  ]) {
    const report = await run(env, (url, options) =>
      url.pathname === route ? response() : fixture(url, options),
    );
    assert.equal(operationalCheckExitCode(report), 1);
    assert.ok(report.checks.some((check) => check.code === code));
    assert.doesNotMatch(
      JSON.stringify(report),
      /private-fixture|private.invalid|login/,
    );
  }
});

test("public metrics, rejected signatures and non-metrics content cannot pass even in optional mode", async () => {
  for (const response of [
    () => metrics(),
    () => json({ error: SECRET }, 403),
    (_url, options) =>
      options.headers["x-op-signature"] ? new Response("login") : json({}, 401),
    (_url, options) =>
      options.headers["x-op-signature"]
        ? new Response("process_uptime_seconds NaN\n", {
            headers: { "content-type": "text/plain" },
          })
        : json({}, 401),
  ]) {
    const report = await run(
      { ...env, OPS_CHECK_METRICS_REQUIRED: "false" },
      (url, options) =>
        url.pathname === "/api/metrics"
          ? response(url, options)
          : fixture(url, options),
    );
    assert.equal(operationalCheckExitCode(report), 1);
    assert.equal(report.checks.at(-1).required, true);
    assert.equal(report.checks.at(-1).lastSucceededAt, null);
    assert.doesNotMatch(JSON.stringify(report), /private-fixture/);
  }
});

test("transport failures and advertised or streamed oversized responses are bounded and sanitized", async () => {
  for (const response of [
    () => {
      throw new Error(`private transport ${SECRET}`);
    },
    () =>
      new Response("", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    () => new Response("a".repeat(1024 * 1024 + 1)),
  ]) {
    const report = await run(env, (url, options) =>
      url.pathname === "/api/readyz" ? response() : fixture(url, options),
    );
    assert.equal(report.status, "failed");
    assert.ok(
      ["request_failed", "response_too_large"].includes(report.checks[0].code),
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /private transport|private-fixture/,
    );
  }
});

test("timeouts bound both response headers and a stalled body even when transport ignores abort", async () => {
  for (const response of [
    () => new Promise(() => {}),
    () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      }),
  ]) {
    let signal;
    const report = await run(
      { ...env, OPS_CHECK_TIMEOUT_MS: "10" },
      (url, options) => {
        if (url.pathname !== "/api/readyz") return fixture(url, options);
        signal = options.signal;
        return response();
      },
    );
    assert.equal(report.checks[0].code, "timeout");
    assert.equal(signal.aborted, true);
    assert.equal(report.status, "failed");
  }
});

test("CLI emits one sanitized JSON report and exits nonzero without a configured target", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./operational-check.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        OPS_CHECK_BASE_URL: "",
        METRICS_KEY_SECRET: SECRET,
      },
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks[0].code, "target_missing");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-fixture/);
});
