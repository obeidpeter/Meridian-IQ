// The brand studio's pure theme math (R126 split): the subdomain pattern,
// the preset palette and the HSL parse / white-contrast estimate the form
// and preview share.

// Server-side pattern on FirmThemeInput.subdomain (openapi.yaml): mirror it
// here so the form rejects bad slugs before the round-trip.
export const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const DEFAULT_PRIMARY = "152 60% 30%";
export const BRAND_PRESETS = [
  { label: "Evergreen", value: "152 60% 30%" },
  { label: "Atlantic", value: "198 74% 31%" },
  { label: "Cobalt", value: "221 70% 45%" },
  { label: "Burgundy", value: "348 62% 38%" },
  { label: "Graphite", value: "210 16% 28%" },
] as const;

export type PreviewMode = "desktop" | "mobile";

export function parseHsl(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const unwrapped = /^hsl\((.*)\)$/i.exec(trimmed)?.[1] ?? trimmed;
  const match = unwrapped
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return null;
  const h = Number(match[1]);
  const s = Number(match[2]);
  const l = Number(match[3]);
  if (h > 360 || s > 100 || l > 100) return null;
  return [h, s, l];
}

export function whiteContrastEstimate(value: string): number | null {
  const parsed = parseHsl(value);
  if (!parsed) return null;
  const [hue, saturation, lightness] = parsed;
  const h = hue / 60;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] =
    h < 1
      ? [chroma, x, 0]
      : h < 2
        ? [x, chroma, 0]
        : h < 3
          ? [0, chroma, x]
          : h < 4
            ? [0, x, chroma]
            : h < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  const linear = (channel: number) => {
    const value = channel + m;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * linear(r1) + 0.7152 * linear(g1) + 0.0722 * linear(b1);
  return 1.05 / (luminance + 0.05);
}

export function themeString(
  theme: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = theme?.[key];
  return typeof value === "string" ? value : "";
}
