import type { ActionProposal } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

import { ProposalCard } from "./proposal-card";

/** Clerk's current suggestions, or the quiet "nothing to suggest" line. */
export function ProposalsList({
  proposals,
  canAct,
  canAutomate,
  busy,
  onApprove,
  onAutomate,
}: {
  proposals: ActionProposal[];
  canAct: boolean;
  canAutomate: (action: ActionProposal) => boolean;
  busy: boolean;
  onApprove: (action: ActionProposal) => void;
  onAutomate: (action: ActionProposal) => void;
}) {
  const colors = useColors();
  return proposals.length === 0 ? (
    <View testID="text-actions-empty">
      <AppText variant="body" color={colors.mutedForeground}>
        No suggestions right now. Review automations and run history below.
      </AppText>
    </View>
  ) : (
    proposals.map((action) => (
      <ProposalCard
        key={action.kind}
        action={action}
        canAct={canAct}
        canAutomate={canAutomate(action)}
        busy={busy}
        onApprove={() => onApprove(action)}
        onAutomate={() => onAutomate(action)}
      />
    ))
  );
}
