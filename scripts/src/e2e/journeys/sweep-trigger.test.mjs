import assert from "node:assert/strict";
import test from "node:test";
import {
  createSweepTrigger,
  invoiceProbeDiagnostic,
} from "./sweep-trigger.mjs";

function response(status, body, retryAfter) {
  return {
    status: () => status,
    json: async () => body,
    headers: () => ({ "retry-after": retryAfter }),
  };
}

test("polling shares a six-second sweep cadence and accepts only explicit successful/busy outcomes", async () => {
  let time = 0;
  let calls = 0;
  const trigger = createSweepTrigger(
    {
      get: async (_url, options) => {
        assert.equal(options.timeout, 10_000);
        calls++;
        return calls === 1
          ? response(200, { status: "ok" })
          : response(202, { status: "busy" });
      },
    },
    "http://localhost",
    "test-token",
    () => time,
  );
  await trigger();
  for (time = 1_000; time < 6_000; time += 1_000) await trigger();
  assert.equal(calls, 1);
  await trigger();
  assert.equal(calls, 2);
});

test("429 respects numeric, HTTP-date and missing Retry-After without retry bursts", async () => {
  for (const header of [
    "60",
    new Date(60_000).toUTCString(),
    undefined,
    "invalid",
  ]) {
    let time = 0;
    let calls = 0;
    const trigger = createSweepTrigger(
      {
        get: async () => {
          calls++;
          return response(429, {}, header);
        },
      },
      "http://localhost",
      "test-token",
      () => time,
    );
    await trigger();
    time = 59_999;
    await trigger();
    assert.equal(calls, 1);
    time = 60_000;
    await trigger();
    assert.equal(calls, 2);
  }
});

test("partial failures, auth failures, unexpected success bodies and network failures fail the probe", async () => {
  for (const [status, body] of [
    [503, { status: "partial_failure", error: "private-value" }],
    [401, {}],
    [200, {}],
    [200, { status: "partial_failure" }],
  ]) {
    const trigger = createSweepTrigger(
      { get: async () => response(status, body) },
      "http://localhost",
      "test-token",
    );
    await assert.rejects(
      trigger(),
      (error) =>
        /scheduler pass failed/.test(error.message) &&
        !error.message.includes("private-value"),
    );
  }
  const trigger = createSweepTrigger(
    {
      get: async () => {
        throw new Error("request timed out");
      },
    },
    "http://localhost",
    "test-token",
  );
  await assert.rejects(trigger(), /request timed out/);
});

test("probe diagnostics print only allowlisted state, HTTP status and counts", async () => {
  const diagnostic = await invoiceProbeDiagnostic(
    {
      get: async (url) =>
        response(
          200,
          url.endsWith("/attempts")
            ? [{ requestPayload: "private-value" }]
            : { invoice: { status: "submitted", name: "private-value" } },
        ),
    },
    "http://localhost",
    "fixture-id",
  );
  assert.equal(
    diagnostic,
    "invoice HTTP 200, state submitted; attempts HTTP 200, count 1",
  );
  assert.ok(!diagnostic.includes("private-value"));
});
