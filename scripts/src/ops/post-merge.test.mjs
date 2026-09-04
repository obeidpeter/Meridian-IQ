import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("post-merge is fail-fast frozen install followed only by versioned migrations", () => {
  const commands = readFileSync(
    new URL("../../post-merge.sh", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(
    commands,
    [
      "set -euo pipefail",
      "pnpm install --frozen-lockfile",
      "pnpm --filter @workspace/db run migrate",
    ],
    "no schema push, non-frozen fallback, or ignored command failure in post-merge",
  );
});
