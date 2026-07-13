import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import {
  isLoginThrottled,
  recordLoginFailure,
  clearLoginFailures,
} from "./throttle.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Persistent login throttle: DB-backed so the cap holds across instances, and
// written on the raw pool so a failed login's 4xx rollback does not discard the
// attempt. Salted emails keep the shared login_attempts table clean per run.

const SALT = makeRunSalt();

// Minimal Request stand-ins: only req.ip / req.socket.remoteAddress are read.
function reqFrom(ip: string) {
  return { ip, socket: { remoteAddress: ip } } as unknown as Parameters<
    typeof isLoginThrottled
  >[0];
}

before(async () => {
  // Ensure a clean slate for this run's keys (defensive; salt already isolates).
  await pool.query("DELETE FROM login_attempts WHERE key LIKE $1", [`%${SALT}%`]);
});

test("per email+IP: throttles after 5 failures from one source", async () => {
  const email = `ipcap-${SALT}@test.local`;
  const req = reqFrom("203.0.113.10");
  for (let i = 0; i < 5; i++) {
    assert.equal(await isLoginThrottled(req, email), null, `attempt ${i} allowed`);
    await recordLoginFailure(req, email);
  }
  const wait = await isLoginThrottled(req, email);
  assert.ok(wait !== null && wait > 0, "6th attempt from same IP is throttled");
});

test("a successful login clears the counters for that key", async () => {
  const email = `clear-${SALT}@test.local`;
  const req = reqFrom("203.0.113.20");
  for (let i = 0; i < 5; i++) await recordLoginFailure(req, email);
  assert.ok((await isLoginThrottled(req, email)) !== null);
  await clearLoginFailures(req, email);
  assert.equal(await isLoginThrottled(req, email), null);
});

test("per-account cap holds across many distinct source IPs (distributed stuffing)", async () => {
  const email = `acct-${SALT}@test.local`;
  // Five failures each from ten different IPs: no single IP hits the per-IP cap
  // (each is at 5, not over), but the account cap (50/hour) is reached.
  for (let ip = 0; ip < 10; ip++) {
    const req = reqFrom(`198.51.100.${ip}`);
    for (let i = 0; i < 5; i++) await recordLoginFailure(req, email);
  }
  // A fresh IP that has never failed is still blocked by the account counter.
  const freshWait = await isLoginThrottled(reqFrom("192.0.2.1"), email);
  assert.ok(
    freshWait !== null && freshWait > 0,
    "account cap blocks even an unseen IP",
  );
});

test("failures persist independently of a rolled-back request (raw pool write)", async () => {
  // recordLoginFailure uses pool.query directly, so the row exists immediately
  // and is visible to a separate read — the property that survives the login
  // route's 4xx transaction rollback.
  const email = `persist-${SALT}@test.local`;
  const req = reqFrom("203.0.113.30");
  await recordLoginFailure(req, email);
  const { rows } = await pool.query(
    "SELECT count FROM login_attempts WHERE key = $1",
    [`${email}|203.0.113.30`],
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].count), 1);
});
