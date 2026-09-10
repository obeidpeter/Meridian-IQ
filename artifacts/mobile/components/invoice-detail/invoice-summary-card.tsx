import type { Invoice } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Badge, Card, Divider, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDate, humanize } from "@/lib/format";
import { INVOICE_STATUS_TONE } from "@/lib/invoice-status";

/** Number, dates, status and grand total — the card at the top. */
export function InvoiceSummaryCard({ invoice }: { invoice: Invoice }) {
  const colors = useColors();
  return (
    <Card>
      <View style={rowBetween}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <AppText variant="title">{invoice.invoiceNumber}</AppText>
          <AppText
            variant="caption"
            color={colors.mutedForeground}
            style={{ marginTop: 4 }}
          >
            Issued {formatDate(invoice.issueDate)}
            {invoice.dueDate ? ` · Due ${formatDate(invoice.dueDate)}` : ""}
          </AppText>
        </View>
        <Badge
          label={humanize(invoice.status)}
          tone={INVOICE_STATUS_TONE[invoice.status]}
        />
      </View>
      <Divider />
      <View style={[rowBetween, { marginTop: 4 }]}>
        <AppText variant="body" color={colors.mutedForeground}>
          Total
        </AppText>
        <AppText variant="heading" color={colors.primary}>
          {formatCurrency(invoice.grandTotal)}
        </AppText>
      </View>
    </Card>
  );
}
