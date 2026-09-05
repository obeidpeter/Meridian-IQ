import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./common.mjs";
import { readSecurityCatalog } from "./security-catalog.mjs";
import {
  MOBILE_DIR,
  mobileBuildConfig,
  validateMobileArtifact,
} from "./mobile-artifact.mjs";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const APPS = [
  ["landing", "/"],
  ["console", "/console/"],
  ["sme-compliance", "/app/"],
  ["buyer-portal", "/buyer/"],
  ["penalty-calculator", "/penalty-calculator/"],
];
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

function git(root, args) {
  const result = run("git", args, { cwd: root });
  assert.equal(result.status, 0, "cannot inspect source revision");
  return result.stdout.trim();
}

export function hashFiles(root, files) {
  return digest(
    JSON.stringify(
      files.sort().map((file) => {
        assert.equal(
          lstatSync(path.join(root, file)).isSymbolicLink(),
          false,
          `symlink not permitted: ${file}`,
        );
        return [file, digest(readFileSync(path.join(root, file)))];
      }),
    ),
  );
}

export function sourceIdentity(root = ROOT) {
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  return {
    revision: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    sha256: hashFiles(root, files),
    schemaSha256: hashFiles(
      root,
      files.filter(
        (file) =>
          file.startsWith("lib/db/src/schema/") ||
          file.startsWith("lib/db/src/migrations/"),
      ),
    ),
  };
}

function walk(root, directory) {
  // Check directory components too: a symlinked dist root would otherwise evade
  // the leaf-entry checks and promote files outside the staged artifact tree.
  let current = root;
  for (const part of directory.split("/")) {
    current = path.join(current, part);
    const info = lstatSync(current);
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      `artifact directory must be real: ${directory}`,
    );
  }
  return readdirSync(path.join(root, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink(), "artifact symlinks are not permitted");
    assert.ok(
      entry.isDirectory() || entry.isFile(),
      "artifact must be a regular file or directory",
    );
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(root, name) : [name];
  });
}

export function assetInventory(root = ROOT) {
  const applications = [
    ...APPS.map(([app, prefix]) => ({
      dir: `artifacts/${app}/dist/public`,
      prefix,
    })),
    { dir: "artifacts/api-server/dist", prefix: null },
    { dir: MOBILE_DIR, prefix: "/mobile/" },
  ];
  return applications
    .flatMap(({ dir, prefix }) => {
      const files = walk(root, dir).filter((file) => !file.endsWith(".map"));
      assert.ok(
        files.includes(
          `${dir}/${dir === MOBILE_DIR ? "server/serve.cjs" : prefix === null ? "index.mjs" : "index.html"}`,
        ),
        `missing build: ${dir}`,
      );
      return files.map((file) => ({
        file,
        sha256: digest(readFileSync(path.join(root, file))),
        url:
          dir === MOBILE_DIR
            ? file.startsWith(`${dir}/static-build/`)
              ? prefix + file.slice(`${dir}/static-build/`.length)
              : null
            : prefix === null
              ? null
              : prefix + file.slice(dir.length + 1),
      }));
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function loadManifest(file, expectedHash) {
  assert.match(
    expectedHash ?? "",
    /^[a-f0-9]{64}$/,
    "supply manifest SHA-256 from the trusted CI artifact record",
  );
  const bytes = readFileSync(file);
  assert.equal(digest(bytes), expectedHash, "manifest checksum mismatch");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.format, 1, "unsupported build manifest");
  assert.match(
    manifest.source?.revision ?? "",
    /^[a-f0-9]{40}$/,
    "full source revision required",
  );
  assert.ok(
    manifest.ci?.runId && manifest.ci?.repository,
    "missing CI provenance",
  );
  assert.ok(
    manifest.assets?.length && manifest.contractVersion,
    "incomplete artifact identity",
  );
  return manifest;
}

export function verifyLocalArtifact(manifest, root = ROOT) {
  assert.deepEqual(
    sourceIdentity(root),
    manifest.source,
    "source or schema differs from CI artifact",
  );
  assert.deepEqual(
    assetInventory(root),
    manifest.assets,
    "built assets differ from CI artifact",
  );
  const mobile = validateMobileArtifact(root);
  assert.deepEqual(
    mobile,
    mobileBuildConfig(root),
    "mobile build configuration differs from reviewed source",
  );
  assert.deepEqual(
    mobile,
    manifest.mobile,
    "mobile deployment identity differs from CI artifact",
  );
}

export function stampManifest(env = process.env, root = ROOT) {
  assert.equal(env.GITHUB_ACTIONS, "true", "manifest stamping is CI-only");
  assert.ok(
    env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY && env.DATABASE_URL,
    "CI provenance and scratch DATABASE_URL required",
  );
  assert.equal(
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "CI source must be clean",
  );
  const source = sourceIdentity(root);
  assert.equal(
    source.revision,
    env.GITHUB_SHA,
    "CI revision differs from checkout",
  );
  const version = readFileSync(
    path.join(root, "lib/api-zod/src/generated/version.ts"),
    "utf8",
  );
  const contractVersion = version.match(
    /API_CONTRACT_VERSION = "([^"]+)"/,
  )?.[1];
  assert.ok(contractVersion, "missing generated contract version");
  const mobile = validateMobileArtifact(root);
  assert.deepEqual(
    mobile,
    mobileBuildConfig(root),
    "mobile release config differs from reviewed source",
  );
  return {
    format: 1,
    source,
    contractVersion,
    createdAt: new Date().toISOString(),
    ci: {
      repository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    },
    assets: assetInventory(root),
    mobile,
    database: readSecurityCatalog(env.DATABASE_URL),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = stampManifest();
  const output = path.join(ROOT, "release/build-manifest.json");
  mkdirSync(path.dirname(output), { recursive: true });
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(output, bytes);
  writeFileSync(`${output}.sha256`, `${digest(bytes)}  build-manifest.json\n`);
  console.log(`CI manifest ${manifest.source.revision}: ${digest(bytes)}`);
}
