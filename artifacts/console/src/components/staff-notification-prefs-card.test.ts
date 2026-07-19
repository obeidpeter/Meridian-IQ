import { test, expect, describe } from "vitest";
import {
  isFirmMemberRole,
  prefsFormFromServer,
  prefsUpdatePayload,
} from "./staff-notification-prefs-card";

// Staff notification preferences: the card's role gate mirrors the server's
// 403 (firm members only), and the form<->wire mapping keeps the nullable
// email honest.

describe("isFirmMemberRole", () => {
  test("firm_admin and firm_staff are the two firm-member roles", () => {
    expect(isFirmMemberRole("firm_admin")).toBe(true);
    expect(isFirmMemberRole("firm_staff")).toBe(true);
  });

  test("platform and client roles are not — the server would 403 them", () => {
    expect(isFirmMemberRole("operator")).toBe(false);
    expect(isFirmMemberRole("auditor")).toBe(false);
    expect(isFirmMemberRole("client_user")).toBe(false);
    expect(isFirmMemberRole(undefined)).toBe(false);
    expect(isFirmMemberRole(null)).toBe(false);
  });
});

describe("prefsFormFromServer", () => {
  test("maps the saved row onto the form; a null email renders empty", () => {
    expect(
      prefsFormFromServer({
        digestEnabled: true,
        emailEnabled: false,
        pushEnabled: true,
        email: null,
      }),
    ).toEqual({
      digestEnabled: true,
      emailEnabled: false,
      pushEnabled: true,
      email: "",
    });
    expect(
      prefsFormFromServer({
        digestEnabled: false,
        emailEnabled: true,
        pushEnabled: false,
        email: "ada@firm.ng",
      }).email,
    ).toBe("ada@firm.ng");
  });
});

describe("prefsUpdatePayload", () => {
  const form = {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: false,
    email: " ada@firm.ng ",
  };

  test("sends every switch explicitly (the PUT merges partial input) and trims the email", () => {
    expect(prefsUpdatePayload(form)).toEqual({
      digestEnabled: true,
      emailEnabled: true,
      pushEnabled: false,
      email: "ada@firm.ng",
    });
  });

  test("a blank or whitespace-only email is an explicit null — clear, never ''", () => {
    expect(prefsUpdatePayload({ ...form, email: "" }).email).toBeNull();
    expect(prefsUpdatePayload({ ...form, email: "   " }).email).toBeNull();
  });

  test("all-off is a valid payload — opting back out sends the falses", () => {
    expect(
      prefsUpdatePayload({
        digestEnabled: false,
        emailEnabled: false,
        pushEnabled: false,
        email: "",
      }),
    ).toEqual({
      digestEnabled: false,
      emailEnabled: false,
      pushEnabled: false,
      email: null,
    });
  });
});
