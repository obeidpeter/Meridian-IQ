import type { TurnoverBand } from "./penalty.ts";

/**
 * Indicative e-invoicing onboarding waves. The rollout is phased by taxpayer
 * size: larger taxpayers onboard (and face enforcement) first. These are
 * MeridianIQ's planning dates to help taxpayers orient themselves — they are
 * not a substitute for the tax authority's official notices.
 */
export interface ComplianceWave {
  band: TurnoverBand;
  name: string;
  audience: string;
  threshold: string;
  onboardingBy: string;
  enforcementFrom: string;
  summary: string;
}

export const WAVES: ComplianceWave[] = [
  {
    band: "large",
    name: "Wave 1 — Large taxpayers",
    audience: "Large enterprises",
    threshold: "Annual turnover above ₦100,000,000",
    onboardingBy: "1 July 2025",
    enforcementFrom: "1 January 2026",
    summary:
      "Large taxpayers onboarded first. Fiscalisation access and compliant e-invoicing are already enforced — s.103 and s.104 exposure applies now.",
  },
  {
    band: "medium",
    name: "Wave 2 — Medium taxpayers",
    audience: "Mid-sized businesses",
    threshold: "Annual turnover ₦25,000,001 – ₦100,000,000",
    onboardingBy: "1 January 2026",
    enforcementFrom: "1 July 2026",
    summary:
      "Medium taxpayers should have completed onboarding. Enforcement is now active — ensure systems grant access and every invoice is fiscalised.",
  },
  {
    band: "small",
    name: "Wave 3 — Small taxpayers",
    audience: "Small businesses & SMEs",
    threshold: "Annual turnover up to ₦25,000,000",
    onboardingBy: "1 July 2026",
    enforcementFrom: "1 January 2027",
    summary:
      "Small taxpayers are in the onboarding window. Complete integration before enforcement begins to avoid s.103 and s.104 charges.",
  },
];

export function waveForBand(band: TurnoverBand): ComplianceWave {
  const wave = WAVES.find((w) => w.band === band);
  // WAVES covers every band; the fallback keeps the return type non-nullable.
  return wave ?? WAVES[WAVES.length - 1]!;
}
