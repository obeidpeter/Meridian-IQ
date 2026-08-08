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
    text: "#172126",
    tint: "#0b6b66",

    // Core surfaces
    background: "#f4f7f6",
    foreground: "#172126",

    // Cards / elevated surfaces
    card: "#ffffff",
    cardForeground: "#172126",

    // Primary action color (buttons, links, active states) — teal
    primary: "#0b6b66",
    primaryForeground: "#ffffff",

    // Secondary / less-emphasis interactive surfaces
    secondary: "#e8edeb",
    secondaryForeground: "#172126",

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: "#e8edeb",
    mutedForeground: "#5b676b",

    // Accent highlights (badges, selected items, focus rings)
    accent: "#e7f5c9",
    accentForeground: "#184c47",

    // Destructive actions (delete, error states)
    destructive: "#c62828", // 0 72% 45% — for FILLS with destructiveForeground
    destructiveForeground: "#ffffff",
    // Destructive used as TEXT/ICON on a light surface. In light mode this is
    // the same rich red (5.6:1 on white); the dark palette lightens it so error
    // copy stays legible on dark cards (WCAG AA).
    destructiveText: "#c62828",
    // Soft destructive SURFACE (badges, error-state icon wells). Pair with
    // destructiveText for AA copy (5.2:1 here).
    destructiveSoft: "#fdeaea",

    // Borders and input outlines
    border: "#d8dfdd",
    input: "#cbd5d2",

    // Supplementary status colors (derived for badges)
    warning: "#b45309",
    warningForeground: "#ffffff",
    // Soft warning SURFACE (badges, banners). Pair with `warning` as the text
    // color (5.5:1 here). The success-soft equivalent is `accent`.
    warningSoft: "#fdf1e3",
    success: "#0b6b66",
  },

  dark: {
    text: "#f1f5fb",
    tint: "#17b899",

    background: "#0b1718",
    foreground: "#f2f7f5",

    card: "#112224",
    cardForeground: "#f2f7f5",

    primary: "#68d5c9",
    primaryForeground: "#071a1c",

    secondary: "#1b2d2f",
    secondaryForeground: "#f2f7f5",

    muted: "#1b2d2f",
    mutedForeground: "#a4b2ae",

    accent: "#294129",
    accentForeground: "#dff5a8",

    destructive: "#c0392b",
    destructiveForeground: "#f1f5fb",
    // Lighter red for destructive TEXT/ICON on dark cards (8.2:1 on #152439);
    // the fill `destructive` stays dark for use with white foreground.
    destructiveText: "#fca5a5",
    // Deep-tinted destructive surface; destructiveText on it clears AA easily.
    destructiveSoft: "#3a1d1d",

    border: "#294043",
    input: "#375154",

    warning: "#d98324",
    warningForeground: "#111d2e",
    // Deep-tinted warning surface; `warning` text on it reads ~5:1.
    warningSoft: "#31240f",
    success: "#68d5c9",
  },

  // Border radius (in px). Synced from the web artifact's 0.5rem geometry.
  radius: 8,
};

export default colors;
