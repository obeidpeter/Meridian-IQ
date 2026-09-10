import type { ClerkActionPolicy } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Card, Divider } from "@/components/ui";

import { PolicyRow } from "./policy-row";

/** The live grants, one row each; nothing when there are none. */
export function StandingApprovalsCard({
  policies,
  canAct,
  busy,
  onPause,
  onResume,
  onRevoke,
}: {
  policies: ClerkActionPolicy[];
  canAct: boolean;
  busy: boolean;
  onPause: (policy: ClerkActionPolicy) => void;
  onResume: (policy: ClerkActionPolicy) => void;
  onRevoke: (policy: ClerkActionPolicy) => void;
}) {
  if (policies.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      <AppText variant="heading">Standing approvals</AppText>
      <Card style={{ gap: 4 }}>
        {policies.map((policy, index) => (
          <View key={policy.id}>
            {index > 0 ? <Divider /> : null}
            <PolicyRow
              policy={policy}
              canAct={canAct}
              busy={busy}
              onPause={() => onPause(policy)}
              onResume={() => onResume(policy)}
              onRevoke={() => onRevoke(policy)}
            />
          </View>
        ))}
      </Card>
    </View>
  );
}
