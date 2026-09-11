import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asDatabaseConnectionError,
  DatabaseConnectionError,
  isDatabaseConnectionError,
} from "./retry.ts";

test("connection loss detection accepts PostgreSQL session failures and wrapped driver causes", () => {
  assert.equal(
    isDatabaseConnectionError(
      Object.assign(new Error("server closed the connection unexpectedly"), {
        code: "08006",
      }),
    ),
    true,
  );
  assert.equal(
    isDatabaseConnectionError(
      new Error("server closed the connection unexpectedly"),
    ),
    true,
  );
  assert.equal(
    isDatabaseConnectionError({
      cause: Object.assign(new Error("connection reset by peer"), {
        code: "ECONNRESET",
      }),
    }),
    true,
  );
  assert.equal(
    isDatabaseConnectionError(
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    ),
    false,
  );
  assert.equal(
    isDatabaseConnectionError(
      Object.assign(new Error("validation failed"), { code: "23505" }),
    ),
    false,
  );
});

test("normalizing a connection failure preserves identity and cause without making ordinary errors transient", () => {
  const original = Object.assign(new Error("connection terminated"), {
    code: "57P01",
  });
  const normalized = asDatabaseConnectionError(original);
  assert.ok(normalized instanceof DatabaseConnectionError);
  assert.equal(normalized.code, "DATABASE_CONNECTION_LOST");
  assert.equal(normalized.cause, original);
  assert.equal(asDatabaseConnectionError(normalized), normalized);
});
