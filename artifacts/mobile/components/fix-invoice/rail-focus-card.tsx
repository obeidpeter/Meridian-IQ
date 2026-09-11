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
          ? "The submission service rejected a tax identification number (TIN). Check the highlighted business details, then try again."
          : focus.includes("invoiceNumber")
            ? "The submission service found this invoice number already in use. Enter an unused invoice number, then try again."
            : "The submission service rejected the invoice details. Check the highlighted fields and items, then try again."}
      </AppText>
    </Card>
  );
}
