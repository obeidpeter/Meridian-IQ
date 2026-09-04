import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionConfig,
  workerConnectionConfig,
} from "./connection-config.ts";

test("pool defaults have bounded server deadlines and separate worker lock capacity", () => {
  const app = connectionConfig({});
  const worker = workerConnectionConfig({});
  assert.equal(app.max, 20);
  assert.equal(worker.max, 2);
  assert.equal(app.statement_timeout, 15_000);
  assert.equal(app.lock_timeout, 2_000);
  assert.equal(app.idle_in_transaction_session_timeout, 30_000);
  assert.equal(app.query_timeout, undefined);
  assert.equal(app.connectionTimeoutMillis, 5_000);
});

test("configuration rejects invalid, disabled, or dangerously large bounds", () => {
  for (const raw of [
    "",
    " ",
    "0",
    "-1",
    "NaN",
    "Infinity",
    "2.5",
    "20oops",
    "101",
    "1e2",
  ]) {
    assert.throws(() => connectionConfig({ PGPOOL_MAX: raw }), /PGPOOL_MAX/);
  }
  for (const key of [
    "PG_CONNECT_TIMEOUT_MS",
    "PG_LOCK_TIMEOUT_MS",
    "PG_STATEMENT_TIMEOUT_MS",
    "PG_IDLE_TRANSACTION_TIMEOUT_MS",
  ]) {
    for (const value of ["0", "NaN", "Infinity", "-1", "9999999999"]) {
      assert.throws(() => connectionConfig({ [key]: value }), new RegExp(key));
    }
  }
  assert.throws(
    () => workerConnectionConfig({ PG_WORKER_LOCK_POOL_MAX: "1" }),
    /PG_WORKER_LOCK_POOL_MAX/,
  );
  assert.throws(
    () =>
      connectionConfig({
        PG_LOCK_TIMEOUT_MS: "2000",
        PG_STATEMENT_TIMEOUT_MS: "2000",
      }),
    /less than/,
  );
  assert.throws(
    () =>
      connectionConfig({
        DATABASE_URL: "postgres://example/db?statement_timeout=0",
      }),
    /cannot override/,
  );
  assert.throws(
    () =>
      connectionConfig({
        DATABASE_URL: "postgres://example/db?options=-c%20lock_timeout%3D0",
      }),
    /cannot override/,
  );
  assert.throws(
    () => connectionConfig({ PGOPTIONS: "-c statement_timeout=0" }),
    /cannot override/,
  );
});

test("valid overrides preserve URL and keep server statement deadline larger than lock deadline", () => {
  const config = connectionConfig({
    DATABASE_URL: "postgres://example/db",
    PGPOOL_MAX: "8",
    PG_LOCK_TIMEOUT_MS: "100",
    PG_STATEMENT_TIMEOUT_MS: "500",
  });
  assert.equal(config.max, 8);
  assert.equal(config.connectionString, "postgres://example/db");
  assert.equal(config.lock_timeout, 100);
  assert.equal(config.statement_timeout, 500);
});
