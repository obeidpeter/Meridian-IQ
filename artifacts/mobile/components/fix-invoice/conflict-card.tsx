import type { Invoice, InvoiceDetail } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppButton, AppText } from "@/components/ui";

/**
 * The optimistic-concurrency conflict (409): the saved revision beside the
 * user's edits, with the two ways out. Nothing until a conflict is live.
 */
export function ConflictCard({
  conflict,
  invoice,
  detail,
  invoiceNumber,
  issueDate,
  dueDate,
  lineCount,
  onReload,
  onKeep,
}: {
  conflict: boolean;
  invoice: Invoice | undefined;
  detail: InvoiceDetail | undefined;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  lineCount: number;
  onReload: () => void;
  /** Keep the edits against the saved revision handed back here. */
  onKeep: (saved: Invoice) => void;
}) {
  if (!conflict || !invoice) return null;
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="heading">Review the saved version</AppText>
      <AppText>
        Saved revision {invoice.contentRevision}: {invoice.invoiceNumber},
        issued {invoice.issueDate}, due {invoice.dueDate ?? "not set"},{" "}
        {detail?.lines.length ?? 0} lines.
      </AppText>
      <AppText>
        Your edits: {invoiceNumber}, issued {issueDate}, due{" "}
        {dueDate || "not set"}, {lineCount} lines. Your unsaved entries are
        still in the form.
      </AppText>
      <AppButton
        label="Reload saved version"
        icon="refresh-cw"
        variant="secondary"
        onPress={onReload}
      />
      <AppButton
        label="Keep my edits"
        icon="edit-2"
        variant="secondary"
        onPress={() => onKeep(invoice)}
      />
    </View>
  );
}
