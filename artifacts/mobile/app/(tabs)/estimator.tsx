import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { AppText, Card, Divider, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  FILING_TYPE_OPTIONS,
  FilingType,
  S103_FIRST_DAY,
  S103_PER_ADDITIONAL_DAY,
  S104_PER_INVOICE,
  TURNOVER_BAND_OPTIONS,
  TurnoverBand,
  formatNaira,
  section103Penalty,
  section104Penalty,
} from "@/lib/penalty";

function parseCount(raw: string): number {
  const n = Number(raw.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default function EstimatorScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [filingType, setFilingType] = useState<FilingType>("invoice");
  const [band, setBand] = useState<TurnoverBand>("small");
  const [daysRaw, setDaysRaw] = useState("");
  const [invoicesRaw, setInvoicesRaw] = useState("");

  const showAccess = filingType === "access" || filingType === "both";
  const showInvoice = filingType === "invoice" || filingType === "both";

  const days = parseCount(daysRaw);
  const invoices = parseCount(invoicesRaw);

  const result = useMemo(() => {
    const s103 = showAccess ? section103Penalty(days) : 0;
    const s104 = showInvoice ? section104Penalty(invoices, band) : 0;
    return { s103, s104, total: s103 + s104 };
  }, [showAccess, showInvoice, days, invoices, band]);

  const hasInput = (showAccess && days > 0) || (showInvoice && invoices > 0);

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 48 },
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <AppText variant="body" color={colors.mutedForeground}>
        Estimate your exposure under the fiscalisation penalty regime. Works
        fully offline — nothing you enter here is sent anywhere.
      </AppText>

      {/* Caption eyebrow: keeps the tracking sectionLabel no longer carries. */}
      <AppText
        variant="caption"
        color={colors.mutedForeground}
        style={[styles.sectionLabel, { letterSpacing: 0.6 }]}
      >
        WHAT HAPPENED?
      </AppText>
      <Card padded={false}>
        {FILING_TYPE_OPTIONS.map((option, index) => {
          const selected = option.value === filingType;
          return (
            <View key={option.value}>
              {index > 0 ? <Divider /> : null}
              <Pressable
                onPress={() => setFilingType(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={option.label}
                accessibilityHint={option.description}
                style={({ pressed }) => [
                  styles.optionRow,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <AppText variant="label">{option.label}</AppText>
                  <AppText
                    variant="caption"
                    color={colors.mutedForeground}
                    style={{ marginTop: 2 }}
                  >
                    {option.description}
                  </AppText>
                </View>
                <Feather
                  name={selected ? "check-circle" : "circle"}
                  size={22}
                  color={selected ? colors.primary : colors.mutedForeground}
                />
              </Pressable>
            </View>
          );
        })}
      </Card>

      {showInvoice ? (
        <>
          <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
            Turnover band
          </AppText>
          <Card padded={false}>
            {TURNOVER_BAND_OPTIONS.map((option, index) => {
              const selected = option.band === band;
              return (
                <View key={option.band}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    onPress={() => setBand(option.band)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${option.label} — ${formatNaira(
                      S104_PER_INVOICE[option.band],
                    )} per invoice`}
                    accessibilityHint={option.threshold}
                    style={({ pressed }) => [
                      styles.optionRow,
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <AppText variant="label">
                        {option.label} — {formatNaira(S104_PER_INVOICE[option.band])}
                        /invoice
                      </AppText>
                      <AppText
                        variant="caption"
                        color={colors.mutedForeground}
                        style={{ marginTop: 2 }}
                      >
                        {option.threshold}
                      </AppText>
                    </View>
                    <Feather
                      name={selected ? "check-circle" : "circle"}
                      size={22}
                      color={selected ? colors.primary : colors.mutedForeground}
                    />
                  </Pressable>
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
        Details
      </AppText>
      <Card style={{ gap: 16 }}>
        {showAccess ? (
          <TextField
            label="Days access not granted (s.103)"
            hint={`${formatNaira(S103_FIRST_DAY)} on day one, then ${formatNaira(
              S103_PER_ADDITIONAL_DAY,
            )} per additional day`}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder="0"
            value={daysRaw}
            onChangeText={setDaysRaw}
          />
        ) : null}
        {showInvoice ? (
          <TextField
            label="Non-compliant invoices (s.104)"
            hint={`${formatNaira(S104_PER_INVOICE[band])} per invoice at your band`}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder="0"
            value={invoicesRaw}
            onChangeText={setInvoicesRaw}
          />
        ) : null}
      </Card>

      <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
        Estimated exposure
      </AppText>
      <Card>
        {showAccess ? (
          <View style={styles.resultRow}>
            <AppText variant="body" color={colors.mutedForeground}>
              s.103 — Systems access
            </AppText>
            <AppText variant="label">{formatNaira(result.s103)}</AppText>
          </View>
        ) : null}
        {showInvoice ? (
          <View style={styles.resultRow}>
            <AppText variant="body" color={colors.mutedForeground}>
              s.104 — E-invoices
            </AppText>
            <AppText variant="label">{formatNaira(result.s104)}</AppText>
          </View>
        ) : null}
        <Divider />
        <View style={[styles.resultRow, { marginTop: 4 }]}>
          <AppText variant="heading">Total</AppText>
          <AppText
            variant="title"
            color={
              hasInput && result.total > 0
                ? colors.destructiveText
                : colors.foreground
            }
          >
            {formatNaira(result.total)}
          </AppText>
        </View>
      </Card>

      <View style={styles.disclaimer}>
        <Feather name="info" size={14} color={colors.mutedForeground} />
        <AppText
          variant="caption"
          color={colors.mutedForeground}
          style={{ flex: 1 }}
        >
          This is MeridianIQ's penalty model, provided as an estimate only —
          not tax or legal advice. Actual assessments are made by the tax
          authority.
        </AppText>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "web" ? 16 : 12,
  },
  sectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  disclaimer: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
    paddingHorizontal: 4,
    alignItems: "flex-start",
  },
});
