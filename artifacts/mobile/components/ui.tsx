import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React from "react";
import {
  ActivityIndicator,
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
  | "caption";

const VARIANT_STYLE: Record<
  TypographyVariant,
  { fontFamily: string; fontSize: number; lineHeight: number }
> = {
  display: { fontFamily: "Inter_700Bold", fontSize: 34, lineHeight: 40 },
  title: { fontFamily: "Inter_700Bold", fontSize: 24, lineHeight: 30 },
  heading: { fontFamily: "Inter_600SemiBold", fontSize: 18, lineHeight: 24 },
  body: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 22 },
  label: { fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16 },
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
  const tones: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: colors.secondary, fg: colors.secondaryForeground },
    success: { bg: colors.accent, fg: colors.accentForeground },
    warning: { bg: colors.warning, fg: colors.warningForeground },
    critical: { bg: colors.destructive, fg: colors.destructiveForeground },
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
  const map: Record<BannerTone, { bg: string; fg: string; icon: keyof typeof Feather.glyphMap }> = {
    success: { bg: colors.accent, fg: colors.accentForeground, icon: "check-circle" },
    error: { bg: colors.card, fg: colors.destructiveText, icon: "alert-triangle" },
    info: { bg: colors.secondary, fg: colors.secondaryForeground, icon: "info" },
    warning: { bg: colors.card, fg: colors.warning, icon: "alert-circle" },
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
        borderWidth: tone === "error" || tone === "warning" ? StyleSheet.hairlineWidth : 0,
        borderColor: t.fg,
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
  return (
    <View
      style={[
        {
          height,
          width,
          borderRadius: radius ?? 8,
          backgroundColor: colors.secondary,
          opacity: 0.6,
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
      <Feather name={icon} size={40} color={colors.mutedForeground} />
      <AppText variant="heading" style={{ marginTop: 12, textAlign: "center" }}>
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
      <Feather name="alert-triangle" size={40} color={colors.destructive} />
      <AppText variant="heading" style={{ marginTop: 12, textAlign: "center" }}>
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
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  const colors = useColors();
  return (
    <Card style={{ flex: 1 }}>
      <AppText variant="caption" color={colors.mutedForeground}>
        {label.toUpperCase()}
      </AppText>
      <AppText variant="title" color={tone ?? colors.foreground} style={{ marginTop: 6 }}>
        {value}
      </AppText>
    </Card>
  );
}

export function Divider() {
  const colors = useColors();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginVertical: 4,
      }}
    />
  );
}

/**
 * Web-only insets. Native safe areas are handled by SafeAreaView/insets;
 * on web we add a top status-bar allowance and a bottom allowance per the
 * expo skill guidance.
 */
export const webInsets = {
  top: Platform.OS === "web" ? 67 : 0,
  bottom: Platform.OS === "web" ? 34 : 0,
};

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
});
