import { humanize, type BadgeTone } from "./format";

// Pure helpers for the Team invitations page (IDN-01). Kept DOM-free and free
// of React so they can be unit-tested under the node vitest environment.

/**
 * Build the public accept-invite link the invited person opens to redeem their
 * one-time token. The landing app serves `/accept-invite` and reads the token
 * from the URL fragment. Fragments never reach the web server, reverse proxy,
 * referrer header, or access log. The origin is trailing-slash-stripped and
 * the token is percent-encoded so any token shape yields a well-formed URL.
 */
export function acceptInviteLink(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/accept-invite#token=${encodeURIComponent(token)}`;
}

/** One-time password-reset link (IDN-02), mirroring the invite link shape. */
export function resetPasswordLink(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/reset-password#token=${encodeURIComponent(token)}`;
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
    case "expired":
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
    case "expired":
      return "Expired";
    default:
      return humanize(status);
  }
}

/**
 * The status a row should display. A pending invitation past its expiresAt
 * is dead on the wire (the redeem endpoint rejects it) but the stored enum
 * still says "pending" — derive "expired" here so the admin can see which
 * pending invites actually need re-issuing. Terminal statuses pass through.
 */
export function effectiveInvitationStatus(
  inv: { status: string; expiresAt: string },
  now: Date = new Date(),
): string {
  if (
    inv.status === "pending" &&
    new Date(inv.expiresAt).getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return inv.status;
}

/**
 * Where the console sends an admin who wants a client user invited for the
 * client they are already looking at. The invitations page reads both
 * params back through readInvitationPrefill, so the form opens on the
 * client_user role with that party preselected.
 */
export function inviteClientLoginHref(clientPartyId: string): string {
  return `/invitations?role=client_user&clientPartyId=${encodeURIComponent(clientPartyId)}`;
}

/**
 * The invitations form's prefill, read from the page's query string: a
 * client_user role is honoured, anything else falls back to firm_staff; the
 * party id is passed through untouched (the server validates it against an
 * engagement on submit).
 */
export function readInvitationPrefill(search: string): {
  role: "client_user" | "firm_staff";
  clientPartyId: string;
} {
  const params = new URLSearchParams(search);
  return {
    role: params.get("role") === "client_user" ? "client_user" : "firm_staff",
    clientPartyId: params.get("clientPartyId") ?? "",
  };
}
