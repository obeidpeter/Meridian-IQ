import { Stack } from "expo-router";
import React from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProposalsList } from "@/components/automation/proposals-list";
import { RunRecordCard } from "@/components/automation/run-record-card";
import { StandingApprovalsCard } from "@/components/automation/standing-approvals-card";
import {
  AppText,
  Banner,
  CardSkeleton,
  EmptyState,
  ErrorState,
  screenContent,
  ScreenScroll,
  stackHeaderOptions,
} from "@/components/ui";
import { useAutomationActions } from "@/hooks/useAutomationActions";
import { useAutomationQueries } from "@/hooks/useAutomationQueries";
import { useColors } from "@/hooks/useColors";
import { automatableActionKind, automationLists } from "@/lib/automation";
import { useSession } from "@/lib/session";

export default function AutomationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { me, clientPartyId } = useSession();
  // Same posture as the console card: a read-only viewer sees the status,
  // the paused badges and the run record — but no buttons that could only
  // ever 403.
  const canAct = !!me?.capabilities?.includes("invoice.submit");

  const {
    proposalsQuery,
    policiesQuery,
    decisionsQuery,
    evidenceQuery,
    refetchAll,
    isLoading,
    isRefetching,
  } = useAutomationQueries(clientPartyId);
  const {
    banner,
    busy,
    confirmApprove,
    confirmAutomate,
    confirmPause,
    confirmResume,
    confirmRevoke,
  } = useAutomationActions({ clientPartyId, evidence: evidenceQuery.data });

  const { proposals, policies, policyKinds, decisions, isEmpty } =
    automationLists(
      proposalsQuery.data,
      policiesQuery.data,
      decisionsQuery.data,
    );

  const contentContainerStyle = [
    screenContent,
    { paddingBottom: insets.bottom + 48 },
  ];

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Automation")} />
      <ScreenScroll
        contentContainerStyle={contentContainerStyle}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetchAll}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </View>
        ) : proposalsQuery.isError ? (
          <ErrorState
            message="We couldn't load Clerk's suggestions."
            onRetry={refetchAll}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <AppText variant="body" color={colors.mutedForeground}>
              Clerk suggests, you decide. Nothing runs until it is approved —
              here for one batch, or as a standing daily approval you can pause
              or revoke at any time.
            </AppText>

            {banner ? (
              <Banner tone={banner.tone} message={banner.message} />
            ) : null}

            {isEmpty ? (
              <EmptyState
                icon="zap"
                title="Nothing to automate yet"
                message="When Clerk has suggestions, standing approvals or run history for this business, they will appear here."
              />
            ) : (
              <>
                <ProposalsList
                  proposals={proposals}
                  canAct={canAct}
                  canAutomate={(action) =>
                    !!policiesQuery.data?.enabled &&
                    !!automatableActionKind(action.kind) &&
                    !policyKinds.has(action.kind)
                  }
                  busy={busy}
                  onApprove={confirmApprove}
                  onAutomate={confirmAutomate}
                />

                <StandingApprovalsCard
                  policies={policies}
                  canAct={canAct}
                  busy={busy}
                  onPause={confirmPause}
                  onResume={confirmResume}
                  onRevoke={confirmRevoke}
                />

                <RunRecordCard decisions={decisions} />

                {proposalsQuery.data?.note ? (
                  <AppText variant="caption" color={colors.mutedForeground}>
                    {proposalsQuery.data.note}
                  </AppText>
                ) : null}
              </>
            )}
          </View>
        )}
      </ScreenScroll>
    </>
  );
}
