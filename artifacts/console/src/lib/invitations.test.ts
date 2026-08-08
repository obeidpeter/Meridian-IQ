import { describe, test, expect } from "vitest";
import {
  acceptInviteLink,
  resetPasswordLink,
  invitationStatusTone,
  invitationStatusLabel,
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
  });

  test("humanizes an unknown status for its label", () => {
    expect(invitationStatusLabel("weird_state")).toBe("Weird state");
  });
});
