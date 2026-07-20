import { describe, expect, test } from "vitest";
import { MFA_TOKEN_TTL_MS, mfaChallengeDisposition } from "./mfa";

// The server answers a UNIFORM 401 for a wrong code and an expired mfa
// token (no oracle), so only the client's clock can tell "retry the code"
// from "start over with your password". The boundary is the load-bearing
// part: exactly at the TTL the token is expired.

describe("mfaChallengeDisposition", () => {
  const issuedAt = 1_753_000_000_000;

  test("a 401 inside the TTL is a wrong code — stay and retry", () => {
    expect(
      mfaChallengeDisposition({ status: 401, issuedAt, now: issuedAt }),
    ).toBe("invalid-code");
    expect(
      mfaChallengeDisposition({
        status: 401,
        issuedAt,
        now: issuedAt + MFA_TOKEN_TTL_MS - 1,
      }),
    ).toBe("invalid-code");
  });

  test("a 401 at or past the TTL restarts from the password step", () => {
    expect(
      mfaChallengeDisposition({
        status: 401,
        issuedAt,
        now: issuedAt + MFA_TOKEN_TTL_MS,
      }),
    ).toBe("restart");
    expect(
      mfaChallengeDisposition({
        status: 401,
        issuedAt,
        now: issuedAt + MFA_TOKEN_TTL_MS + 60_000,
      }),
    ).toBe("restart");
  });

  test("non-401 failures are server errors, however old the token is", () => {
    expect(
      mfaChallengeDisposition({ status: 500, issuedAt, now: issuedAt }),
    ).toBe("server-error");
    expect(
      mfaChallengeDisposition({
        status: 429,
        issuedAt,
        now: issuedAt + MFA_TOKEN_TTL_MS * 2,
      }),
    ).toBe("server-error");
  });

  test("no status at all means the server was unreachable", () => {
    expect(
      mfaChallengeDisposition({ status: undefined, issuedAt, now: issuedAt }),
    ).toBe("network-error");
  });
});
