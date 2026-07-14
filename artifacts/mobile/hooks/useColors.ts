import { useColorScheme } from "react-native";

import colors from "@/constants/colors";

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * Falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default).
 * When a sibling web artifact's dark tokens are synced into a `dark`
 * key, this hook will automatically switch palettes based on the
 * device's appearance setting.
 */
export function useColors() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? colors.dark : colors.light;
  return {
    ...palette,
    radius: colors.radius,
    // The resolved scheme, for the few visual effects that cannot be expressed
    // as a token swap (card shadows read only on light ground; gradients pick
    // different stops). Null/undefined appearance falls back to light, matching
    // the palette fallback above.
    scheme: (scheme === "dark" ? "dark" : "light") as "light" | "dark",
  };
}
