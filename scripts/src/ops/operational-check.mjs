// Read-only endpoint verification. No database, provider, sweep or recovery writes.
import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REVISION = /^[a-f0-9]{40}$/i;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

class CheckFailure extends Error {
  constructor(code, status = "failed") {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function booleanSetting(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new CheckFailure("invalid_boolean_setting");
}

function metricsKey(env) {
  const id = env.METRICS_KEY_ID?.trim();
  const secret = env.METRICS_KEY_SECRET?.trim();
  const validate = (key) => {
    if (
      !KEY_ID.test(key.id ?? "") ||
      typeof key.secret !== "string" ||
      key.secret.length < 32
    )
      throw new CheckFailure("invalid_metrics_credentials");
    return key;
  };
  if (id || secret) return validate({ id, secret });
  if (env.METRICS_KEYS?.trim()) {
    const keys = env.METRICS_KEYS.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new CheckFailure("invalid_metrics_credentials");
      return validate({
        id: entry.slice(0, separator).trim(),
        secret: entry.slice(separator + 1).trim(),
      });
    });
    if (new Set(keys.map((key) => key.id)).size !== keys.length)
      throw new CheckFailure("invalid_metrics_credentials");
    return keys[0];
  }
  // The legacy secret can still sign requests; never send a plain x-op-token.
  return env.METRICS_TOKEN
    ? validate({ id: "legacy", secret: env.METRICS_TOKEN })
    : null;
}

function configuration(env) {
  if (!env.OPS_CHECK_BASE_URL?.trim())
    throw new CheckFailure("target_missing", "missing");
  let url;
  try {
    url = new URL(env.OPS_CHECK_BASE_URL);
  } catch {
    throw new CheckFailure("invalid_target");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localHttp =
    url.protocol === "http:" &&
    loopback &&
    env.OPS_CHECK_ALLOW_HTTP_LOOPBACK === "1";
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new CheckFailure("invalid_target");
  const revision = env.EXPECTED_BUILD_REVISION?.trim();
  if (!revision) throw new CheckFailure("expected_revision_missing", "missing");
  if (!REVISION.test(revision))
    throw new CheckFailure("expected_revision_must_be_full_git_sha");
  const timeoutMs =
    env.OPS_CHECK_TIMEOUT_MS === undefined
      ? 10_000
      : Number(env.OPS_CHECK_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new CheckFailure("invalid_timeout");
  const metricsRequired = booleanSetting(env.OPS_CHECK_METRICS_REQUIRED, true);
  return {
    origin: url.origin,
    revision,
    timeoutMs,
    metricsRequired,
    key: metricsKey(env),
  };
}

function signedMetricsHeaders(key, now) {
  const timestamp = String(Math.floor(now() / 1000));
  const bodyHash = createHash("sha256").update("").digest("hex");
  const signature = createHmac("sha256", key.secret)
    .update(`${timestamp}.GET./api/metrics.${bodyHash}`)
    .digest("hex");
  return {
    "x-op-key-id": key.id,
    "x-op-timestamp": timestamp,
    "x-op-signature": `v1=${signature}`,
  };
}

async function boundedRequest(
  config,
  route,
  fetchImpl,
  headers = {},
  acceptedStatuses = [200],
) {
  const controller = new AbortController();
  let timer;
  // Race the entire body read too, even if a misbehaving transport ignores abort.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckFailure("timeout"));
    }, config.timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchImpl(new URL(route, config.origin), {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
          headers: { "cache-control": "no-cache", ...headers },
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new CheckFailure("timeout");
        }
        if (response.status >= 300 && response.status < 400)
          throw new CheckFailure("redirect_refused");
        if (!acceptedStatuses.includes(response.status))
          throw new CheckFailure("unexpected_http_status");
        if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
          throw new CheckFailure("response_too_large");
        const reader = response.body?.getReader();
        if (!reader)
          return {
            body: "",
            contentType: response.headers.get("content-type") ?? "",
          };
        const chunks = [];
        let bytes = 0;
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
              throw new CheckFailure("response_too_large");
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          cancel();
        }
        return {
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: response.headers.get("content-type") ?? "",
        };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function jsonResponse(response) {
  if (!/^application\/json(?:;|$)/i.test(response.contentType))
    throw new CheckFailure("invalid_json_response");
  try {
    return JSON.parse(response.body);
  } catch {
    throw new CheckFailure("invalid_json_response");
  }
}

const actions = {
  configuration:
    "Set an approved origin, an independently pinned full Git SHA and valid runner settings; do not print secrets.",
  readiness:
    "Inspect application readiness, bootstrap and database availability with the deployment owner.",
  revision:
    "Compare the approved release manifest with the running build; use the existing release runbook for discrepancies.",
  metrics:
    "Provision an approved metrics signing key, check clock synchronization and require signed access at the endpoint.",
};

function result(key, status, code, required, now) {
  return {
    key,
    status,
    code,
    required,
    lastSucceededAt: status === "passed" ? new Date(now()).toISOString() : null,
    owner: "Platform operations",
    remediation: status === "passed" ? null : actions[key],
  };
}

export async function operationalCheck(
  env = process.env,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const checkedAt = new Date(now()).toISOString();
  const checks = [];
  const attempt = async (key, run) => {
    try {
      await run();
      checks.push(result(key, "passed", "verified", true, now));
    } catch (error) {
      // Closed codes only: never return exception messages, headers or response bodies.
      checks.push(
        result(
          key,
          error instanceof CheckFailure ? error.status : "failed",
          error instanceof CheckFailure ? error.code : "request_failed",
          true,
          now,
        ),
      );
    }
  };
  let config;
  try {
    config = configuration(env);
  } catch (error) {
    checks.push(
      result(
        "configuration",
        error instanceof CheckFailure ? error.status : "failed",
        error instanceof CheckFailure ? error.code : "invalid_configuration",
        true,
        now,
      ),
    );
  }
  if (config) {
    await attempt("readiness", async () => {
      const body = jsonResponse(
        await boundedRequest(config, "/api/readyz", fetchImpl),
      );
      if (body?.status !== "ready") throw new CheckFailure("not_ready");
    });
    await attempt("revision", async () => {
      const body = jsonResponse(
        await boundedRequest(config, "/api/healthz", fetchImpl),
      );
      if (
        body?.status !== "ok" ||
        typeof body.buildRevision !== "string" ||
        !REVISION.test(body.buildRevision)
      )
        throw new CheckFailure("revision_evidence_missing", "missing");
      if (body.buildRevision.toLowerCase() !== config.revision.toLowerCase())
        throw new CheckFailure("revision_mismatch");
    });
    if (!config.key) {
      checks.push(
        result(
          "metrics",
          config.metricsRequired ? "missing" : "skipped",
          "metrics_credentials_missing",
          config.metricsRequired,
          now,
        ),
      );
    } else {
      await attempt("metrics", async () => {
        await boundedRequest(config, "/api/metrics", fetchImpl, {}, [401, 403]);
        const response = await boundedRequest(
          config,
          "/api/metrics",
          fetchImpl,
          signedMetricsHeaders(config.key, now),
        );
        if (
          !/^text\/plain(?:;|$)/i.test(response.contentType) ||
          !/^process_uptime_seconds (?:\d+(?:\.\d+)?(?:e[+-]?\d+)?)\r?$/im.test(
            response.body,
          )
        )
          throw new CheckFailure("invalid_metrics_response");
      });
    }
  }
  const failed = checks.some(
    (check) => check.required && check.status !== "passed",
  );
  return {
    version: 1,
    status: failed ? "failed" : "passed",
    scope: "endpoint_checks_only",
    checkedAt,
    checks,
  };
}

export function operationalCheckExitCode(report) {
  return report.status === "passed" &&
    report.checks.length > 0 &&
    report.checks.every((check) => !check.required || check.status === "passed")
    ? 0
    : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await operationalCheck();
    console.log(JSON.stringify(report));
    process.exitCode = operationalCheckExitCode(report);
  } catch {
    console.log(
      JSON.stringify({ version: 1, status: "failed", code: "runner_failed" }),
    );
    process.exitCode = 1;
  }
}
