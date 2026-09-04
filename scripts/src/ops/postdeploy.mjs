import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest, loadManifest } from "./build-manifest.mjs";
import {
  compareSecurityCatalog,
  readSecurityCatalog,
} from "./security-catalog.mjs";

export async function verifyDeployment(base, manifest, fetcher = fetch) {
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
  const get = async (route) => {
    assert.ok(
      route.startsWith("/") && !route.startsWith("//"),
      "invalid asset URL",
    );
    const response = await fetcher(new URL(route, origin), {
      redirect: "error",
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
    return response;
  };
  const health = await (await get("/api/healthz")).json();
  assert.equal(health.status, "ok", "API liveness failed");
  assert.equal(
    health.buildRevision,
    manifest.source.revision,
    "deployed API source mismatch (full SHA required)",
  );
  assert.equal(
    health.contractVersion,
    manifest.contractVersion,
    "deployed API contract mismatch",
  );
  assert.equal(
    (await (await get("/api/readyz")).json()).status,
    "ready",
    "API is not ready",
  );
  for (const asset of manifest.assets.filter((entry) => entry.url)) {
    const bytes = Buffer.from(await (await get(asset.url)).arrayBuffer());
    assert.equal(
      digest(bytes),
      asset.sha256,
      `deployed asset mismatch: ${asset.url}`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const env = process.env;
    const manifest = loadManifest(
      env.RELEASE_MANIFEST,
      env.RELEASE_MANIFEST_SHA256,
    );
    assert.ok(
      env.DATABASE_URL && env.RELEASE_BASE_URL,
      "DATABASE_URL and RELEASE_BASE_URL required",
    );
    compareSecurityCatalog(
      manifest.database,
      readSecurityCatalog(env.DATABASE_URL),
    );
    await verifyDeployment(env.RELEASE_BASE_URL, manifest);
    console.log(
      `postdeploy: source, contract, assets, schema and security match ${manifest.source.revision}`,
    );
  } catch (error) {
    console.error(`postdeploy: FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
