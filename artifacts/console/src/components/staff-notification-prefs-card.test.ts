import { test, expect, describe } from "vitest";
import {
  canRequestVerification,
  emailVerificationState,
  isFirmMemberRole,
  prefsCardState,
  prefsFormFromServer,
  prefsUpdatePayload,
  verificationCodeValid,
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

// The card's render split. The load-bearing distinction: a role that should
// never see the card hides it, but a TRANSIENT load failure for a firm member
// must render an error with a retry — error ≠ hidden, or one 500 silently
// removes a settings form.
describe("prefsCardState", () => {
  const base = {
    firmMember: true,
    isError: false,
    errorStatus: undefined,
    isSuccess: false,
  };

  test("non-firm-members stay hidden regardless of query state", () => {
    expect(prefsCardState({ ...base, firmMember: false })).toBe("hidden");
    expect(
      prefsCardState({
        ...base,
        firmMember: false,
        isError: true,
        errorStatus: 500,
      }),
    ).toBe("hidden");
  });

  test("a transient failure for a firm member is ERROR, never hidden", () => {
    expect(
      prefsCardState({ ...base, isError: true, errorStatus: 500 }),
    ).toBe("error");
    // Network-level failure carries no HTTP status at all.
    expect(
      prefsCardState({ ...base, isError: true, errorStatus: undefined }),
    ).toBe("error");
  });

  test("the server's own 403 is a final not-a-firm-member answer — hidden", () => {
    expect(
      prefsCardState({ ...base, isError: true, errorStatus: 403 }),
    ).toBe("hidden");
  });

  test("loading renders nothing yet; success renders the form", () => {
    expect(prefsCardState(base)).toBe("loading");
    expect(prefsCardState({ ...base, isSuccess: true })).toBe("form");
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
        emailVerifiedAt: null,
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
        emailVerifiedAt: "2026-07-01T09:00:00Z",
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

// ---- Email verification -----------------------------------------------------
// The badge derives from on-screen text vs the saved row: the verified stamp
// belongs to the SAVED address, so editing the field must visibly drop back
// to "unverified" the moment the text stops matching it.
describe("emailVerificationState", () => {
  const verified = {
    savedEmail: "ada@firm.ng",
    emailVerifiedAt: "2026-07-01T09:00:00Z",
  };

  test("a blank field carries no badge at all", () => {
    expect(
      emailVerificationState({ formEmail: "", ...verified }),
    ).toBe("none");
    expect(
      emailVerificationState({ formEmail: "   ", ...verified }),
    ).toBe("none");
  });

  test("verified only when the on-screen email IS the saved, stamped address", () => {
    expect(
      emailVerificationState({ formEmail: "ada@firm.ng", ...verified }),
    ).toBe("verified");
    // Whitespace around the same address still matches (the PUT trims too).
    expect(
      emailVerificationState({ formEmail: " ada@firm.ng ", ...verified }),
    ).toBe("verified");
  });

  test("editing the email visibly resets to unverified", () => {
    expect(
      emailVerificationState({ formEmail: "new@firm.ng", ...verified }),
    ).toBe("unverified");
  });

  test("a saved address without a stamp is unverified", () => {
    expect(
      emailVerificationState({
        formEmail: "ada@firm.ng",
        savedEmail: "ada@firm.ng",
        emailVerifiedAt: null,
      }),
    ).toBe("unverified");
  });

  test("an address never saved is unverified — nothing to have stamped", () => {
    expect(
      emailVerificationState({
        formEmail: "ada@firm.ng",
        savedEmail: null,
        emailVerifiedAt: null,
      }),
    ).toBe("unverified");
  });
});

describe("canRequestVerification", () => {
  test("only when the on-screen email is the saved address — the code goes to the SAVED inbox", () => {
    expect(
      canRequestVerification({
        formEmail: "ada@firm.ng",
        savedEmail: "ada@firm.ng",
      }),
    ).toBe(true);
    expect(
      canRequestVerification({
        formEmail: "edited@firm.ng",
        savedEmail: "ada@firm.ng",
      }),
    ).toBe(false);
    expect(
      canRequestVerification({ formEmail: "ada@firm.ng", savedEmail: null }),
    ).toBe(false);
    expect(canRequestVerification({ formEmail: "", savedEmail: null })).toBe(
      false,
    );
  });
});

describe("verificationCodeValid", () => {
  test("mirrors the wire contract's 6–8 character bounds, trimmed", () => {
    expect(verificationCodeValid("123456")).toBe(true);
    expect(verificationCodeValid(" 123456 ")).toBe(true);
    expect(verificationCodeValid("12345678")).toBe(true);
    expect(verificationCodeValid("12345")).toBe(false);
    expect(verificationCodeValid("123456789")).toBe(false);
    expect(verificationCodeValid("")).toBe(false);
  });
});
