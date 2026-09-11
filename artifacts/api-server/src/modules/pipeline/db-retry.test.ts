import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPostgresFailure,
  retryDelayMs,
  withTransientDatabaseRetry,
  WorkerRetryStoppedError,
} from "./db-retry.ts";
import { getReadiness, markReady } from "../../lib/readiness.ts";

test("classifies only PostgreSQL availability failures as transient", () => {
  for (const code of [
    "08000",
    "08006",
    "57P01",
    "57P02",
    "57P03",
    "53300",
    "ECONNRESET",
    "ETIMEDOUT",
  ]) {
    assert.deepEqual(classifyPostgresFailure({ code }), {
      transient: true,
      code,
    });
  }
  for (const code of ["23505", "40001", "42601", "55P03", "57014"]) {
    assert.equal(classifyPostgresFailure({ code }).transient, false, code);
  }
  assert.deepEqual(classifyPostgresFailure({ cause: { code: "08003" } }), {
    transient: true,
    code: "08003",
  });
  assert.deepEqual(classifyPostgresFailure(new Error("connection refused")), {
    transient: false,
    code: "unknown",
  });
  assert.deepEqual(
    classifyPostgresFailure(new Error("Connection terminated unexpectedly")),
    { transient: true, code: "unknown" },
  );
});

test("bounded full-jitter backoff retries and reports recovery", async () => {
  const delays: number[] = [];
  const retries: number[] = [];
  let recovered = 0;
  let calls = 0;
  const result = await withTransientDatabaseRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { code: "08006" };
      return "healthy";
    },
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 150,
      random: () => 0.5,
      sleep: async (delay) => {
        delays.push(delay);
      },
      signal: new AbortController().signal,
      onRetry: ({ attempt }) => retries.push(attempt),
      onRecovered: ({ attempts }) => {
        recovered = attempts;
      },
    },
  );
  assert.equal(result, "healthy");
  assert.deepEqual(delays, [50, 75]);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(recovered, 3);
  assert.equal(
    retryDelayMs(20, 100, 150, () => 1),
    150,
  );
});

test("permanent failures do not retry and transient failures exhaust visibly", async () => {
  let permanentCalls = 0;
  await assert.rejects(
    withTransientDatabaseRetry(
      async () => {
        permanentCalls += 1;
        throw { code: "23505" };
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        signal: new AbortController().signal,
      },
    ),
  );
  assert.equal(permanentCalls, 1);

  let exhausted = 0;
  let transientCalls = 0;
  await assert.rejects(
    withTransientDatabaseRetry(
      async () => {
        transientCalls += 1;
        throw { code: "57P03" };
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        random: () => 0,
        sleep: async () => {},
        signal: new AbortController().signal,
        onExhausted: ({ attempts }) => {
          exhausted = attempts;
        },
      },
    ),
  );
  assert.equal(transientCalls, 3);
  assert.equal(exhausted, 3);
});

test("shutdown during backoff prevents another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  let sleepStarted!: () => void;
  const sleeping = new Promise<void>((resolve) => {
    sleepStarted = resolve;
  });
  const pass = withTransientDatabaseRetry(
    async () => {
      calls += 1;
      throw { code: "08006" };
    },
    {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 100,
      signal: controller.signal,
      sleep: async (_delay, signal) => {
        sleepStarted();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new WorkerRetryStoppedError()),
            { once: true },
          ),
        );
      },
    },
  );
  await sleeping;
  controller.abort();
  await assert.rejects(pass, WorkerRetryStoppedError);
  assert.equal(calls, 1);
});

test("one retrying pass owns its operation until recovery", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const operation = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls += 1;
    active -= 1;
    if (calls === 1) throw { code: "08006" };
    return "recovered";
  };
  const result = await withTransientDatabaseRetry(operation, {
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 1,
    random: () => 0,
    sleep: async () => {},
    signal: new AbortController().signal,
  });
  assert.equal(result, "recovered");
  assert.equal(maximumActive, 1);
});

test("worker backoff does not change API readiness", async () => {
  markReady();
  let calls = 0;
  let releaseBackoff!: () => void;
  let backoffStarted!: () => void;
  const backoff = new Promise<void>((resolve) => {
    releaseBackoff = resolve;
  });
  const started = new Promise<void>((resolve) => {
    backoffStarted = resolve;
  });
  const pass = withTransientDatabaseRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw { code: "57P03" };
      return "healthy";
    },
    {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      random: () => 0,
      sleep: async () => {
        backoffStarted();
        await backoff;
      },
      signal: new AbortController().signal,
    },
  );
  await started;
  assert.deepEqual(getReadiness(), { ready: true, reason: "ready" });
  releaseBackoff();
  assert.equal(await pass, "healthy");
});
