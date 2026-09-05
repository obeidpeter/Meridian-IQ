import assert from "node:assert/strict";
import test from "node:test";
import { pingSweep } from "./sweep-ping.mjs";

const url = new URL("https://scheduler.example/api/internal/sweep");
const key = { id: "fixture", secret: "test-only-key" };
const ok = () =>
  Response.json({
    status: "ok",
    ran: { drain: true, reconcile: true, sweeps: true },
    ignored: "private fixture",
  });

test("pinger only reports completion after a full pass and re-signs busy retries", async () => {
  let time = 0;
  const calls = [],
    waits = [];
  const result = await pingSweep(url, key, {
    now: () => time,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    fetchImpl: async (target, options) => {
      assert.equal(target, url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      calls.push(options.headers);
      return calls.length === 1
        ? Response.json(
            { status: "busy" },
            { status: 202, headers: { "retry-after": "5" } },
          )
        : ok();
    },
  });
  assert.deepEqual(result, {
    status: "ok",
    ran: { drain: true, reconcile: true, sweeps: true },
  });
  assert.deepEqual(waits, [5_000]);
  assert.notEqual(calls[0]["x-op-signature"], calls[1]["x-op-signature"]);
});

test("pinger honors partial-failure and rate-limit Retry-After without exposing response bodies", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const waits = [];
    const result = await pingSweep(url, key, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () =>
        ++calls === 1
          ? Response.json(
              { status: "partial_failure", detail: "private fixture" },
              { status, headers: { "retry-after": "60" } },
            )
          : ok(),
    });
    assert.deepEqual(waits, [60_000]);
    assert.equal(result.status, "ok");
    assert.ok(!JSON.stringify(result).includes("private fixture"));
  }
});

test("busy, failed and malformed outcomes cannot be reported as completed after retries", async () => {
  for (const makeResponse of [
    () => Response.json({ status: "busy" }, { status: 202 }),
    () =>
      Response.json(
        { status: "partial_failure", detail: "private fixture" },
        { status: 503 },
      ),
    () =>
      Response.json({
        status: "ok",
        ran: { drain: true, reconcile: true, sweeps: false },
      }),
    () => new Response("not JSON"),
  ]) {
    let calls = 0;
    await assert.rejects(
      pingSweep(url, key, {
        sleep: async () => {},
        fetchImpl: async () => {
          calls++;
          return makeResponse();
        },
      }),
      (error) =>
        /failed within 3 attempts/.test(error.message) &&
        !error.message.includes("private fixture"),
    );
    assert.equal(calls, 3);
  }
});

test("HTTP-date Retry-After is respected; an excessive delay exits for the next scheduled run", async () => {
  let calls = 0;
  const waits = [];
  await pingSweep(url, key, {
    now: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetchImpl: async () =>
      ++calls === 1
        ? Response.json(
            {},
            {
              status: 429,
              headers: { "retry-after": new Date(60_000).toUTCString() },
            },
          )
        : ok(),
  });
  assert.deepEqual(waits, [60_000]);
  await assert.rejects(
    pingSweep(url, key, {
      sleep: async () =>
        assert.fail("do not shorten or wait out an excessive server delay"),
      fetchImpl: async () =>
        Response.json({}, { status: 429, headers: { "retry-after": "3600" } }),
    }),
    /failed within 3 attempts/,
  );
});
