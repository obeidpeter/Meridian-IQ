// The two-step sign-in's expiry decision, extracted pure so it can be unit
// tested without mounting the portal.

// The server's mfa pending token lives 5 minutes (api-server
// modules/auth/totp.ts). The challenge endpoint answers a uniform 401 for a
// wrong code AND an expired token, so the client tells them apart by its own
// clock.
export const MFA_TOKEN_TTL_MS = 5 * 60 * 1000;

export type MfaChallengeDisposition =
  /** 401 at/after the TTL: the token lapsed — restart from the password step. */
  | "restart"
  /** 401 inside the TTL: the code was wrong — stay on the code step and retry. */
  | "invalid-code"
  /** Any other HTTP failure: relay the server's words. */
  | "server-error"
  /** No HTTP status at all: the server was unreachable. */
  | "network-error";

/**
 * Classify a failed TOTP challenge. The 401 split is the load-bearing part:
 * the server deliberately answers the same 401 for "wrong code" and "expired
 * token" (no oracle), so only the client's own clock — how long ago it was
 * handed the mfa token — can distinguish "try the code again" from "start
 * over with your password".
 */
export function mfaChallengeDisposition(args: {
  status: number | undefined;
  issuedAt: number;
  now: number;
}): MfaChallengeDisposition {
  if (args.status === 401) {
    return args.now - args.issuedAt >= MFA_TOKEN_TTL_MS
      ? "restart"
      : "invalid-code";
  }
  return args.status !== undefined ? "server-error" : "network-error";
}
