import { test, expect, describe } from "vitest";
import {
  OFFBOARD_EXPLANATION,
  canOffboardClient,
  currentMonthStart,
  exportFilename,
  offboardConfirmReady,
  offboardErrorNote,
  offboardSummary,
  packPdfFilename,
} from "./client-detail";

// Export & offboarding helpers. The offboard guard is deliberately split:
// the dialog only requires SOMETHING typed, and the server's 400
// CONFIRM_MISMATCH stays the authority on whether it matches.

describe("exportFilename", () => {
  test("names the saved bundle after the client party", () => {
    expect(exportFilename("pty_1")).toBe("client-data-pty_1.json");
  });
});

describe("canOffboardClient", () => {
  test("firm_admin only — staff, operators and auditors never see the button", () => {
    expect(canOffboardClient("firm_admin")).toBe(true);
    for (const role of ["firm_staff", "operator", "auditor", "client_user"]) {
      expect(canOffboardClient(role)).toBe(false);
    }
    expect(canOffboardClient(undefined)).toBe(false);
  });
});

describe("offboardConfirmReady", () => {
  test("blank input never submits; any typed text goes to the server to judge", () => {
    expect(offboardConfirmReady("")).toBe(false);
    expect(offboardConfirmReady("   ")).toBe(false);
    expect(offboardConfirmReady("Acme Trading Ltd")).toBe(true);
    // Even a wrong name submits — the server's CONFIRM_MISMATCH answers.
    expect(offboardConfirmReady("wrong name")).toBe(true);
  });
});

describe("offboardErrorNote", () => {
  test("a 400 is the confirm-mismatch guard, in words", () => {
    expect(offboardErrorNote({ status: 400 })).toBe(
      "That doesn't match this client's legal name — type it exactly as shown.",
    );
  });

  test("other failures relay the server's words when it sent any", () => {
    expect(
      offboardErrorNote({
        status: 409,
        data: { error: "Engagement already archived" },
      }),
    ).toBe("Engagement already archived");
  });

  test("a wordless failure falls back to the plain try-again line", () => {
    expect(offboardErrorNote(new Error("network"))).toBe(
      "Could not offboard the client. Try again.",
    );
  });
});

describe("offboardSummary", () => {
  test("counts every action, pluralized, with the contact-PII outcome", () => {
    expect(
      offboardSummary({
        engagementsArchived: 1,
        membershipsRemoved: 2,
        aliasesDeleted: 1,
        contactCleared: true,
        lastEngagement: true,
      }),
    ).toBe(
      "1 engagement archived · 2 sign-ins removed · 1 intake alias deleted · contact details cleared",
    );
  });

  test("zero aliases stay out of the line; a shared client keeps its contact", () => {
    expect(
      offboardSummary({
        engagementsArchived: 1,
        membershipsRemoved: 0,
        aliasesDeleted: 0,
        contactCleared: false,
        lastEngagement: false,
      }),
    ).toBe(
      "1 engagement archived · 0 sign-ins removed · contact details kept (still engaged elsewhere)",
    );
  });
});

describe("packPdfFilename", () => {
  test("names the saved pack after its month", () => {
    expect(packPdfFilename("2026-07-01")).toBe("compliance-pack-2026-07.pdf");
    expect(packPdfFilename("2025-12-01")).toBe("compliance-pack-2025-12.pdf");
  });

  test("a malformed month start still yields a usable filename", () => {
    expect(packPdfFilename("")).toBe("compliance-pack.pdf");
  });
});

describe("currentMonthStart", () => {
  test("first day of the given date's month, zero-padded", () => {
    // Local-time constructor so the assertion is timezone-proof.
    expect(currentMonthStart(new Date(2026, 6, 28))).toBe("2026-07-01");
    expect(currentMonthStart(new Date(2026, 0, 3))).toBe("2026-01-01");
    expect(currentMonthStart(new Date(2025, 11, 31))).toBe("2025-12-01");
  });
});

describe("OFFBOARD_EXPLANATION", () => {
  test("states retention, access removal and the last-engagement PII rule", () => {
    expect(OFFBOARD_EXPLANATION).toContain("Statutory invoice records are retained");
    expect(OFFBOARD_EXPLANATION).toContain("sign-in access is removed");
    expect(OFFBOARD_EXPLANATION).toContain("engagement is archived");
    expect(OFFBOARD_EXPLANATION).toContain("last engagement");
  });
});
