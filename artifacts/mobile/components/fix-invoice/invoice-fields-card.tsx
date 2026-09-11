import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Card, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { FixInvoiceFields } from "@/hooks/useFixInvoiceFields";
import type { FocusArea } from "@/lib/fix-invoice";

/** "Invoice details": number, dates and notes, highlighted when implicated. */
export function InvoiceFieldsCard({
  focus,
  fields,
}: {
  focus: FocusArea[];
  fields: FixInvoiceFields;
}) {
  const colors = useColors();
  const {
    invoiceNumber,
    setInvoiceNumber,
    issueDate,
    setIssueDate,
    dueDate,
    setDueDate,
    notes,
    setNotes,
    issueDateError,
    setIssueDateError,
    dueDateError,
    setDueDateError,
  } = fields;
  const highlighted =
    focus.includes("invoice") || focus.includes("invoiceNumber");
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppText variant="heading">Invoice details</AppText>
        {highlighted ? (
          <Feather name="alert-circle" size={16} color={colors.destructive} />
        ) : null}
      </View>
      <Card
        style={{
          gap: 12,
          borderColor: highlighted ? colors.destructive : colors.border,
          borderWidth: highlighted ? 1 : StyleSheet.hairlineWidth,
        }}
      >
        <TextField
          label="Invoice number"
          value={invoiceNumber}
          onChangeText={setInvoiceNumber}
          placeholder="INV-0001"
          autoCapitalize="characters"
          hint={
            focus.includes("invoiceNumber")
              ? "Enter an unused invoice number. The submission service has this number already."
              : undefined
          }
        />
        <TextField
          label="Issue date"
          value={issueDate}
          onChangeText={(t) => {
            setIssueDate(t);
            if (issueDateError) setIssueDateError(null);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          error={issueDateError}
        />
        <TextField
          label="Due date (optional)"
          value={dueDate}
          onChangeText={(t) => {
            setDueDate(t);
            if (dueDateError) setDueDateError(null);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          error={dueDateError}
        />
        <TextField
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Payment terms, reference…"
          multiline
          style={{
            height: 80,
            paddingTop: 12,
            textAlignVertical: "top",
          }}
        />
      </Card>
    </View>
  );
}
