import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { pool, workerLockPool, databasePoolMetrics } from "./client.ts";

test("idle client errors are handled, counted separately, and redacted", () => {
  const lines: string[] = [];
  const log = mock.method(console, "error", (line: string) => lines.push(line));
  try {
    const before = databasePoolMetrics();
    pool.emit(
      "error",
      Object.assign(new Error("password=do-not-log SQL SELECT secret"), {
        code: "08006",
      }),
    );
    workerLockPool.emit(
      "error",
      Object.assign(new Error("secret"), { code: "secret-in-code" }),
    );
    const after = databasePoolMetrics();
    assert.equal(after[0].idleErrors, before[0].idleErrors + 1);
    assert.equal(after[1].idleErrors, before[1].idleErrors + 1);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).code),
      ["08006", "unknown"],
    );
    assert.doesNotMatch(lines.join("\n"), /password|SELECT|secret/);
    assert.equal(after[0].active, 0);
    assert.equal(after[0].waiting, 0);
  } finally {
    log.mock.restore();
  }
});
