import { humanize, type BadgeTone } from "./format";

// Pure helpers for the Team invitations page (IDN-01). Kept DOM-free and free
// of React so they can be unit-tested under the node vitest environment.

/**
 * Build the public accept-invite link the invited person opens to redeem their
 * one-time token. The landing app serves `/accept-invite` and reads the token
 * from the `token` query param. The origin is trailing-slash-stripped so the
 * path is never doubled, and the token is percent-encoded so any token shape
 * yields a well-formed URL.
 */
export function acceptInviteLink(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** One-time password-reset link (IDN-02), mirroring the invite link shape. */
export function resetPasswordLink(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Pill tone for an invitation lifecycle status (design language §8). */
export function invitationStatusTone(status: string): BadgeTone {
  switch (status) {
    case "pending":
      return "amber";
    case "accepted":
      return "emerald";
    case "revoked":
      return "slate";
    default:
      return "slate";
  }
}

/** Human-readable label for an invitation status. */
export function invitationStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "accepted":
      return "Accepted";
    case "revoked":
      return "Revoked";
    default:
      return humanize(status);
  }
}
