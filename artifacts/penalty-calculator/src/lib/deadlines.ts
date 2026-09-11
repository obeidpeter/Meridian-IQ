import type { TurnoverBand } from "./penalty.ts";

/**
 * Indicative e-invoicing onboarding waves. The rollout is phased by taxpayer
 * size: larger taxpayers onboard (and face enforcement) first. These are
 * Valo's planning dates to help taxpayers orient themselves — they are
 * not a substitute for the tax authority's official notices.
 *
 * Dates are stored as ISO (`yyyy-mm-dd`) and each wave's status is computed
 * from the current date at render time, so the copy can never go stale.
 */
export interface ComplianceWave {
  band: TurnoverBand;
  name: string;
  audience: string;
  threshold: string;
  /** ISO date the wave must complete onboarding by. */
  onboardingBy: string;
  /** ISO date enforcement (s.103 / s.104 exposure) begins. */
  enforcementFrom: string;
  /** Date-neutral guidance for the wave — no temporal claims. */
  summary: string;
}

export const WAVES: ComplianceWave[] = [
  {
    band: "large",
    name: "Phase 1: Large taxpayers",
    audience: "Large enterprises",
    threshold: "Annual turnover above ₦100,000,000",
    onboardingBy: "2025-07-01",
    enforcementFrom: "2026-01-01",
    summary:
      "This model puts large taxpayers first. Check requirements for tax-authority systems access and valid invoice stamps under s.103 and s.104.",
  },
  {
    band: "medium",
    name: "Phase 2: Medium taxpayers",
    audience: "Mid-sized businesses",
    threshold: "Annual turnover ₦25,000,001 – ₦100,000,000",
    onboardingBy: "2026-01-01",
    enforcementFrom: "2026-07-01",
    summary:
      "This model puts medium taxpayers in the second phase. Check when systems access and valid invoice stamps are required for your business.",
  },
  {
    band: "small",
    name: "Phase 3: Small taxpayers",
    audience: "Small businesses",
    threshold: "Annual turnover up to ₦25,000,000",
    onboardingBy: "2026-07-01",
    enforcementFrom: "2027-01-01",
    summary:
      "This model puts small taxpayers in the final phase. Confirm your deadlines and setup requirements with the tax authority or a tax advisor.",
  },
];

export function waveForBand(band: TurnoverBand): ComplianceWave {
  const wave = WAVES.find((w) => w.band === band);
  // WAVES covers every band; the fallback keeps the return type non-nullable.
  return wave ?? WAVES[WAVES.length - 1]!;
}

export type WaveStatus =
  | "upcoming"
  | "onboarding"
  | "deadline-passed"
  | "enforcement-active";

export interface WaveStatusInfo {
  status: WaveStatus;
  /** Short pill label, e.g. "Enforcement active". */
  label: string;
  /** One-line countdown, e.g. "Enforcement began 8 days ago". */
  detail: string;
  /** Whole days to (or since) the milestone the detail describes. */
  days: number;
}

/** Parse an ISO `yyyy-mm-dd` date as local midnight. */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 86_400_000;
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** Compute a wave's live status from the current date. */
export function waveStatus(
  wave: ComplianceWave,
  now: Date = new Date(),
): WaveStatusInfo {
  const onboardingBy = parseIsoDate(wave.onboardingBy);
  const enforcementFrom = parseIsoDate(wave.enforcementFrom);

  const sinceEnforcement = daysBetween(enforcementFrom, now);
  if (sinceEnforcement >= 0) {
    return {
      status: "enforcement-active",
      label: "Assumed enforcement date reached",
      detail:
        sinceEnforcement === 0
          ? "Assumed enforcement date is today"
          : `Assumed enforcement date was ${pluralDays(sinceEnforcement)} ago`,
      days: sinceEnforcement,
    };
  }

  const untilEnforcement = -sinceEnforcement;
  const sinceOnboardingDeadline = daysBetween(onboardingBy, now);
  if (sinceOnboardingDeadline > 0) {
    return {
      status: "deadline-passed",
      label: "Past setup target",
      detail: `Setup target has passed; ${pluralDays(untilEnforcement)} until the assumed enforcement date`,
      days: untilEnforcement,
    };
  }

  const untilOnboarding = -sinceOnboardingDeadline;
  return {
    status: "onboarding",
    label: "Before setup target",
    detail:
      untilOnboarding === 0
        ? "Setup target is today"
        : `${pluralDays(untilOnboarding)} until the setup target`,
    days: untilOnboarding,
  };
}

const WAVE_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** Format an ISO wave date for display, e.g. "1 July 2025". */
export function formatWaveDate(iso: string): string {
  return WAVE_DATE.format(parseIsoDate(iso));
}
