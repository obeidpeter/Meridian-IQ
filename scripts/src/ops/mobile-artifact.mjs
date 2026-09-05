import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./common.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const MOBILE_DIR = "artifacts/mobile/dist";

export function mobileBuildConfig(root = ROOT) {
  const eas = JSON.parse(
    readFileSync(path.join(root, "artifacts/mobile/eas.json"), "utf8"),
  );
  const domain = eas.build?.production?.env?.EXPO_PUBLIC_DOMAIN;
  assert.match(
    domain ?? "",
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i,
    "reviewed EAS production domain required",
  );
  const replId = eas.build.production.env.EXPO_PUBLIC_REPL_ID ?? null;
  if (replId !== null)
    assert.match(replId, /^[a-f0-9-]{36}$/i, "invalid reviewed Repl ID");
  return { format: 1, domain, basePath: "/mobile/", replId };
}

export function validateMobileArtifact(root = ROOT) {
  const directory = path.join(root, MOBILE_DIR);
  const config = JSON.parse(
    readFileSync(path.join(directory, "deployment.json"), "utf8"),
  );
  assert.equal(config.format, 1, "unsupported mobile artifact config");
  assert.equal(config.basePath, "/mobile/", "mobile base path mismatch");
  assert.match(
    config.domain ?? "",
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i,
    "mobile domain missing",
  );
  for (const file of [
    "server/serve.cjs",
    "server/templates/landing-page.html",
    "app.json",
    "eas.json",
  ])
    assert.ok(
      lstatSync(path.join(directory, file)).isFile(),
      `missing mobile serving input: ${file}`,
    );
  const eas = JSON.parse(
    readFileSync(path.join(directory, "eas.json"), "utf8"),
  );
  assert.equal(
    eas.build.production.env.EXPO_PUBLIC_DOMAIN,
    config.domain,
    "mobile EAS/config mismatch",
  );
  assert.equal(
    eas.build.production.env.EXPO_PUBLIC_REPL_ID ?? null,
    config.replId,
    "mobile Repl ID mismatch",
  );
  const publicRoot = path.join(directory, "static-build");
  const prefix = `https://${config.domain}${config.basePath}`;
  for (const platform of ["ios", "android"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(publicRoot, platform, "manifest.json"), "utf8"),
    );
    assert.ok(manifest.launchAsset?.url, `missing ${platform} launch asset`);
    for (const asset of [manifest.launchAsset, ...(manifest.assets ?? [])]) {
      assert.ok(
        asset.url?.startsWith(prefix),
        `unpackaged ${platform} asset URL`,
      );
      const relative = decodeURIComponent(
        new URL(asset.url).pathname.slice(config.basePath.length),
      );
      const target = path.resolve(publicRoot, relative);
      assert.ok(
        target.startsWith(`${publicRoot}${path.sep}`),
        "mobile asset path escapes package",
      );
      assert.ok(
        lstatSync(target).isFile(),
        `missing ${platform} asset: ${relative}`,
      );
    }
  }
  return config;
}

export function buildMobileArtifact(root = ROOT, env = process.env) {
  const app = path.join(root, "artifacts/mobile");
  const config = mobileBuildConfig(root);
  const buildEnv = {
    ...env,
    NODE_ENV: "production",
    CI: "1",
    BASE_PATH: config.basePath,
    EXPO_PUBLIC_DOMAIN: config.domain,
  };
  // Only the reviewed public EAS domain enters the release build, not host IDs
  // or a development deployment's automatic environment overrides.
  for (const key of [
    "REPLIT_INTERNAL_APP_DOMAIN",
    "REPLIT_DEV_DOMAIN",
    "REPL_ID",
    "EXPO_PUBLIC_REPL_ID",
  ])
    delete buildEnv[key];
  if (config.replId) buildEnv.EXPO_PUBLIC_REPL_ID = config.replId;
  const result = run(process.execPath, ["scripts/build.js"], {
    cwd: app,
    env: buildEnv,
    stdio: "inherit",
    timeout: 720_000,
  });
  assert.equal(
    result.status,
    0,
    "mobile native export failed; do not stamp or publish",
  );
  const output = path.join(app, "dist");
  assert.equal(path.dirname(output), app);
  if (existsSync(output)) {
    assert.ok(
      !lstatSync(output).isSymbolicLink(),
      "mobile dist must not be a symlink",
    );
    rmSync(output, { recursive: true });
  }
  mkdirSync(output);
  cpSync(path.join(app, "static-build"), path.join(output, "static-build"), {
    recursive: true,
  });
  cpSync(path.join(app, "server"), path.join(output, "server"), {
    recursive: true,
  });
  // Explicit CommonJS extension preserves the existing server under any snapshot package scope.
  cpSync(
    path.join(app, "server/serve.js"),
    path.join(output, "server/serve.cjs"),
  );
  rmSync(path.join(output, "server/serve.js"));
  for (const file of ["app.json", "eas.json"])
    cpSync(path.join(app, file), path.join(output, file));
  writeFileSync(
    path.join(output, "deployment.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  validateMobileArtifact(root);
  console.log(
    `mobile: packaged native exports and serving inputs for ${config.domain}${config.basePath}`,
  );
}

export async function verifyMobileServing(root = ROOT) {
  const config = validateMobileArtifact(root);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [path.join(root, MOBILE_DIR, "server/serve.cjs")],
    {
      env: { ...process.env, PORT: String(port), BASE_PATH: config.basePath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const closed = once(child, "close");
  let logs = "";
  child.stdout.on("data", (value) => {
    logs += value;
  });
  child.stderr.on("data", (value) => {
    logs += value;
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${origin}${config.basePath}`, {
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        break;
      } catch (error) {
        if (attempt >= 40 || child.exitCode !== null)
          throw new Error(`mobile server failed: ${logs}`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const platform of ["ios", "android"]) {
      const response = await fetch(`${origin}${config.basePath}manifest`, {
        headers: { "expo-platform": platform },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(
        bytes,
        readFileSync(
          path.join(
            root,
            MOBILE_DIR,
            "static-build",
            platform,
            "manifest.json",
          ),
        ),
      );
      const manifest = JSON.parse(bytes);
      for (const asset of [manifest.launchAsset, ...(manifest.assets ?? [])]) {
        const assetPath = new URL(asset.url).pathname;
        const served = await fetch(`${origin}${assetPath}`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(served.status, 200, assetPath);
        assert.deepEqual(
          Buffer.from(await served.arrayBuffer()),
          readFileSync(
            path.join(
              root,
              MOBILE_DIR,
              "static-build",
              decodeURIComponent(assetPath.slice(config.basePath.length)),
            ),
          ),
        );
      }
    }
    console.log(
      "mobile: packaged server, both platform manifests and referenced asset bytes passed",
    );
  } finally {
    child.kill();
    await closed;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(process.argv.length, 3, "use build or check");
    if (process.argv[2] === "build") buildMobileArtifact();
    else {
      assert.equal(process.argv[2], "check");
      await verifyMobileServing();
    }
  } catch (error) {
    console.error(`mobile artifact: REFUSED: ${error.message}`);
    process.exitCode = 1;
  }
}
