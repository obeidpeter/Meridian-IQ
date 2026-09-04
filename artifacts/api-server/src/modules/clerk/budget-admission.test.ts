import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { acquireFirmClerkBudgetPermit, clerkAdmissionLimit } from "./budget.ts";

test("per-firm and global admission bounds run before pool acquisition", async () => {
  let fail!: (error: Error) => void;
  const waiting = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const connect = mock.method(pool, "connect", () => waiting);
  const requests: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < clerkAdmissionLimit(); i++) {
      requests.push(
        acquireFirmClerkBudgetPermit(`firm-${i}`, 100).catch(
          (error: unknown) => error,
        ),
      );
    }
    await assert.rejects(acquireFirmClerkBudgetPermit("firm-0", 100), {
      code: "CLERK_BUSY",
    });
    for (let i = 0; i < 20; i++) {
      await assert.rejects(acquireFirmClerkBudgetPermit(`excess-${i}`, 100), {
        code: "CLERK_BUSY",
      });
    }
    assert.equal(connect.mock.callCount(), clerkAdmissionLimit());
  } finally {
    fail(new Error("test connection unavailable"));
    await Promise.all(requests);
    connect.mock.restore();
  }
});

test("invalid reservations fail before any database call", async () => {
  const connect = mock.method(pool, "connect", () => {
    assert.fail("must not acquire");
  });
  try {
    for (const tokens of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assert.rejects(
        acquireFirmClerkBudgetPermit("invalid", tokens),
        /positive safe integer/,
      );
    }
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    connect.mock.restore();
  }
});
