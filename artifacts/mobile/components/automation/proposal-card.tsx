import type { ActionProposal } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppButton, AppText, Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { proposalCountLine, proposalMobileGateNote } from "@/lib/automation";

import { styles } from "./styles";

export function ProposalCard({
  action,
  canAct,
  canAutomate,
  busy,
  onApprove,
  onAutomate,
}: {
  action: ActionProposal;
  canAct: boolean;
  /** Flag lit, automatable kind, no live grant yet, and the user may act. */
  canAutomate: boolean;
  busy: boolean;
  onApprove: () => void;
  onAutomate: () => void;
}) {
  const colors = useColors();
  const gateNote = proposalMobileGateNote(action.kind);
  return (
    <View testID={`action-${action.kind}`}>
      <Card style={{ gap: 8 }}>
        <AppText variant="label">{action.title}</AppText>
        <AppText variant="body" color={colors.mutedForeground}>
          {action.why}
        </AppText>
        <AppText variant="caption" color={colors.mutedForeground}>
          {proposalCountLine(action)}
        </AppText>
        {gateNote ? (
          <AppText variant="caption" color={colors.mutedForeground}>
            {gateNote}
          </AppText>
        ) : canAct ? (
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <AppButton
                label="Review & approve"
                icon="send"
                onPress={onApprove}
                disabled={busy}
                testID={`button-approve-${action.kind}`}
              />
            </View>
            {canAutomate ? (
              <View style={{ flex: 1 }}>
                <AppButton
                  label="Automate daily"
                  icon="repeat"
                  variant="secondary"
                  onPress={onAutomate}
                  disabled={busy}
                  testID={`button-automate-${action.kind}`}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </Card>
    </View>
  );
}
