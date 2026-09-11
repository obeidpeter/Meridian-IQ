import assert from "node:assert/strict";
import path from "node:path";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { digest, loadManifest } from "./build-manifest.mjs";
import { deploymentOrigin } from "./maintenance-server.mjs";
import { assertCompleteSecurityCatalog } from "./security-catalog.mjs";

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function readRawCatalog(file) {
  assert.ok(
    typeof file === "string" && file.length > 0 && file.length <= 4096,
    "raw catalog input file required",
  );
  const entry = lstatSync(file);
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    "raw catalog input must be a regular non-symlink file",
  );
  const fd = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let bytes;
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= MAX_CATALOG_BYTES,
      "raw catalog input size invalid",
    );
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    assert.ok(
      size > 0 && size <= MAX_CATALOG_BYTES,
      "raw catalog input exceeds bounded size",
    );
    bytes = buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error("raw catalog input must contain valid UTF-8 JSON");
  }
}

export function captureSecurityCatalog(
  args = process.argv.slice(2),
  env = process.env,
  { now = Date.now() } = {},
) {
  assert.ok(
    args.length === 4 &&
      args[0] === "--input" &&
      args[1] &&
      args[2] === "--output" &&
      args[3],
    "use capture-security-catalog --input <raw-json-file> --output <new-private-file>",
  );
  assert.ok(Number.isSafeInteger(now), "invalid capture time");
  const manifest = loadManifest(
    env.RELEASE_MANIFEST,
    env.RELEASE_MANIFEST_SHA256,
  );
  const catalog = readRawCatalog(args[1]);
  assertCompleteSecurityCatalog(manifest.database, catalog);
  const capture = {
    format: 1,
    kind: "security-catalog-capture",
    capturedAt: new Date(now).toISOString(),
    manifestSha256: env.RELEASE_MANIFEST_SHA256,
    targetOrigin: deploymentOrigin(env.RELEASE_BASE_URL),
    catalog,
  };
  const bytes = JSON.stringify(capture, null, 2) + "\n";
  assert.ok(
    Buffer.byteLength(bytes) <= MAX_CATALOG_BYTES,
    "security catalog capture exceeds bounded size",
  );
  writeFileSync(args[3], bytes, { flag: "wx", mode: 0o600 });
  const sha256 = digest(bytes);
  console.log(`capture-security-catalog: wrote ${args[3]}; SHA256 ${sha256}`);
  return { capture, sha256 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    captureSecurityCatalog();
  } catch (error) {
    console.error("capture-security-catalog: FAILED: " + error.message);
    process.exitCode = 1;
  }
}
