import { describe, expect, test } from "vitest";
import {
  ONBOARDING_STEP_LABELS,
  onboardingStepLabel,
} from "./onboarding-copy";

describe("onboardingStepLabel", () => {
  test("the closed catalogue's labels; unknown keys degrade to themselves", () => {
    expect(onboardingStepLabel("consent_captured")).toBe("Consent captured");
    expect(onboardingStepLabel("filings_synced")).toBe(
      "Filings register backfilled",
    );
    expect(onboardingStepLabel("future_step")).toBe("future_step");
    // Exactly the five Phase-1 steps — growing the catalogue is a contract
    // change and must grow this vocabulary in the same commit.
    expect(Object.keys(ONBOARDING_STEP_LABELS)).toHaveLength(5);
  });
});
