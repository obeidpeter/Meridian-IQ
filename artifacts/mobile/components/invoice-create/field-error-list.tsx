import type { FieldError } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Badge } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { humanizeFieldPath } from "@/lib/invoice-create";

/** The server's per-field validation errors, labelled by field path. */
export function FieldErrorList({ errors }: { errors: FieldError[] }) {
  const colors = useColors();
  return errors.length > 0 ? (
    <View style={{ gap: 4 }}>
      {errors.map((e, i) => (
        <View key={`${e.field}-${i}`} style={{ flexDirection: "row", gap: 6 }}>
          <Badge label={humanizeFieldPath(e.field)} tone="critical" />
          <AppText
            variant="caption"
            color={colors.destructiveText}
            style={{ flex: 1 }}
          >
            {e.message}
          </AppText>
        </View>
      ))}
    </View>
  ) : null;
}
