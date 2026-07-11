/**
 * Semantic design tokens for the MeridianIQ SME companion app.
 *
 * These tokens are derived from the sibling web artifact
 * (`artifacts/sme-compliance/src/index.css`) so both products share one
 * visual identity: a rich teal primary for trust and calm, a near-white
 * cool background, and a slate foreground.
 *
 * HSL → hex conversions of the web `:root` (light) and `.dark` blocks.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: "#111d2e",
    tint: "#0d7a63",

    // Core surfaces
    background: "#fafcfd", // 210 33% 99%
    foreground: "#111d2e", // 222 47% 11%

    // Cards / elevated surfaces
    card: "#ffffff",
    cardForeground: "#111d2e",

    // Primary action color (buttons, links, active states) — teal
    primary: "#0d7c64", // 173 80% 27%
    primaryForeground: "#ffffff",

    // Secondary / less-emphasis interactive surfaces
    secondary: "#dde5ee", // 214 32% 91%
    secondaryForeground: "#111d2e",

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: "#dde5ee",
    mutedForeground: "#586577", // 215 18% 42%

    // Accent highlights (badges, selected items, focus rings)
    accent: "#cdf5ec", // 173 80% 90%
    accentForeground: "#0b6653", // 173 80% 25%

    // Destructive actions (delete, error states)
    destructive: "#c62828", // 0 72% 45% — for FILLS with destructiveForeground
    destructiveForeground: "#ffffff",
    // Destructive used as TEXT/ICON on a light surface. In light mode this is
    // the same rich red (5.6:1 on white); the dark palette lightens it so error
    // copy stays legible on dark cards (WCAG AA).
    destructiveText: "#c62828",

    // Borders and input outlines
    border: "#dde5ee",
    input: "#dde5ee",

    // Supplementary status colors (derived for badges)
    warning: "#b45309",
    warningForeground: "#ffffff",
    success: "#0d7c64",
  },

  dark: {
    text: "#f1f5fb",
    tint: "#17b899",

    background: "#111d2e", // 222 47% 11%
    foreground: "#f1f5fb", // 210 40% 98%

    card: "#152439",
    cardForeground: "#f1f5fb",

    primary: "#17b899", // 173 80% 40%
    primaryForeground: "#111d2e",

    secondary: "#1d2a3d", // 217 33% 17%
    secondaryForeground: "#f1f5fb",

    muted: "#1d2a3d",
    mutedForeground: "#9aa8bd", // 215 20% 65%

    accent: "#0a3b31", // 173 80% 20%
    accentForeground: "#cdf5ec",

    destructive: "#c0392b",
    destructiveForeground: "#f1f5fb",
    // Lighter red for destructive TEXT/ICON on dark cards (8.2:1 on #152439);
    // the fill `destructive` stays dark for use with white foreground.
    destructiveText: "#fca5a5",

    border: "#243247",
    input: "#243247",

    warning: "#d98324",
    warningForeground: "#111d2e",
    success: "#17b899",
  },

  // Border radius (in px). Synced from the web artifact's --radius (0.75rem).
  radius: 12,
};

export default colors;
