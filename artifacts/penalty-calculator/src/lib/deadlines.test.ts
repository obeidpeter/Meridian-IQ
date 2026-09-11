import { test } from "node:test";
import assert from "node:assert/strict";
import { WAVES, waveForBand, waveStatus } from "./deadlines.ts";

test("planning labels preserve the existing dates and turnover bands", () => {
  assert.deepEqual(
    WAVES.map(({ band, onboardingBy, enforcementFrom }) => ({
      band,
      onboardingBy,
      enforcementFrom,
    })),
    [
      {
        band: "large",
        onboardingBy: "2025-07-01",
        enforcementFrom: "2026-01-01",
      },
      {
        band: "medium",
        onboardingBy: "2026-01-01",
        enforcementFrom: "2026-07-01",
      },
      {
        band: "small",
        onboardingBy: "2026-07-01",
        enforcementFrom: "2027-01-01",
      },
    ],
  );
});

test("countdowns describe assumptions, not confirmed enforcement", () => {
  const wave = waveForBand("small");
  assert.deepEqual(waveStatus(wave, new Date(2026, 5, 30)), {
    status: "onboarding",
    label: "Before setup target",
    detail: "1 day until the setup target",
    days: 1,
  });
  assert.deepEqual(waveStatus(wave, new Date(2026, 6, 1)), {
    status: "onboarding",
    label: "Before setup target",
    detail: "Setup target is today",
    days: -0,
  });
  assert.deepEqual(waveStatus(wave, new Date(2026, 11, 31)), {
    status: "deadline-passed",
    label: "Past setup target",
    detail: "Setup target has passed; 1 day until the assumed enforcement date",
    days: 1,
  });
  assert.deepEqual(waveStatus(wave, new Date(2027, 0, 1)), {
    status: "enforcement-active",
    label: "Assumed enforcement date reached",
    detail: "Assumed enforcement date is today",
    days: 0,
  });
  assert.deepEqual(waveStatus(wave, new Date(2027, 0, 3)), {
    status: "enforcement-active",
    label: "Assumed enforcement date reached",
    detail: "Assumed enforcement date was 2 days ago",
    days: 2,
  });
});
