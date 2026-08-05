import { test, expect, describe } from "vitest";
import { planPolicyStatusLine, showFirstInvoiceCta } from "./dashboard";

// The receivables card's first-run nudge: a quiet "create your first invoice"
// link, and ONLY for a book with no invoices at all — an active book whose
// receivables are simply settled has earned silence, not a nag.
describe("showFirstInvoiceCta", () => {
  test("shows only when the client has no invoices at all", () => {
    expect(showFirstInvoiceCta(0)).toBe(true);
  });

  test("an active book — even fully settled — is never nagged", () => {
    expect(showFirstInvoiceCta(1)).toBe(false);
    expect(showFirstInvoiceCta(37)).toBe(false);
  });

  test("no summary yet (loading or failed) means no nudge — never guess", () => {
    expect(showFirstInvoiceCta(undefined)).toBe(false);
  });
});

// The monthly-automation strip's status line (round 33). "Up to date for",
// never "last ran": a month is also consumed by the honest closing-window
// empty, and there is no month-end event to promise — the hourly sweep
// runs the first pass that finds eligible paper.
describe("planPolicyStatusLine", () => {
  test("a fresh grant promises eligibility, not a calendar event", () => {
    expect(
      planPolicyStatusLine({ pausedAt: null, pausedReason: null, lastRunMonth: null }),
    ).toBe("Runs monthly · runs when there is eligible paper");
  });

  test("a consumed month reads as up-to-date, not as a claimed run", () => {
    expect(
      planPolicyStatusLine({
        pausedAt: null,
        pausedReason: null,
        lastRunMonth: "2026-08",
      }),
    ).toBe("Runs monthly · up to date for 2026-08");
  });

  test("every tripwire reason has legible copy; unknown reasons stay honest", () => {
    expect(
      planPolicyStatusLine({ pausedAt: "2026-08-01T00:00:00Z", pausedReason: "run_halted" }),
    ).toBe("Paused — the last run halted");
    expect(
      planPolicyStatusLine({
        pausedAt: "2026-08-01T00:00:00Z",
        pausedReason: "grantor_inactive",
      }),
    ).toBe("Paused — the approver's access changed");
    expect(
      planPolicyStatusLine({
        pausedAt: "2026-08-01T00:00:00Z",
        pausedReason: "something_new",
      }),
    ).toBe("Paused");
  });
});
