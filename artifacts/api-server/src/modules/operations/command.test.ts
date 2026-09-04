import assert from "node:assert/strict";
import { test } from "node:test";
import {
  importOperationOutcome,
  operationPayloadHash,
  parseIdempotencyKey,
  serializeJson,
} from "./command.ts";

test("payload hashes ignore object order but preserve array order, values and types", () => {
  assert.equal(
    operationPayloadHash({ b: [1, { z: 2, a: 3 }], a: true }),
    operationPayloadHash({ a: true, b: [1, { a: 3, z: 2 }] }),
  );
  assert.notEqual(operationPayloadHash([1, 2]), operationPayloadHash([2, 1]));
  assert.notEqual(
    operationPayloadHash({ n: 1 }),
    operationPayloadHash({ n: "1" }),
  );
  assert.notEqual(operationPayloadHash({ n: null }), operationPayloadHash({}));
  assert.equal(
    operationPayloadHash({ optional: undefined }),
    operationPayloadHash({}),
  );
});

test("payload hashing handles special property names without prototype loss", () => {
  const payload = JSON.parse('{"__proto__":{"x":1},"constructor":"value"}');
  assert.notEqual(
    operationPayloadHash(payload),
    operationPayloadHash({ constructor: "value" }),
  );
});

test("invalid JSON numbers and cyclic results cannot masquerade as committed outcomes", () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n])
    assert.throws(() => serializeJson(value));
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => operationPayloadHash(cyclic));
});

test("response serialization preserves order and the original JSON representation", () => {
  assert.equal(
    serializeJson({
      z: 1,
      a: "\u2028",
      date: new Date("2026-09-04T00:00:00Z"),
    }),
    '{"z":1,"a":"\u2028","date":"2026-09-04T00:00:00.000Z"}',
  );
});

test("command keys are bounded, singular and never silently normalized", () => {
  for (const key of ["x", "run:part-1.v2_key", "a".repeat(128)])
    assert.equal(parseIdempotencyKey(key), key);
  for (const key of [
    undefined,
    null,
    ["one", "two"],
    "",
    " key",
    "key ",
    "one,two",
    "a".repeat(129),
    "../key",
    "key\n",
  ]) {
    assert.throws(() => parseIdempotencyKey(key), {
      code: "INVALID_IDEMPOTENCY_KEY",
      status: 400,
    });
  }
});

test("import history distinguishes complete, partial and zero-created outcomes", () => {
  assert.equal(
    importOperationOutcome({
      committed: true,
      createdCount: 2,
      invalidCount: 0,
    }).status,
    "succeeded",
  );
  assert.equal(
    importOperationOutcome({
      committed: true,
      createdCount: 1,
      invalidCount: 1,
    }).status,
    "partial",
  );
  assert.equal(
    importOperationOutcome({
      committed: true,
      createdCount: 0,
      invalidCount: 2,
    }).status,
    "failed",
  );
  assert.throws(() =>
    importOperationOutcome({
      committed: false,
      createdCount: 0,
      invalidCount: 0,
    }),
  );
});
