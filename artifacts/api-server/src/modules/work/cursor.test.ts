import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeWorkCursor, encodeWorkCursor, workFilterKey } from "./cursor";

test("work cursors retain sub-millisecond due dates and bind scope and filters", () => {
  const filter = workFilterKey({ firm: "a", user: "a", view: "active" });
  const value = {
    rank: 1,
    due: "2026-09-09T12:00:00.123456Z",
    id: randomUUID(),
  };
  assert.deepEqual(
    decodeWorkCursor(encodeWorkCursor(value, filter), filter),
    value,
  );
  assert.deepEqual(
    decodeWorkCursor(encodeWorkCursor({ ...value, due: null }, filter), filter),
    { ...value, due: null },
  );
  assert.throws(
    () =>
      decodeWorkCursor(
        encodeWorkCursor(value, filter),
        workFilterKey({ firm: "b", user: "a", view: "active" }),
      ),
    /Refresh team work/,
  );
});

test("work cursor boundary rejects malformed values without SQL interpolation", () => {
  const filter = "scope";
  const value = { rank: 2, due: null, id: randomUUID(), filter };
  for (const bad of [
    "",
    "!bad",
    "a".repeat(1025),
    ...[
      null,
      {},
      { ...value, rank: 4 },
      { ...value, rank: 1.5 },
      { ...value, due: "2026-02-30T00:00:00.000000Z" },
      { ...value, due: "2026-09-09T00:00:00Z" },
      { ...value, due: "0000-01-01T00:00:00.000000Z" },
      { ...value, id: "' OR 1=1--" },
    ].map((input) => Buffer.from(JSON.stringify(input)).toString("base64url")),
  ]) {
    assert.throws(() => decodeWorkCursor(bad, filter), /Refresh team work/);
  }
});
