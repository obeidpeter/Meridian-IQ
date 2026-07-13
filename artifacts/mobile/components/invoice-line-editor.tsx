import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Card, Divider, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency } from "@/lib/format";
import { num } from "@/lib/invoice-form";
import type { LineDraft } from "@/lib/invoice-form";

/**
 * One editable line-item card, shared by the create-invoice tab and the
 * fix-invoice screen. Render it with key={line.key} at the call site so React
 * reconciles per line and TextInput focus survives sibling adds/removals.
 */
export function LineItemCard({
  line,
  index,
  canRemove,
  errors,
  onChange,
  onRemove,
  highlighted = false,
}: {
  line: LineDraft;
  index: number;
  canRemove: boolean;
  errors?: { quantity?: string; unitPrice?: string };
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  highlighted?: boolean;
}) {
  const colors = useColors();
  const ext = num(line.quantity) * num(line.unitPrice);
  return (
    <Card
      style={{
        gap: 12,
        // Only override the border when highlighted — Card's defaults
        // (colors.border + hairline width) already match the plain look.
        ...(highlighted
          ? { borderColor: colors.destructive, borderWidth: 1 }
          : {}),
      }}
    >
      <View style={styles.rowBetween}>
        <AppText variant="label" color={colors.mutedForeground}>
          Item {index + 1}
        </AppText>
        {canRemove ? (
          <Pressable
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`Remove line ${index + 1}`}
            hitSlop={12}
            style={styles.trashBtn}
          >
            <Feather name="trash-2" size={18} color={colors.destructiveText} />
          </Pressable>
        ) : null}
      </View>
      <TextField
        label="Description"
        value={line.description}
        onChangeText={(t) => onChange({ description: t })}
        placeholder="Consulting services"
      />
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <TextField
            label="Qty"
            value={line.quantity}
            onChangeText={(t) => onChange({ quantity: t })}
            keyboardType="decimal-pad"
            placeholder="1"
            error={errors?.quantity}
          />
        </View>
        <View style={{ flex: 1.4 }}>
          <TextField
            label="Unit price"
            value={line.unitPrice}
            onChangeText={(t) => onChange({ unitPrice: t })}
            keyboardType="decimal-pad"
            placeholder="0.00"
            error={errors?.unitPrice}
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextField
            label="VAT %"
            value={line.vatRate}
            onChangeText={(t) => onChange({ vatRate: t })}
            keyboardType="decimal-pad"
            placeholder="7.5"
          />
        </View>
      </View>
      <View style={styles.rowBetween}>
        <AppText variant="caption" color={colors.mutedForeground}>
          Line total
        </AppText>
        <AppText variant="label">{formatCurrency(ext)}</AppText>
      </View>
    </Card>
  );
}

/** The subtotal/VAT/grand-total summary card, fed by computeTotals(). */
export function TotalsCard({
  totals,
}: {
  totals: { subtotal: number; vat: number; grand: number };
}) {
  const colors = useColors();
  return (
    <Card style={{ gap: 8, backgroundColor: colors.secondary }}>
      <View style={styles.rowBetween}>
        <AppText variant="body" color={colors.mutedForeground}>
          Subtotal
        </AppText>
        <AppText variant="body">{formatCurrency(totals.subtotal)}</AppText>
      </View>
      <View style={styles.rowBetween}>
        <AppText variant="body" color={colors.mutedForeground}>
          VAT
        </AppText>
        <AppText variant="body">{formatCurrency(totals.vat)}</AppText>
      </View>
      <Divider />
      <View style={styles.rowBetween}>
        <AppText variant="heading">Total</AppText>
        <AppText variant="heading" color={colors.primary}>
          {formatCurrency(totals.grand)}
        </AppText>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  trashBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
