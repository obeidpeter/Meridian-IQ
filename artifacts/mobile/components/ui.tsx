import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";

import { useColors } from "@/hooks/useColors";

type ThemeColors = ReturnType<typeof useColors>;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TypographyVariant =
  | "display"
  | "title"
  | "heading"
  | "body"
  | "label"
  | "caption"
  | "overline";

const VARIANT_STYLE: Record<
  TypographyVariant,
  {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing?: number;
    textTransform?: "uppercase";
  }
> = {
  // Negative tracking on the large sizes: Inter is spaced for body text, so
  // headlines read airy without a slight tightening.
  display: {
    fontFamily: "Inter_700Bold",
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: -0.5,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.4,
  },
  heading: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.2,
  },
  body: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 22 },
  label: { fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16 },
  // Section eyebrows ("PENALTY RISK", "RECEIVABLES"): wide-tracked and
  // auto-uppercased, so call sites pass natural-case text and stay consistent.
  overline: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
};

export function AppText({
  variant = "body",
  color,
  style,
  children,
  numberOfLines,
}: {
  variant?: TypographyVariant;
  color?: string;
  style?: TextInputProps["style"];
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  const colors = useColors();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[VARIANT_STYLE[variant], { color: color ?? colors.foreground }, style]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  padded?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderRadius: colors.radius,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          padding: padded ? 16 : 0,
        },
        // A whisper of elevation so cards lift off the near-white background
        // (they were border-only and read flat). Light scheme only: on the
        // dark palette a black shadow is invisible and Android's elevation
        // would instead tint the surface, so dark keeps the hairline border
        // as its separation.
        colors.scheme === "light" ? styles.cardShadow : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function AppButton({
  label,
  onPress,
  variant = "primary",
  icon,
  loading = false,
  disabled = false,
  fullWidth = true,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: keyof typeof Feather.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const isDisabled = disabled || loading;

  const palette: Record<
    ButtonVariant,
    { bg: string; fg: string; border: string }
  > = {
    primary: {
      bg: colors.primary,
      fg: colors.primaryForeground,
      border: colors.primary,
    },
    secondary: {
      bg: colors.secondary,
      fg: colors.secondaryForeground,
      border: colors.border,
    },
    ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
    destructive: {
      bg: colors.destructive,
      fg: colors.destructiveForeground,
      border: colors.destructive,
    },
  };
  const tone = palette[variant];

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={() => {
        if (isDisabled) return;
        if (Platform.OS !== "web") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        onPress();
      }}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          // minHeight (not height) so large Dynamic Type can grow the control
          // instead of clipping the label.
          minHeight: 50,
          paddingVertical: 12,
          paddingHorizontal: 20,
          borderRadius: colors.radius,
          backgroundColor: tone.bg,
          borderWidth: 1,
          borderColor: tone.border,
          alignSelf: fullWidth ? "stretch" : "flex-start",
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.98 : 1 }],
        },
      ]}
    >
      {/* The label stays mounted while loading so the control keeps an
          accessible name and any "Submitting…" text actually renders; the
          spinner simply replaces the leading icon. */}
      {loading ? (
        <ActivityIndicator color={tone.fg} />
      ) : icon ? (
        <Feather name={icon} size={18} color={tone.fg} />
      ) : null}
      <Text
        style={{
          fontFamily: "Inter_600SemiBold",
          fontSize: 15,
          color: tone.fg,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeTone = "neutral" | "success" | "warning" | "critical" | "info";

export function Badge({ label, tone = "neutral" }: { label: string; tone?: BadgeTone }) {
  const colors = useColors();
  // Soft-tint pill recipe (web design language §8): tinted surface + deep
  // same-hue text + a faint tone-matched border. Warning/critical previously
  // used heavy solid fills that shouted next to the soft neutral/success
  // pills; every tone now carries the same visual weight.
  const tones: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: colors.secondary, fg: colors.secondaryForeground },
    success: { bg: colors.accent, fg: colors.accentForeground },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    critical: { bg: colors.destructiveSoft, fg: colors.destructiveText },
    info: { bg: colors.accent, fg: colors.accentForeground },
  };
  const t = tones[tone];
  return (
    <View
      style={{
        backgroundColor: t.bg,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        // 8-digit hex: the tone's text color at ~20% alpha.
        borderColor: `${t.fg}33`,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: t.fg }}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Text field
// ---------------------------------------------------------------------------

export function TextField({
  label,
  error,
  hint,
  style,
  ...inputProps
}: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text
        style={{
          fontFamily: "Inter_500Medium",
          fontSize: 14,
          color: colors.foreground,
        }}
      >
        {label}
      </Text>
      <TextInput
        // Give the field an accessible name (the visible label) and expose the
        // error/hint as a hint, so screen readers announce more than the
        // placeholder.
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={colors.mutedForeground}
        style={[
          {
            minHeight: 48,
            paddingVertical: 10,
            borderRadius: colors.radius,
            borderWidth: 1,
            borderColor: error ? colors.destructive : colors.input,
            backgroundColor: colors.card,
            paddingHorizontal: 14,
            fontFamily: "Inter_400Regular",
            fontSize: 15,
            color: colors.foreground,
          },
          style,
        ]}
        {...inputProps}
      />
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: colors.destructiveText }}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: colors.mutedForeground }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Banner — accessible inline success/error/info message
// ---------------------------------------------------------------------------

export type BannerTone = "success" | "error" | "info" | "warning";

/**
 * A polite live-region banner so async success/error feedback is announced to
 * screen readers (the previous ad-hoc banner Cards were silent). Render it
 * conditionally at the top of a form; setting its message triggers the
 * announcement.
 */
export function Banner({
  tone,
  message,
}: {
  tone: BannerTone;
  message: string;
}) {
  const colors = useColors();
  // Soft tinted surfaces all round (error/warning previously sat on a plain
  // card and relied on their border alone, which looked unfinished next to
  // the tinted success/info variants).
  const map: Record<BannerTone, { bg: string; fg: string; icon: keyof typeof Feather.glyphMap }> = {
    success: { bg: colors.accent, fg: colors.accentForeground, icon: "check-circle" },
    error: { bg: colors.destructiveSoft, fg: colors.destructiveText, icon: "alert-triangle" },
    info: { bg: colors.secondary, fg: colors.secondaryForeground, icon: "info" },
    warning: { bg: colors.warningSoft, fg: colors.warning, icon: "alert-circle" },
  };
  const t = map[tone];
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: 10,
        alignItems: "flex-start",
        backgroundColor: t.bg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: `${t.fg}33`,
        borderRadius: colors.radius,
        padding: 14,
      }}
    >
      <Feather name={t.icon} size={18} color={t.fg} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20, color: t.fg }}>
        {message}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// States: loading skeleton, empty, error
// ---------------------------------------------------------------------------

export function Skeleton({
  height = 16,
  width = "100%",
  radius,
  style,
}: {
  height?: number;
  width?: number | `${number}%`;
  radius?: number;
  style?: ViewStyle;
}) {
  const colors = useColors();
  // Gentle opacity pulse so loading reads as "in progress" rather than a
  // stack of gray bars. Opacity-only (no movement) keeps it calm for
  // motion-sensitive users; the loop is stopped on unmount.
  const pulse = React.useRef(new Animated.Value(0.55)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.95,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.55,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          height,
          width,
          borderRadius: radius ?? 8,
          backgroundColor: colors.secondary,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <View style={{ gap: 10 }}>
        <Skeleton height={20} width="55%" />
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} height={14} width={i === lines - 1 ? "40%" : "85%"} />
        ))}
      </View>
    </Card>
  );
}

/** The icon-in-a-soft-circle well shared by the empty and error states. */
function IconWell({
  icon,
  bg,
  fg,
}: {
  icon: keyof typeof Feather.glyphMap;
  bg: string;
  fg: string;
}) {
  return (
    <View
      style={{
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Feather name={icon} size={28} color={fg} />
    </View>
  );
}

export function EmptyState({
  icon = "inbox",
  title,
  message,
}: {
  icon?: keyof typeof Feather.glyphMap;
  title: string;
  message?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.centered}>
      <IconWell icon={icon} bg={colors.secondary} fg={colors.mutedForeground} />
      <AppText variant="heading" style={{ marginTop: 14, textAlign: "center" }}>
        {title}
      </AppText>
      {message ? (
        <AppText
          variant="body"
          color={colors.mutedForeground}
          style={{ marginTop: 6, textAlign: "center" }}
        >
          {message}
        </AppText>
      ) : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.centered}>
      <IconWell
        icon="alert-triangle"
        bg={colors.destructiveSoft}
        fg={colors.destructiveText}
      />
      <AppText variant="heading" style={{ marginTop: 14, textAlign: "center" }}>
        Something went wrong
      </AppText>
      <AppText
        variant="body"
        color={colors.mutedForeground}
        style={{ marginTop: 6, textAlign: "center" }}
      >
        {message ?? "We couldn't load this right now."}
      </AppText>
      {onRetry ? (
        <View style={{ marginTop: 16 }}>
          <AppButton label="Try again" icon="refresh-cw" onPress={onRetry} fullWidth={false} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}

export function StatTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: string;
  /** Optional trailing glyph, tinted with `tone` when one is set. */
  icon?: keyof typeof Feather.glyphMap;
}) {
  const colors = useColors();
  return (
    <Card style={{ flex: 1 }}>
      <View style={rowBetween}>
        <AppText variant="overline" color={colors.mutedForeground}>
          {label}
        </AppText>
        {icon ? (
          <Feather
            name={icon}
            size={15}
            color={tone ?? colors.mutedForeground}
          />
        ) : null}
      </View>
      <AppText variant="title" color={tone ?? colors.foreground} style={{ marginTop: 6 }}>
        {value}
      </AppText>
    </Card>
  );
}

/**
 * A tappable icon-tile for launcher grids ("Quick actions"). A tinted icon
 * chip over a Card, so a wall of stacked buttons can become a scannable grid.
 */
export function ActionTile({
  icon,
  label,
  onPress,
  primary = false,
  testID,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  /** Fills the icon chip with the primary color for the headline action. */
  primary?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        if (Platform.OS !== "web") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        onPress();
      }}
      style={({ pressed }) => [
        styles.actionTile,
        {
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Card style={{ gap: 12 }}>
        <View
          style={[
            styles.actionChip,
            { backgroundColor: primary ? colors.primary : colors.accent },
          ]}
        >
          <Feather
            name={icon}
            size={18}
            color={primary ? colors.primaryForeground : colors.accentForeground}
          />
        </View>
        <AppText variant="label" numberOfLines={2}>
          {label}
        </AppText>
      </Card>
    </Pressable>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const colors = useColors();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginVertical: 4,
        // Indent past a leading icon/avatar so list rules align with the text
        // column, the way native list separators do.
        marginLeft: inset,
      }}
    />
  );
}

/**
 * Per-screen Stack.Screen header options — identical across screens except
 * for the title. Takes the caller's already-subscribed theme colors so the
 * header stays reactive to theme changes.
 */
export function stackHeaderOptions(colors: ThemeColors, title: string) {
  return {
    title,
    headerStyle: { backgroundColor: colors.background },
    headerShadowVisible: false,
    headerTitleStyle: {
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
    },
    headerTintColor: colors.primary,
  } as const;
}

/**
 * Web-only content width cap so screens don't stretch edge-to-edge in a
 * browser. Spread into a screen's content-container style. Platform.OS is
 * fixed at module load, so hoisting the conditional here is behavior-identical
 * to the per-file conditionals it replaces.
 */
export const webContentMax: ViewStyle =
  Platform.OS === "web"
    ? { maxWidth: 640, alignSelf: "center", width: "100%" }
    : {};

/** A row with its children pushed to opposite edges, vertically centered. */
export const rowBetween: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
};

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  // iOS/web soft drop shadow + the Android elevation equivalent. Kept faint:
  // separation, not floating panels.
  cardShadow: {
    shadowColor: "#0f172a",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  actionTile: {
    flexGrow: 1,
    flexBasis: "45%",
  },
  actionChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
