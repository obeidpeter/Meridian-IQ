import { describe, expect, test } from "vitest";
import {
  governanceCardState,
  isFirmAdminRole,
} from "./governance-card";

// The governance card's self-gate: the PUT is firm-admin only, so the card
// renders only for firm admins — and the load-failure split mirrors the
// staff-prefs precedent (403 is the server's final no; anything else is a
// transient failure that must not silently remove a policy control).

describe("isFirmAdminRole", () => {
  test("firm_admin only — staff, operators, auditors and clients never see the card", () => {
    expect(isFirmAdminRole("firm_admin")).toBe(true);
    for (const role of ["firm_staff", "operator", "auditor", "client_user"]) {
      expect(isFirmAdminRole(role)).toBe(false);
    }
    expect(isFirmAdminRole(undefined)).toBe(false);
    expect(isFirmAdminRole(null)).toBe(false);
  });
});

describe("governanceCardState", () => {
  const base = {
    firmAdmin: true,
    isError: false,
    errorStatus: undefined as number | undefined,
    isSuccess: false,
  };

  test("non-admins are hidden whatever the query says", () => {
    expect(governanceCardState({ ...base, firmAdmin: false })).toBe("hidden");
    expect(
      governanceCardState({
        ...base,
        firmAdmin: false,
        isSuccess: true,
      }),
    ).toBe("hidden");
  });

  test("a 403 is the server's own final answer — hidden, not an error card", () => {
    expect(
      governanceCardState({ ...base, isError: true, errorStatus: 403 }),
    ).toBe("hidden");
  });

  test("any other failure renders the inline error with its retry", () => {
    expect(
      governanceCardState({ ...base, isError: true, errorStatus: 500 }),
    ).toBe("error");
    expect(
      governanceCardState({ ...base, isError: true, errorStatus: undefined }),
    ).toBe("error");
  });

  test("loading stays quiet; success renders the form", () => {
    expect(governanceCardState(base)).toBe("loading");
    expect(governanceCardState({ ...base, isSuccess: true })).toBe("form");
  });
});
