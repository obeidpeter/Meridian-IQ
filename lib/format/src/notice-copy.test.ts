import { describe, expect, test } from "vitest";
import {
  AUTHORITY_LABELS,
  NOTICE_TYPE_LABELS,
  OBLIGATION_DUE_SOON_DAYS,
  OBLIGATION_STATUS_LABELS,
  TAX_TYPE_LABELS,
  authorityLabel,
  deadlineDaysUntil,
  localDayIso,
  noticeTypeLabel,
  obligationStatusLabel,
  taxTypeLabel,
} from "./notice-copy";

describe("notice-copy vocabulary", () => {
  test("maps cover the contract's closed catalogues", () => {
    expect(Object.keys(NOTICE_TYPE_LABELS).sort()).toEqual(
      [
        "assessment",
        "audit",
        "demand",
        "information_request",
        "other",
        "penalty",
        "reminder",
      ].sort(),
    );
    expect(Object.keys(AUTHORITY_LABELS).sort()).toEqual(
      ["customs", "firs", "other", "state_irs"].sort(),
    );
    expect(Object.keys(TAX_TYPE_LABELS).sort()).toEqual(
      ["cit", "other", "paye", "stamp_duty", "vat", "wht"].sort(),
    );
    expect(Object.keys(OBLIGATION_STATUS_LABELS).sort()).toEqual(
      ["closed", "open", "responded"].sort(),
    );
  });

  test("label helpers hit the maps and degrade off-catalogue tokens", () => {
    expect(noticeTypeLabel("information_request")).toBe("Information request");
    expect(authorityLabel("state_irs")).toBe("State IRS");
    expect(taxTypeLabel("stamp_duty")).toBe("Stamp duty");
    expect(obligationStatusLabel("open")).toBe("Awaiting response");
    expect(noticeTypeLabel("levy_review")).toBe("Levy review");
    expect(authorityLabel(null)).toBe("Unknown");
    expect(taxTypeLabel("")).toBe("Unknown");
  });
});

describe("deadline day-math", () => {
  test("localDayIso renders the local calendar day", () => {
    expect(localDayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDayIso(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("deadlineDaysUntil counts whole calendar days, signed", () => {
    expect(deadlineDaysUntil("2026-08-01", "2026-08-08")).toBe(7);
    expect(deadlineDaysUntil("2026-08-01", "2026-08-01")).toBe(0);
    expect(deadlineDaysUntil("2026-08-08", "2026-08-01")).toBe(-7);
    expect(deadlineDaysUntil("2026-08-01", "garbage")).toBeNaN();
    expect(deadlineDaysUntil("", "2026-08-01")).toBeNaN();
  });

  test("the shared due-soon window is 7 days", () => {
    expect(OBLIGATION_DUE_SOON_DAYS).toBe(7);
  });
});
