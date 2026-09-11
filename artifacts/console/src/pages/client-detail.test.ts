import { test, expect, describe } from "vitest";
import {
  CLIENT_VIEW_FEATURES,
  OFFBOARD_EXPLANATION,
  canOffboardClient,
  currentMonthStart,
  exportFilename,
  offboardConfirmReady,
  offboardErrorNote,
  offboardSummary,
  packPdfFilename,
  visibleClientViews,
} from "./client-detail";

// View gating (PL-02): tabs follow Me.features exactly like the nav — a
// feature-dark view's API surfaces answer 404, so its tab hides rather than
// opening a dead pane. A view listing several keys shows when ANY is lit.

describe("visibleClientViews", () => {
  test("the launch profile (no flags) keeps only the ungated views", () => {
    expect(visibleClientViews(new Set([]))).toEqual([
      "today",
      "invoices",
      "setup",
    ]);
  });

  test("each flag lights exactly its own views", () => {
    expect(visibleClientViews(new Set(["collection_accounts"]))).toEqual([
      "today",
      "invoices",
      "money",
      "setup",
    ]);
    expect(visibleClientViews(new Set(["statutory_desks"]))).toEqual([
      "today",
      "invoices",
      "money",
      "compliance",
      "setup",
    ]);
    expect(visibleClientViews(new Set(["client_reports"]))).toEqual([
      "today",
      "invoices",
      "compliance",
      "setup",
    ]);
    expect(visibleClientViews(new Set(["clerk_ai"]))).toEqual([
      "today",
      "invoices",
      "clerk",
      "setup",
    ]);
  });

  test("all flags lit yields the full six views in declared order", () => {
    expect(
      visibleClientViews(
        new Set([
          "collection_accounts",
          "statutory_desks",
          "client_reports",
          "clerk_ai",
        ]),
      ),
    ).toEqual(["today", "invoices", "money", "compliance", "clerk", "setup"]);
  });

  test("only money, compliance and clerk carry feature gates", () => {
    expect(Object.keys(CLIENT_VIEW_FEATURES).sort()).toEqual([
      "clerk",
      "compliance",
      "money",
    ]);
  });
});

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
    expect(offboardErrorNote({})).toBe(
      "Could not end this client engagement. Try again.",
    );
  });

  test("a lost connection does not imply the engagement is still active", () => {
    expect(offboardErrorNote(new TypeError("Failed to fetch"))).toBe(
      "The connection was lost before Valo could confirm the result. Check your connection and the latest status before trying again.",
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
      "1 engagement archived · 2 sign-ins removed · 1 document forwarding address deleted · contact details cleared",
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
    expect(OFFBOARD_EXPLANATION).toContain(
      "Statutory invoice records are retained",
    );
    expect(OFFBOARD_EXPLANATION).toContain("sign-in access is removed");
    expect(OFFBOARD_EXPLANATION).toContain("engagement is archived");
    expect(OFFBOARD_EXPLANATION).toContain("last engagement");
  });
});
