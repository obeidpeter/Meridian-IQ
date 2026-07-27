import { test } from "node:test";
import assert from "node:assert/strict";
import { MFA_TOKEN_TTL_MS, mfaChallengeDisposition } from "./mfa.ts";

// The server answers a UNIFORM 401 for a wrong code and an expired mfa
// token (no oracle), so only the client's clock can tell "retry the code"
// from "start over with your password". The boundary is the load-bearing
// part: exactly at the TTL the token is expired. These cases mirror the
// landing portal's mfa.test.ts — the parity copy must not drift.

const issuedAt = 1_753_000_000_000;

test("a 401 inside the TTL is a wrong code — stay and retry", () => {
  assert.equal(
    mfaChallengeDisposition({ status: 401, issuedAt, now: issuedAt }),
    "invalid-code",
  );
  assert.equal(
    mfaChallengeDisposition({
      status: 401,
      issuedAt,
      now: issuedAt + MFA_TOKEN_TTL_MS - 1,
    }),
    "invalid-code",
  );
});

test("a 401 at or past the TTL restarts from the password step", () => {
  assert.equal(
    mfaChallengeDisposition({
      status: 401,
      issuedAt,
      now: issuedAt + MFA_TOKEN_TTL_MS,
    }),
    "restart",
  );
  assert.equal(
    mfaChallengeDisposition({
      status: 401,
      issuedAt,
      now: issuedAt + MFA_TOKEN_TTL_MS + 60_000,
    }),
    "restart",
  );
});

test("non-401 failures are server errors, however old the token is", () => {
  assert.equal(
    mfaChallengeDisposition({ status: 500, issuedAt, now: issuedAt }),
    "server-error",
  );
  assert.equal(
    mfaChallengeDisposition({
      status: 429,
      issuedAt,
      now: issuedAt + MFA_TOKEN_TTL_MS * 2,
    }),
    "server-error",
  );
});

test("no status at all means the server was unreachable", () => {
  assert.equal(
    mfaChallengeDisposition({ status: undefined, issuedAt, now: issuedAt }),
    "network-error",
  );
});
