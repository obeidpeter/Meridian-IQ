import React from "react";

import { AppText, Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { FocusArea } from "@/lib/fix-invoice";

/** What the rail rejected, pointing at the highlighted sections below. */
export function RailFocusCard({ focus }: { focus: FocusArea[] }) {
  const colors = useColors();
  if (focus.length === 0) return null;
  return (
    <Card
      style={{
        borderColor: colors.warning,
        borderWidth: 1,
      }}
    >
      <AppText variant="label">
        {focus.includes("parties")
          ? "The rail rejected a tax identification number (TIN). Check the highlighted business details below, then retry."
          : focus.includes("invoiceNumber")
            ? "The rail flagged this invoice number as a duplicate. Change the invoice number below, then retry."
            : "The rail rejected the invoice data. Check the highlighted invoice fields and line items, then retry."}
      </AppText>
    </Card>
  );
}
