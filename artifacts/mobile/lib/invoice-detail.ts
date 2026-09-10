/**
 * Pure helpers behind the invoice detail screen: the transmission-attempt
 * icon vocabulary and newest-first ordering, the failed attempt's error
 * code, and the deterministic compliance light's presentation. Palettes are
 * passed in structurally (never imported from the theme) so node:test can
 * drive the colour logic with a fake theme and this module stays free of
 * React Native imports.
 */

import type { Feather } from "@expo/vector-icons";
import type {
  StatusLight,
  StatusLightLight,
  SubmissionAttempt,
} from "@workspace/api-client-react";

type FeatherName = keyof typeof Feather.glyphMap;

export const ATTEMPT_ICON: Record<
  string,
  {
    icon: FeatherName;
    toneKey: "success" | "critical" | "muted";
  }
> = {
  accepted: { icon: "check-circle", toneKey: "success" },
  stamped: { icon: "check-circle", toneKey: "success" },
  pending: { icon: "clock", toneKey: "muted" },
  submitted: { icon: "clock", toneKey: "muted" },
  rejected: { icon: "x-circle", toneKey: "critical" },
  error: { icon: "x-circle", toneKey: "critical" },
};

export function attemptFailed(a: SubmissionAttempt): boolean {
  return a.status === "rejected" || a.status === "error";
}

// Deterministic compliance light (AI Feature Brief §3.3): icon + the word
// Green/Amber/Red always pair with the coloured dot so colour is never the
// only signal. Never percentages or predictions.
export const LIGHT_META: Record<
  StatusLightLight,
  { icon: FeatherName; label: string }
> = {
  green: { icon: "check-circle", label: "Green" },
  amber: { icon: "alert-triangle", label: "Amber" },
  red: { icon: "x-circle", label: "Red" },
};

// Newest first. The API lists oldest-first and rows of one try share
// attemptNo with the terminal answer LAST, so ties keep reverse API order.
export function sortAttemptsNewestFirst(
  attempts: SubmissionAttempt[],
): SubmissionAttempt[] {
  return attempts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.attemptNo - x.a.attemptNo || y.i - x.i)
    .map((x) => x.a);
}

/** The error code of the newest failed attempt that carries one. */
export function latestFailedErrorCode(
  attempts: SubmissionAttempt[],
): string | undefined {
  const latestFailed = attempts.filter(
    (a) => attemptFailed(a) && a.errorCode,
  )[0];
  return latestFailed?.errorCode ?? undefined;
}

export interface AttemptPalette {
  primary: string;
  destructiveText: string;
  mutedForeground: string;
}

export function attemptIconColor(
  meta: { toneKey: "success" | "critical" | "muted" },
  colors: AttemptPalette,
): string {
  return meta.toneKey === "success"
    ? colors.primary
    : meta.toneKey === "critical"
      ? colors.destructiveText
      : colors.mutedForeground;
}

export interface LightPalette {
  success: string;
  warning: string;
  destructive: string;
  destructiveText: string;
  foreground: string;
}

/**
 * How the compliance light renders: its icon/label pair, the dot, icon and
 * label colours, and the one accessibility label that carries the light,
 * every reason and the recommended action together.
 */
export function statusLightPresentation(
  statusLight: StatusLight | undefined,
  colors: LightPalette,
) {
  // Icons/dots carry the light colour; text stays on foreground tokens for
  // contrast (destructiveText is the one red tuned for text on cards).
  const lightMeta = statusLight ? LIGHT_META[statusLight.light] : null;
  const lightDotColor =
    statusLight?.light === "green"
      ? colors.success
      : statusLight?.light === "amber"
        ? colors.warning
        : colors.destructive;
  const lightIconColor =
    statusLight?.light === "red" ? colors.destructiveText : lightDotColor;
  const lightLabelColor =
    statusLight?.light === "red" ? colors.destructiveText : colors.foreground;
  const lightA11yLabel = statusLight
    ? [
        `Compliance status: ${lightMeta?.label}`,
        ...statusLight.reasons,
        `Recommended action: ${statusLight.recommendedAction}`,
      ].join(". ")
    : undefined;
  return {
    lightMeta,
    lightDotColor,
    lightIconColor,
    lightLabelColor,
    lightA11yLabel,
  };
}
