import type { InvoiceLine } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Card, Divider, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency } from "@/lib/format";

/** The invoice's lines with their VAT-inclusive amounts, and the total. */
export function LineItemsCard({
  lines,
  grandTotal,
}: {
  lines: InvoiceLine[];
  grandTotal: string;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="heading">Line items</AppText>
      <Card style={{ gap: 8 }}>
        {lines.map((l, i) => (
          <View key={l.id}>
            {i > 0 ? <Divider /> : null}
            <View style={rowBetween}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <AppText variant="label">{l.description}</AppText>
                <AppText variant="caption" color={colors.mutedForeground}>
                  {l.quantity} × {formatCurrency(l.unitPrice)} · VAT{" "}
                  {(Number(l.vatRate) * 100).toFixed(1)}%
                </AppText>
              </View>
              <AppText variant="label">
                {formatCurrency(Number(l.lineExtension) + Number(l.vatAmount))}
              </AppText>
            </View>
          </View>
        ))}
        <Divider />
        <View style={rowBetween}>
          <AppText variant="heading">Total</AppText>
          <AppText variant="heading">{formatCurrency(grandTotal)}</AppText>
        </View>
      </Card>
    </View>
  );
}
