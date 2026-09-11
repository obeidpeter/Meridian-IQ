import { Feather } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppButton, AppText, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { BuyerPickerState } from "@/hooks/useBuyerPicker";

export function BuyerPicker({
  picker,
  selectedId,
  onSelect,
  disabled,
  error,
}: {
  picker: BuyerPickerState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
  error?: string;
}) {
  const colors = useColors();
  const blocked = disabled || !picker.available;
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="heading">Customer</AppText>
      <TextField
        label="Search customers"
        accessibilityLabel="Search customers by name or TIN"
        value={picker.search}
        onChangeText={picker.setSearch}
        placeholder="Name or TIN"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={120}
        editable={!blocked}
      />
      {selectedId ? (
        <View style={{ gap: 8, paddingVertical: 8 }}>
          <View
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
          >
            <Feather name="check-circle" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <AppText variant="label">Selected customer</AppText>
              <AppText>
                {picker.selected?.legalName ??
                  (picker.selectionPaused
                    ? "Waiting for connection"
                    : picker.selectionError
                      ? "Selected customer unavailable"
                      : "Checking selected customer...")}
              </AppText>
              {picker.selected?.tin ? (
                <AppText variant="caption" color={colors.mutedForeground}>
                  TIN {picker.selected.tin}
                </AppText>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear selected customer"
              accessibilityState={{ disabled: blocked }}
              disabled={blocked}
              onPress={() => onSelect(null)}
              style={{
                minWidth: 48,
                minHeight: 48,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Feather name="x" size={20} color={colors.primary} />
            </Pressable>
          </View>
          {picker.selectionError ? (
            <AppButton
              label="Check customer again"
              icon="refresh-cw"
              variant="ghost"
              onPress={picker.retrySelection}
              disabled={blocked}
            />
          ) : null}
        </View>
      ) : null}
      <View accessibilityLiveRegion="polite">
        {!picker.available ? (
          <AppText color={colors.mutedForeground}>
            Verify your sign-in to search customers.
          </AppText>
        ) : picker.paused ? (
          <AppText color={colors.mutedForeground}>
            Waiting for connection...
          </AppText>
        ) : picker.loading ? (
          <View
            style={{ flexDirection: "row", gap: 8 }}
            accessibilityState={{ busy: true }}
          >
            <ActivityIndicator color={colors.primary} />
            <AppText>Searching customers...</AppText>
          </View>
        ) : picker.error ? (
          <View accessibilityRole="alert" style={{ gap: 8 }}>
            <AppText color={colors.destructiveText}>
              Could not load customers. Check your connection and account
              access.
            </AppText>
            <AppButton
              label="Try search again"
              icon="refresh-cw"
              variant="ghost"
              onPress={picker.retry}
              disabled={blocked}
            />
          </View>
        ) : picker.items.length === 0 ? (
          <AppText color={colors.mutedForeground}>
            {picker.search.trim()
              ? "No customers match this search."
              : picker.offset
                ? "No more customers."
                : "No customers available."}
          </AppText>
        ) : null}
      </View>
      {!picker.loading && !picker.paused && picker.items.length > 0 ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Customer search results"
        >
          {picker.items.map((buyer) => (
            <Pressable
              key={buyer.id}
              accessibilityRole="radio"
              accessibilityLabel={
                buyer.tin
                  ? `${buyer.legalName}, TIN ${buyer.tin}`
                  : buyer.legalName
              }
              accessibilityState={{
                selected: buyer.id === selectedId,
                disabled: blocked,
              }}
              disabled={blocked}
              onPress={() => onSelect(buyer.id)}
              style={{
                minHeight: 56,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderColor: colors.border,
              }}
            >
              <View style={{ flex: 1 }}>
                <AppText variant="label">{buyer.legalName}</AppText>
                {buyer.tin ? (
                  <AppText variant="caption" color={colors.mutedForeground}>
                    TIN {buyer.tin}
                  </AppText>
                ) : null}
              </View>
              <Feather
                name={buyer.id === selectedId ? "check-circle" : "circle"}
                size={20}
                color={
                  buyer.id === selectedId
                    ? colors.primary
                    : colors.mutedForeground
                }
              />
            </Pressable>
          ))}
        </View>
      ) : null}
      {picker.available && (picker.offset > 0 || picker.hasNext) ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <AppButton
            label="Previous"
            icon="chevron-left"
            variant="ghost"
            fullWidth={false}
            onPress={picker.previous}
            disabled={blocked || picker.loading || picker.offset === 0}
          />
          <AppButton
            label="Next"
            icon="chevron-right"
            variant="ghost"
            fullWidth={false}
            onPress={picker.next}
            disabled={blocked || picker.loading || !picker.hasNext}
          />
        </View>
      ) : null}
      {error ? (
        <View accessibilityRole="alert">
          <AppText variant="caption" color={colors.destructiveText}>
            {error}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
