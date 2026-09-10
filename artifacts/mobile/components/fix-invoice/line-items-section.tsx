import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { LineItemCard } from "@/components/invoice-line-editor";
import { AppText, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";

/** "Line items" on the fix screen: the header with its Add action and the cards. */
export function LineItemsSection({
  highlighted,
  lines,
  lineErrors,
  onAdd,
  onUpdate,
  onRemove,
}: {
  highlighted: boolean;
  lines: LineDraft[];
  lineErrors: LineErrors;
  onAdd: () => void;
  onUpdate: (key: string, patch: Partial<LineDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 12 }}>
      <View style={rowBetween}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <AppText variant="heading">Line items</AppText>
          {highlighted ? (
            <Feather name="alert-circle" size={16} color={colors.destructive} />
          ) : null}
        </View>
        <Pressable onPress={onAdd} style={styles.addBtn}>
          <Feather name="plus" size={16} color={colors.primary} />
          <AppText variant="label" color={colors.primary}>
            Add
          </AppText>
        </Pressable>
      </View>

      {lines.map((line, index) => (
        <LineItemCard
          key={line.key}
          line={line}
          index={index}
          canRemove={lines.length > 1}
          errors={lineErrors[line.key]}
          onChange={(patch) => onUpdate(line.key, patch)}
          onRemove={() => onRemove(line.key)}
          highlighted={highlighted}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
});
