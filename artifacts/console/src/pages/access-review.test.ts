import { describe, expect, test } from "vitest";
import { memberFlags } from "./access-review";

// The register's attention flags (D14): MFA is expected of firm roles, not
// of client users (their MFA is opt-in on the SME side); "never signed in"
// flags an account that was provisioned but not used.
describe("memberFlags", () => {
  const base = {
    userId: "u", fullName: null, email: null, role: "firm_staff",
    clientPartyId: null, since: "2026-01-01T00:00:00.000Z",
    lastSignInAt: "2026-02-01T00:00:00.000Z", mfaEnabled: true, assignedClients: [],
  };
  test("a healthy firm member carries no flags", () => {
    expect(memberFlags(base)).toEqual([]);
  });
  test("firm roles without MFA and accounts never used are flagged", () => {
    expect(memberFlags({ ...base, mfaEnabled: false })).toEqual(["No MFA"]);
    expect(memberFlags({ ...base, lastSignInAt: null })).toEqual(["Never signed in"]);
    expect(memberFlags({ ...base, mfaEnabled: false, lastSignInAt: null })).toEqual([
      "No MFA",
      "Never signed in",
    ]);
  });
  test("client users are not flagged for MFA", () => {
    expect(memberFlags({ ...base, role: "client_user", mfaEnabled: false })).toEqual([]);
  });
});
