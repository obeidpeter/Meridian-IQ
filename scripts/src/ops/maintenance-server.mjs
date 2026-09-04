// This listener deliberately has no application, database, or worker imports.
import assert from "node:assert/strict";
import { createServer } from "node:http";

export function runtimeState(env) {
  const state = env.RELEASE_RUNTIME_STATE ?? "HOLD";
  assert.ok(
    state === "HOLD" || state === "RUN",
    "RELEASE_RUNTIME_STATE must be HOLD or RUN",
  );
  return state;
}

export function deploymentOrigin(base) {
  assert.ok(
    typeof base === "string" && base.length > 0,
    "RELEASE_BASE_URL is required",
  );
  const origin = new URL(base);
  assert.ok(
    origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)),
    "use HTTPS for remote parity verification",
  );
  assert.equal(
    origin.pathname,
    "/",
    "provide the deployment origin, not a path",
  );
  assert.ok(
    !origin.username && !origin.password && !origin.search && !origin.hash,
    "origin must not contain credentials, query, or fragment",
  );
  return origin.origin;
}

export function maintenanceIdentity(manifest, env) {
  assert.ok(
    typeof manifest.mobile?.domain === "string" &&
      manifest.mobile.domain.length > 0,
    "CI mobile production target is required",
  );
  const identity = {
    buildRevision: manifest.source.revision,
    contractVersion: manifest.contractVersion,
    manifestSha256: env.RELEASE_MANIFEST_SHA256,
    target: {
      origin: deploymentOrigin(env.RELEASE_BASE_URL),
      replId: env.REPL_ID,
    },
    recoveryPlanSha256: env.RELEASE_RECOVERY_PLAN_SHA256,
    backupSha256: env.RELEASE_BACKUP_SHA256,
  };
  assert.match(
    identity.buildRevision ?? "",
    /^[a-f0-9]{40}$/,
    "candidate must be a full SHA",
  );
  assert.ok(
    typeof identity.contractVersion === "string" &&
      identity.contractVersion.length > 0,
    "contract identity is required",
  );
  for (const field of ["manifestSha256", "recoveryPlanSha256", "backupSha256"])
    assert.match(
      identity[field] ?? "",
      /^[a-f0-9]{64}$/,
      `independently trusted ${field} is required`,
    );
  assert.ok(
    typeof identity.target.replId === "string" &&
      /^[\x21-\x7e]{1,200}$/.test(identity.target.replId),
    "REPL_ID must identify the intended Replit target",
  );
  assert.equal(
    identity.target.origin,
    deploymentOrigin(`https://${manifest.mobile.domain}`),
    "release origin differs from the CI mobile production target",
  );
  if (manifest.mobile?.replId != null)
    assert.equal(
      identity.target.replId,
      manifest.mobile.replId,
      "REPL_ID differs from the CI mobile production target",
    );
  return identity;
}

export function activationBindings(manifest, env) {
  assert.equal(
    env.RELEASE_RECOVERY_MODE,
    "maintenance-forward",
    "RUN requires a maintenance-forward activation permit; rollback preflight never authorizes RUN",
  );
  assert.equal(
    env.RELEASE_TRAFFIC_DRAINED,
    "1",
    "RUN requires external ingress and schedules to remain held (RELEASE_TRAFFIC_DRAINED=1)",
  );
  const identity = maintenanceIdentity(manifest, env);
  return {
    revision: identity.buildRevision,
    manifestSha256: identity.manifestSha256,
    targetOrigin: identity.target.origin,
    replId: identity.target.replId,
    recoveryPlanSha256: identity.recoveryPlanSha256,
    backupSha256: identity.backupSha256,
    heldEvidenceSha256: env.RELEASE_HELD_EVIDENCE_SHA256,
    activationId: env.RELEASE_ACTIVATION_ID,
  };
}

export function maintenanceResponse(identity) {
  return {
    status: "maintenance",
    maintenance: true,
    mode: "hold",
    apiImported: false,
    ...identity,
  };
}

export async function startMaintenanceServer(
  identity,
  { port, host = "0.0.0.0" },
) {
  assert.ok(
    Number.isInteger(port) && port >= 0 && port <= 65535,
    "invalid maintenance port",
  );
  const body = JSON.stringify(maintenanceResponse(identity));
  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000 },
    (request, response) => {
      const healthy =
        (request.method === "GET" || request.method === "HEAD") &&
        request.url === "/api/healthz";
      response.writeHead(healthy ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
        "x-content-type-options": "nosniff",
        "retry-after": "60",
        connection: "close",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    },
  );
  server.keepAliveTimeout = 1000;
  // Upgrade/CONNECT must not create a second route into the application.
  const rejectSocket = (_request, socket) =>
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    );
  server.on("upgrade", rejectSocket);
  server.on("connect", rejectSocket);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.once("close", () => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  });
  return server;
}
