import { test, expect, describe } from "vitest";
// Runtime enum values, straight from the generated contract package, so the
// exhaustiveness assertion below cannot drift from openapi.yaml.
import { ActionTargetOutcomeOutcome } from "@workspace/api-zod";
import {
  ACTION_OUTCOME_LABELS,
  actionOutcomeToneClasses,
  badgeClasses,
  confirmationBadgeClasses,
  confirmationLabel,
  CSID_EXPANSION,
  formatAmount,
  formatCompactNaira,
  formatDate,
  formatDateTime,
  formatLagosDate,
  formatNaira,
  formatPct,
  humanize,
  IRN_EXPANSION,
  lagosDayDiff,
  pillClasses,
  severityBadgeClasses,
  severityLabel,
  statusLabel,
  statusTone,
  summaryPillClasses,
  roleLabel,
  roleHomeHref,
  recentQuestionRows,
} from "./index";

describe("formatNaira", () => {
  test("returns the em-dash sentinel for null, undefined, and non-numeric input", () => {
    expect(formatNaira(null)).toBe("—");
    expect(formatNaira(undefined)).toBe("—");
    expect(formatNaira("abc")).toBe("—");
  });

  test("formats numeric values as NGN currency with 2 fraction digits", () => {
    // Assert the grouped/decimal number part rather than the ICU currency
    // symbol so the test survives ICU variance.
    expect(formatNaira(150000)).toContain("150,000.00");
    expect(formatNaira("1234.5")).toContain("1,234.50");
    expect(formatNaira(0)).not.toBe("—");
  });
});

describe("formatAmount", () => {
  test("NGN routes through the naira formatter exactly", () => {
    expect(formatAmount(1500, "NGN")).toBe(formatNaira(1500));
  });

  test("foreign currencies render as a grouped number plus the code", () => {
    expect(formatAmount("1200.5", "USD")).toBe("1,200.50 USD");
  });

  test("returns the em-dash sentinel for null and non-numeric input", () => {
    expect(formatAmount(null, "USD")).toBe("—");
    expect(formatAmount("abc", "EUR")).toBe("—");
  });
});

describe("stamp identifier vocabulary", () => {
  test("the shared first-use expansions cannot drift between surfaces", () => {
    expect(IRN_EXPANSION).toBe("Invoice Reference Number");
    expect(CSID_EXPANSION).toBe("Cryptographic Stamp ID");
  });
});

describe("formatCompactNaira", () => {
  test("returns the em-dash sentinel for null, undefined, and non-numeric input", () => {
    expect(formatCompactNaira(null)).toBe("—");
    expect(formatCompactNaira(undefined)).toBe("—");
    expect(formatCompactNaira("abc")).toBe("—");
  });

  test("compacts large amounts to at most one fraction digit", () => {
    expect(formatCompactNaira(1_200_000)).toContain("1.2M");
    expect(formatCompactNaira("2500")).toContain("2.5K");
    expect(formatCompactNaira(0)).not.toBe("—");
  });
});

describe("formatPct", () => {
  test("returns the em-dash sentinel for null, undefined, and non-numeric input", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(undefined)).toBe("—");
    expect(formatPct("abc")).toBe("—");
  });

  test("scales a fraction to a percentage with one fraction digit by default", () => {
    expect(formatPct(0.5)).toBe("50.0%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct("0.5")).toBe("50.0%");
  });

  test("honours the digits argument", () => {
    expect(formatPct(0.125, 2)).toBe("12.50%");
    expect(formatPct(0.2, 0)).toBe("20%");
  });
});

describe("formatDate", () => {
  test("returns the em-dash sentinel for falsy and unparseable input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  test("formats a Date as a day-short month-year string", () => {
    // Build the Date from local components so the rendered day cannot drift
    // across the test runner's timezone.
    const out = formatDate(new Date(2026, 0, 15));
    expect(out).toContain("15");
    expect(out).toContain("Jan");
    expect(out).toContain("2026");
  });
});

describe("formatDateTime", () => {
  test("returns the em-dash sentinel for falsy and unparseable input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  test("appends a 24-hour time to the date", () => {
    const out = formatDateTime(new Date(2026, 0, 15, 9, 5));
    expect(out).toContain("2026");
    // A HH:MM clock component is present regardless of ICU locale details.
    expect(out).toMatch(/\d{2}:\d{2}/);
  });
});

describe("formatLagosDate", () => {
  test("returns the em-dash sentinel for falsy and unparseable input", () => {
    expect(formatLagosDate(null)).toBe("—");
    expect(formatLagosDate(undefined)).toBe("—");
    expect(formatLagosDate("")).toBe("—");
    expect(formatLagosDate("not-a-date")).toBe("—");
  });

  test("renders the Lagos statutory day for a Lagos-midnight instant", () => {
    // Lagos midnight of 21 September 2026 is 20 Sep 23:00 UTC — an
    // un-pinned formatter shows the 20th from any UTC-or-west runner.
    const out = formatLagosDate("2026-09-20T23:00:00.000Z");
    expect(out).toContain("21");
    expect(out).toContain("Sep");
    expect(out).toContain("2026");
  });
});

describe("lagosDayDiff", () => {
  test("returns null for falsy and unparseable input", () => {
    expect(lagosDayDiff(null)).toBeNull();
    expect(lagosDayDiff(undefined)).toBeNull();
    expect(lagosDayDiff("not-a-date")).toBeNull();
  });

  test("wall-clock hours never shrink the countdown (the eve-of-deadline bug)", () => {
    // 13:00 Lagos on the 20th to Lagos midnight of the 21st is 11 wall-clock
    // hours but one full Lagos calendar day — the old ms-rounding said 0.
    const eveAfternoon = new Date("2026-09-20T12:00:00.000Z"); // 13:00 WAT
    const lagosMidnight21st = new Date("2026-09-20T23:00:00.000Z");
    expect(lagosDayDiff(lagosMidnight21st, eveAfternoon)).toBe(1);
  });

  test("counts whole Lagos calendar days, sign included", () => {
    const base = new Date("2026-09-10T09:00:00.000Z");
    expect(lagosDayDiff("2026-09-10T15:00:00.000Z", base)).toBe(0);
    expect(lagosDayDiff("2026-09-13T09:00:00.000Z", base)).toBe(3);
    expect(lagosDayDiff("2026-09-08T09:00:00.000Z", base)).toBe(-2);
  });
});

describe("humanize", () => {
  test("replaces underscores/hyphens with spaces and upper-cases the first char", () => {
    expect(humanize("buyer_flag")).toBe("Buyer flag");
    expect(humanize("credit-note")).toBe("Credit note");
    expect(humanize("multi__word--thing")).toBe("Multi word thing");
  });

  test("returns 'Unknown' for empty, whitespace-only, and nullish input", () => {
    expect(humanize("")).toBe("Unknown");
    expect(humanize("   ")).toBe("Unknown");
    expect(humanize(null)).toBe("Unknown");
    expect(humanize(undefined)).toBe("Unknown");
  });

  test("preserves the casing of characters after the first", () => {
    expect(humanize("already Nice")).toBe("Already Nice");
  });
});

describe("pillClasses", () => {
  test("combines the pill recipe with the tone's light and dark classes", () => {
    const out = pillClasses("emerald");
    expect(out).toContain("rounded-full");
    expect(out).toContain("bg-emerald-100");
    expect(out).toContain("dark:bg-emerald-950");
  });
});

describe("summaryPillClasses", () => {
  test("the borderless header-count recipe, per tone, light and dark", () => {
    expect(summaryPillClasses("amber")).toBe(
      "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    );
    expect(summaryPillClasses("emerald")).toBe(
      "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    );
    // Borderless by design — distinct from the bordered pillClasses recipe.
    expect(summaryPillClasses("amber")).not.toContain("border");
  });
});

describe("statusTone", () => {
  test("collapses raw lifecycle statuses onto tone buckets", () => {
    expect(statusTone("draft")).toBe("draft");
    expect(statusTone("validated")).toBe("draft");
    expect(statusTone("submitted")).toBe("pending");
    expect(statusTone("stamped")).toBe("stamped");
    expect(statusTone("confirmed")).toBe("stamped");
    expect(statusTone("settled")).toBe("settled");
    expect(statusTone("credited")).toBe("credited");
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("cancelled")).toBe("cancelled");
  });

  test("falls back to 'unknown' for unrecognised statuses", () => {
    expect(statusTone("something-new")).toBe("unknown");
  });
});

describe("statusLabel", () => {
  test("distinguishes the two statuses that share the draft tone", () => {
    expect(statusLabel("validated")).toBe("Validated");
    expect(statusLabel("draft")).toBe("Draft");
  });

  test("distinguishes the two statuses that share the stamped tone", () => {
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("stamped")).toBe("Stamped");
  });

  test("labels the remaining tones", () => {
    expect(statusLabel("submitted")).toBe("Awaiting stamp");
    expect(statusLabel("settled")).toBe("Settled");
    expect(statusLabel("credited")).toBe("Credited");
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("cancelled")).toBe("Cancelled");
  });

  test("humanizes an unknown status for its label", () => {
    expect(statusLabel("weird_state")).toBe("Weird state");
  });
});

describe("badgeClasses", () => {
  test("maps each lifecycle tone onto its pill colour", () => {
    expect(badgeClasses("stamped")).toContain("emerald");
    expect(badgeClasses("settled")).toContain("teal");
    expect(badgeClasses("credited")).toContain("violet");
    expect(badgeClasses("submitted")).toContain("amber");
    expect(badgeClasses("failed")).toContain("red");
    expect(badgeClasses("cancelled")).toContain("slate");
  });

  test("routes the draft tone and unknown statuses to their fallbacks", () => {
    // draft falls through the switch to the blue default...
    expect(badgeClasses("draft")).toContain("blue");
    // ...while a genuinely unknown status lands on slate.
    expect(badgeClasses("something-new")).toContain("slate");
  });
});

describe("deadline severity", () => {
  test("labels are humanized and tones map critical/warning/info", () => {
    expect(severityLabel("critical")).toBe("Critical");
    expect(severityBadgeClasses("critical")).toContain("red");
    expect(severityBadgeClasses("warning")).toContain("amber");
    expect(severityBadgeClasses("info")).toContain("blue");
    expect(severityBadgeClasses("something-new")).toContain("slate");
  });
});

describe("action batch outcomes", () => {
  test("the label map covers exactly the contract's outcome enum", () => {
    // Both directions: every enum value is labelled, and no stray key labels
    // an outcome the contract no longer knows.
    expect(Object.keys(ACTION_OUTCOME_LABELS).sort()).toEqual(
      Object.values(ActionTargetOutcomeOutcome).sort(),
    );
  });

  test("labels never leak the raw enum string", () => {
    expect(ACTION_OUTCOME_LABELS.submitted).toBe("Submitted");
    expect(ACTION_OUTCOME_LABELS.invalid).toBe("Needs fixing");
    expect(ACTION_OUTCOME_LABELS.skipped_not_eligible).toBe("Skipped");
    expect(ACTION_OUTCOME_LABELS.failed).toBe("Failed");
    expect(ACTION_OUTCOME_LABELS.drafted).toBe("Drafted");
  });

  test("tones: emerald for the success pair, muted for skips, amber otherwise", () => {
    expect(actionOutcomeToneClasses("submitted")).toBe(
      "text-emerald-700 dark:text-emerald-400",
    );
    expect(actionOutcomeToneClasses("drafted")).toBe(
      "text-emerald-700 dark:text-emerald-400",
    );
    expect(actionOutcomeToneClasses("skipped_not_eligible")).toBe(
      "text-muted-foreground",
    );
    expect(actionOutcomeToneClasses("invalid")).toBe(
      "text-amber-700 dark:text-amber-400",
    );
    expect(actionOutcomeToneClasses("failed")).toBe(
      "text-amber-700 dark:text-amber-400",
    );
    // An off-contract outcome from a newer server reads as needs-attention.
    expect(actionOutcomeToneClasses("something-new")).toBe(
      "text-amber-700 dark:text-amber-400",
    );
  });
});

describe("buyer-rails confirmation", () => {
  test("labels every contract state plus the synthetic pre-request 'none'", () => {
    expect(confirmationLabel("requested")).toBe("Awaiting response");
    expect(confirmationLabel("confirmed")).toBe("Confirmed");
    expect(confirmationLabel("queried")).toBe("Queried");
    expect(confirmationLabel("rejected")).toBe("Rejected");
    expect(confirmationLabel("none")).toBe("Not requested");
    expect(confirmationLabel("weird_state")).toBe("Weird state");
  });

  test("tones every state, defaulting unknowns to slate", () => {
    expect(confirmationBadgeClasses("requested")).toContain("amber");
    expect(confirmationBadgeClasses("confirmed")).toContain("emerald");
    expect(confirmationBadgeClasses("queried")).toContain("blue");
    expect(confirmationBadgeClasses("rejected")).toContain("red");
    expect(confirmationBadgeClasses("none")).toContain("slate");
    expect(confirmationBadgeClasses("something-new")).toContain("slate");
  });
});

describe("roleLabel", () => {
  test("labels every known role and passes unknowns through readably", () => {
    expect(roleLabel("firm_admin")).toBe("Firm admin");
    expect(roleLabel("buyer_user")).toBe("Buyer");
    expect(roleLabel("mystery_role")).toBe("mystery_role");
    expect(roleLabel(undefined)).toBe("Unknown role");
  });
});

describe("roleHomeHref", () => {
  test("maps every principal role to its workspace and unknowns to null", () => {
    expect(roleHomeHref("client_user")).toEqual({
      href: "/app/",
      label: "the Compliance App",
    });
    expect(roleHomeHref("buyer_user")).toEqual({
      href: "/buyer/",
      label: "Buyer Rails",
    });
    expect(roleHomeHref("operator")?.href).toBe("/console/operator-queue");
    expect(roleHomeHref("auditor")?.href).toBe("/console/audit");
    expect(roleHomeHref("mystery_role")).toBeNull();
    expect(roleHomeHref(undefined)).toBeNull();
  });
});

describe("recentQuestionRows", () => {
  const row = (
    id: string,
    createdAt: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    kind: "question",
    question: `Q ${id}`,
    answer: { answered: true },
    createdAt,
    ...over,
  });

  test("answered question cases only, newest first", () => {
    const rows = recentQuestionRows([
      row("old", "2026-08-01T10:00:00Z"),
      row("new", "2026-08-03T10:00:00Z"),
      row("unanswered", "2026-08-04T10:00:00Z", { answer: null }),
      row("blank", "2026-08-05T10:00:00Z", { question: "" }),
      row("extraction", "2026-08-06T10:00:00Z", { kind: "extraction" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });

  test("caps the shortlist", () => {
    const rows = recentQuestionRows(
      Array.from({ length: 9 }, (_, i) =>
        row(`q${i}`, `2026-08-0${i + 1}T10:00:00Z`),
      ),
      3,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe("q8");
  });
});
