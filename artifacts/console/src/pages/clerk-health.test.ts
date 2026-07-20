import { test, expect, describe } from "vitest";
import type {
  ClerkMetricsCases,
  EvalFixtureReport,
  EvalFixtureSummary,
} from "@workspace/api-client-react";
import {
  HEALTH_TABS,
  canaryPrefillNote,
  fmtEvalDuration,
  fmtMs,
  fmtTokens,
  fmtUsd,
  casesTileDetail,
  modelCanaryRowClass,
  overrideRateClass,
  qualityAlertText,
  shapeExample,
  CORPUS_PREVIEW_ROWS,
  corpusSummary,
  fixtureAccuracy,
  fixtureSourceLabel,
  retireDisabledReason,
  visibleFixtureCount,
} from "./clerk-health";

// The tab groups are presentation only — every section keeps its testids and
// the alert banners are hoisted above the tabs — but the grouping itself is
// contract: the default tab must stay first and the values unique (they feed
// data-testids and the Tabs value space).
describe("HEALTH_TABS", () => {
  test("overview leads (it is the default tab) and the IA groups follow", () => {
    expect(HEALTH_TABS.map((t) => t.value)).toEqual([
      "overview",
      "quality",
      "economics",
      "evals",
      "canaries",
    ]);
  });

  test("values are unique and every tab carries a human label", () => {
    const values = HEALTH_TABS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
    for (const t of HEALTH_TABS) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});

describe("overrideRateClass", () => {
  test("reddens above 25%, ambers above 10%, and is blank at or below 10%", () => {
    expect(overrideRateClass(0.3)).toContain("red");
    expect(overrideRateClass(0.26)).toContain("red");
    expect(overrideRateClass(0.2)).toContain("amber");
    expect(overrideRateClass(0.11)).toContain("amber");
    // The thresholds are strict `>`, so the boundary values fall to the lower
    // band: exactly 25% is amber, exactly 10% is blank.
    expect(overrideRateClass(0.25)).toContain("amber");
    expect(overrideRateClass(0.1)).toBe("");
    expect(overrideRateClass(0.05)).toBe("");
    expect(overrideRateClass(0)).toBe("");
  });
});

describe("fmtEvalDuration", () => {
  test("shows whole milliseconds below one second", () => {
    expect(fmtEvalDuration(0)).toBe("0 ms");
    expect(fmtEvalDuration(250)).toBe("250 ms");
    expect(fmtEvalDuration(999)).toBe("999 ms");
    expect(fmtEvalDuration(4.6)).toBe("5 ms"); // rounds
  });

  test("switches to one-decimal seconds at and above one second", () => {
    expect(fmtEvalDuration(1000)).toBe("1.0 s");
    expect(fmtEvalDuration(1500)).toBe("1.5 s");
    expect(fmtEvalDuration(12340)).toBe("12.3 s");
  });
});

describe("fmtMs", () => {
  test("returns the em-dash sentinel for nullish latencies", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(undefined)).toBe("—");
  });

  test("rounds a present latency to whole milliseconds", () => {
    expect(fmtMs(0)).toBe("0 ms");
    expect(fmtMs(42.4)).toBe("42 ms");
  });
});

describe("fmtTokens", () => {
  test("returns the em-dash sentinel for nullish counts", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
  });

  test("rounds and renders a present count", () => {
    expect(fmtTokens(0)).toBe("0");
    // Assert the rounded digits are present without pinning the ICU grouping
    // separator, which follows the runtime's default locale.
    const out = fmtTokens(1234.6);
    expect(out).not.toBe("—");
    expect(out).toContain("235");
  });
});

describe("fmtUsd", () => {
  test("returns the em-dash sentinel when spend is nullish (rates not configured)", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
  });

  test("formats USD with 2–4 fraction digits (locale is pinned to en-US)", () => {
    expect(fmtUsd(1.5)).toContain("1.50");
    expect(fmtUsd(0.0001)).toContain("0.0001");
  });
});

describe("shapeExample", () => {
  test("renders the correction as extracted → final", () => {
    expect(shapeExample("12000", "12,000.00")).toBe("12000 → 12,000.00");
  });

  test("substitutes the em-dash sentinel for a missing side", () => {
    // A filled blank (nothing extracted) and a blanked hallucination
    // (nothing kept) both stay renderable.
    expect(shapeExample(null, "NG-TIN-1")).toBe("— → NG-TIN-1");
    expect(shapeExample("NG-TIN-1", null)).toBe("NG-TIN-1 → —");
    expect(shapeExample(null, null)).toBe("— → —");
  });
});

describe("qualityAlertText", () => {
  test("phrases the drop as rate (month) to rate (month) over the sample", () => {
    expect(
      qualityAlertText({
        fromMonth: "2026-05",
        toMonth: "2026-06",
        fromRate: 0.93,
        toRate: 0.81,
        fields: 240,
      }),
    ).toBe(
      "Extraction kept-rate dropped from 93.0% (2026-05) to 81.0% (2026-06) over 240 fields — review recent corrections.",
    );
  });

  test("rates are fractions on the wire, formatted as percents like the resistance banner", () => {
    const out = qualityAlertText({
      fromMonth: "2026-01",
      toMonth: "2026-02",
      fromRate: 1,
      toRate: 0.875,
      fields: 8,
    });
    expect(out).toContain("100.0%");
    expect(out).toContain("87.5%");
    expect(out).toContain("over 8 fields");
  });
});

describe("modelCanaryRowClass", () => {
  test("reddens regressed fixture rows and leaves the rest plain", () => {
    expect(modelCanaryRowClass(true)).toContain("red");
    expect(modelCanaryRowClass(false)).toBe("");
  });
});

describe("casesTileDetail", () => {
  const base: ClerkMetricsCases = {
    total: 0,
    byStatus: {},
    byKind: {},
  };

  test("returns undefined when no timing is available", () => {
    expect(casesTileDetail(base)).toBeUndefined();
  });

  test("rounds and includes only the timings that are present", () => {
    expect(casesTileDetail({ ...base, avgDecisionMinutes: 12.4 })).toBe(
      "avg decision 12 min",
    );
    expect(
      casesTileDetail({
        ...base,
        avgDecisionMinutes: 12,
        avgQueueWaitMinutes: 3,
        avgActiveReviewMinutes: 9,
      }),
    ).toBe("avg decision 12 min · queue wait 3m · active review 9m");
  });

  test("treats a zero timing as present (guards on != null, not truthiness)", () => {
    expect(casesTileDetail({ ...base, avgQueueWaitMinutes: 0 })).toBe(
      "queue wait 0m",
    );
  });
});

// Prompt-canary prefill: a failed incumbent-prompt fetch must not leave the
// "Start from the live prompt" button disabled with no reason — the note says
// why and points at the manual path (the canary itself still runs on pasted
// candidates).
describe("canaryPrefillNote", () => {
  test("says why the prefill is dead and what to do instead", () => {
    expect(canaryPrefillNote(true)).toBe(
      "Couldn't load the live prompt — paste a candidate manually.",
    );
  });

  test("silent while the prompt loads or once it has loaded", () => {
    expect(canaryPrefillNote(false)).toBeNull();
  });
});

// ---- Eval corpus curation ---------------------------------------------------

function fixture(over: Partial<EvalFixtureSummary> = {}): EvalFixtureSummary {
  return {
    key: "fx-1",
    source: "static",
    label: "Clean services invoice",
    riskLabel: "clean",
    retired: false,
    ...over,
  };
}

describe("fixtureSourceLabel", () => {
  test("renders the wire value 'redteam' as prose 'red-team', others verbatim", () => {
    expect(fixtureSourceLabel("redteam")).toBe("red-team");
    expect(fixtureSourceLabel("static")).toBe("static");
    expect(fixtureSourceLabel("grown")).toBe("grown");
  });
});

describe("fixtureAccuracy", () => {
  test("is correct/compared once history exists", () => {
    expect(fixtureAccuracy({ fieldsCompared: 10, fieldsCorrect: 9 })).toBe(0.9);
    expect(fixtureAccuracy({ fieldsCompared: 4, fieldsCorrect: 0 })).toBe(0);
  });

  test("null (the em-dash sentinel) with no compared fields — 0/0 is 'no history', not 0%", () => {
    expect(fixtureAccuracy({})).toBeNull();
    expect(fixtureAccuracy({ fieldsCompared: 0, fieldsCorrect: 0 })).toBeNull();
    expect(fixtureAccuracy({ fieldsCompared: undefined })).toBeNull();
  });

  test("tolerates a missing fieldsCorrect (older server rows) as zero", () => {
    expect(fixtureAccuracy({ fieldsCompared: 5 })).toBe(0);
  });
});

describe("retireDisabledReason", () => {
  test("static fixtures explain why they are read-only", () => {
    expect(retireDisabledReason("static")).toMatch(/code change/);
  });

  test("grown and red-team fixtures are curatable — no reason", () => {
    expect(retireDisabledReason("grown")).toBeNull();
    expect(retireDisabledReason("redteam")).toBeNull();
  });
});

describe("corpusSummary", () => {
  const report = (fixtures: EvalFixtureSummary[], runsScanned = 7): EvalFixtureReport => ({
    fixtures,
    runsScanned,
  });

  test("counts each source, mentions retirement only when present", () => {
    expect(
      corpusSummary(
        report([
          fixture(),
          fixture({ key: "fx-2", source: "grown" }),
          fixture({ key: "fx-3", source: "redteam", retired: true }),
        ]),
      ),
    ).toBe(
      "3 fixture(s) — 1 static, 1 grown, 1 red-team · 1 retired · history from 7 stored run(s)",
    );
  });

  test("a fully-live corpus omits the retired clause", () => {
    expect(corpusSummary(report([fixture()], 0))).toBe(
      "1 fixture(s) — 1 static, 0 grown, 0 red-team · history from 0 stored run(s)",
    );
  });
});

describe("visibleFixtureCount", () => {
  test("previews the first rows of a long corpus until the operator expands", () => {
    expect(visibleFixtureCount(200, false)).toBe(CORPUS_PREVIEW_ROWS);
    expect(visibleFixtureCount(200, true)).toBe(200);
  });

  test("a short corpus never truncates", () => {
    expect(visibleFixtureCount(6, false)).toBe(6);
    expect(visibleFixtureCount(6, true)).toBe(6);
  });
});
