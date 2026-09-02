import { describe, test, expect } from "vitest";
import {
  acceptInviteLink,
  resetPasswordLink,
  invitationStatusTone,
  invitationStatusLabel,
  effectiveInvitationStatus,
  inviteClientLoginHref,
  readInvitationPrefill,
} from "./invitations";

describe("acceptInviteLink", () => {
  test("builds the landing /accept-invite URL from an origin and token", () => {
    expect(acceptInviteLink("https://app.meridian.example", "abc123")).toBe(
      "https://app.meridian.example/accept-invite#token=abc123",
    );
  });

  test("strips a trailing slash from the origin so the path is not doubled", () => {
    expect(acceptInviteLink("https://app.meridian.example/", "abc123")).toBe(
      "https://app.meridian.example/accept-invite#token=abc123",
    );
  });

  test("percent-encodes tokens containing URL-reserved characters", () => {
    expect(acceptInviteLink("https://x.test", "a b+c/d=e")).toBe(
      "https://x.test/accept-invite#token=a%20b%2Bc%2Fd%3De",
    );
  });

  test("keeps password-reset tokens out of the request URL too", () => {
    expect(resetPasswordLink("https://x.test", "reset token")).toBe(
      "https://x.test/reset-password#token=reset%20token",
    );
  });
});

describe("invitationStatusTone", () => {
  test("maps each invitation status onto its pill tone", () => {
    expect(invitationStatusTone("pending")).toBe("amber");
    expect(invitationStatusTone("accepted")).toBe("emerald");
    expect(invitationStatusTone("revoked")).toBe("slate");
    expect(invitationStatusTone("expired")).toBe("slate");
  });

  test("falls back to slate for an unrecognised status", () => {
    expect(invitationStatusTone("something-new")).toBe("slate");
  });
});

describe("invitationStatusLabel", () => {
  test("labels the known statuses", () => {
    expect(invitationStatusLabel("pending")).toBe("Pending");
    expect(invitationStatusLabel("accepted")).toBe("Accepted");
    expect(invitationStatusLabel("revoked")).toBe("Revoked");
    expect(invitationStatusLabel("expired")).toBe("Expired");
  });

  test("humanizes an unknown status for its label", () => {
    expect(invitationStatusLabel("weird_state")).toBe("Weird state");
  });
});

describe("effectiveInvitationStatus", () => {
  test("a pending invite past its expiry reads as expired", () => {
    expect(
      effectiveInvitationStatus(
        { status: "pending", expiresAt: "2026-01-01T00:00:00Z" },
        new Date("2026-02-01T00:00:00Z"),
      ),
    ).toBe("expired");
  });

  test("a pending invite before its expiry stays pending", () => {
    expect(
      effectiveInvitationStatus(
        { status: "pending", expiresAt: "2026-03-01T00:00:00Z" },
        new Date("2026-02-01T00:00:00Z"),
      ),
    ).toBe("pending");
  });

  test("terminal statuses never flip to expired", () => {
    expect(
      effectiveInvitationStatus(
        { status: "accepted", expiresAt: "2026-01-01T00:00:00Z" },
        new Date("2026-02-01T00:00:00Z"),
      ),
    ).toBe("accepted");
    expect(
      effectiveInvitationStatus(
        { status: "revoked", expiresAt: "2026-01-01T00:00:00Z" },
        new Date("2026-02-01T00:00:00Z"),
      ),
    ).toBe("revoked");
  });
});

describe("inviteClientLoginHref / readInvitationPrefill", () => {
  test("the client-detail link opens the form on client_user for that party", () => {
    const href = inviteClientLoginHref("cp-1");
    expect(href).toBe("/invitations?role=client_user&clientPartyId=cp-1");
    expect(readInvitationPrefill(href.slice(href.indexOf("?")))).toEqual({
      role: "client_user",
      clientPartyId: "cp-1",
    });
  });

  test("percent-encodes the party id and reads it back intact", () => {
    const href = inviteClientLoginHref("a b/c");
    expect(href).toContain("clientPartyId=a%20b%2Fc");
    expect(readInvitationPrefill(href.slice(href.indexOf("?"))).clientPartyId).toBe(
      "a b/c",
    );
  });

  test("an unknown or missing role falls back to firm_staff with no party", () => {
    expect(readInvitationPrefill("?role=operator")).toEqual({
      role: "firm_staff",
      clientPartyId: "",
    });
    expect(readInvitationPrefill("")).toEqual({
      role: "firm_staff",
      clientPartyId: "",
    });
  });
});
