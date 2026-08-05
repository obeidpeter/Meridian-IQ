import { useQueryClient } from "@tanstack/react-query";
import {
  getGetActionDecisionsQueryKey,
  getGetActionPoliciesQueryKey,
  getGetActionProposalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMonthEndCloseQueryKey,
  getGetPenaltyExposureQueryKey,
  getListInvoicesQueryKey,
  useExecuteAction,
  useGetActionDecisions,
  useGetActionPolicies,
  useGetActionProposals,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionPolicy,
} from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useCallback, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppButton,
  AppText,
  Badge,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  screenContent,
  ScreenScroll,
  stackHeaderOptions,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage } from "@/lib/api-error";
import {
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  automatableActionKind,
  decisionLine,
  isPolicyPaused,
  POLICY_CAP_DEFAULT,
  POLICY_PAUSE_CONFIRM,
  POLICY_RESUME_CONFIRM,
  POLICY_REVOKE_CONFIRM,
  policyGrantDescription,
  policyKindLabel,
  policyStatusLine,
  proposalCountLine,
  proposalMobileGateNote,
} from "@/lib/automation";
import { confirmThen } from "@/lib/confirm";
import { useSession } from "@/lib/session";

// How many run-record lines the screen shows — the evidence trail, not an
// archive (the web card shows 5; a phone screen affords a few more).
const DECISION_DISPLAY_CAP = 10;

function ProposalCard({
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

function PolicyRow({
  policy,
  canAct,
  busy,
  onPause,
  onResume,
  onRevoke,
}: {
  policy: ClerkActionPolicy;
  canAct: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onRevoke: () => void;
}) {
  const colors = useColors();
  const paused = isPolicyPaused(policy);
  const statusLine = policyStatusLine(policy);
  return (
    <View
      style={{ gap: 8 }}
      accessible
      accessibilityLabel={`${policyKindLabel(policy.kind)}, ${statusLine}`}
      testID={`policy-${policy.kind}`}
    >
      <View style={styles.inlineRow}>
        <AppText variant="label" style={{ flexShrink: 1 }}>
          {policyKindLabel(policy.kind)}
        </AppText>
        {/* PAUSED is prominent: an amber badge, not just a quiet line — a
            paused grant means the daily sweep is NOT running. */}
        {paused ? <Badge label="Paused" tone="warning" /> : null}
      </View>
      <View testID={`text-policy-status-${policy.kind}`}>
        <AppText
          variant="caption"
          color={paused ? colors.warning : colors.mutedForeground}
        >
          {statusLine}
        </AppText>
      </View>
      {canAct ? (
        <View style={styles.buttonRow}>
          <View style={{ flex: 1 }}>
            {paused ? (
              <AppButton
                label="Resume"
                icon="play"
                variant="secondary"
                onPress={onResume}
                disabled={busy}
                testID={`button-policy-resume-${policy.kind}`}
              />
            ) : (
              <AppButton
                label="Pause"
                icon="pause"
                variant="secondary"
                onPress={onPause}
                disabled={busy}
                testID={`button-policy-pause-${policy.kind}`}
              />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <AppButton
              label="Revoke"
              icon="x-circle"
              variant="ghost"
              onPress={onRevoke}
              disabled={busy}
              testID={`button-policy-revoke-${policy.kind}`}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function AutomationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { me, clientPartyId } = useSession();
  // Same posture as the console card: a read-only viewer sees the status,
  // the paused badges and the run record — but no buttons that could only
  // ever 403.
  const canAct = !!me?.capabilities?.includes("invoice.submit");

  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const queryOpts = { enabled: !!clientPartyId, staleTime: 60_000, retry: false };
  const proposalsQuery = useGetActionProposals(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionProposalsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );
  const policiesQuery = useGetActionPolicies(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionPoliciesQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );
  const decisionsQuery = useGetActionDecisions(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionDecisionsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );

  const execute = useExecuteAction();
  const grant = useGrantActionPolicy();
  const pause = usePauseActionPolicy();
  const resume = useResumeActionPolicy();
  const revoke = useRevokeActionPolicy();
  const policyBusy =
    grant.isPending || pause.isPending || resume.isPending || revoke.isPending;

  const refetchAll = useCallback(() => {
    void proposalsQuery.refetch();
    void policiesQuery.refetch();
    void decisionsQuery.refetch();
  }, [proposalsQuery, policiesQuery, decisionsQuery]);

  // Prefix keys (no args): every param variant goes stale together.
  const invalidatePolicyQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getGetActionPoliciesQueryKey(),
    });
  }, [queryClient]);

  const invalidateAfterRun = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getGetActionProposalsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetActionDecisionsQueryKey(),
    });
    // A batch just submitted invoices — the surfaces computed from them go
    // stale together (the web card's exact set).
    void queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetPenaltyExposureQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetMonthEndCloseQueryKey(),
    });
  }, [queryClient]);

  const runApprove = useCallback(
    async (action: ActionProposal, kind: "submit_overdue" | "retry_failed") => {
      setBanner(null);
      try {
        const result = await execute.mutateAsync({
          data: {
            kind,
            invoiceIds: action.targets.map((t) => t.invoiceId),
            clientPartyId: clientPartyId ?? undefined,
          },
        });
        invalidateAfterRun();
        setBanner({
          tone: "success",
          message: `Batch complete — ${actionOutcomeSummary(result.decision)}`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(
            error,
            "We couldn't run that batch. Please try again.",
          ),
        });
      }
    },
    [execute, clientPartyId, invalidateAfterRun],
  );

  const confirmApprove = useCallback(
    (action: ActionProposal) => {
      const kind = automatableActionKind(action.kind);
      if (!kind) return;
      confirmThen(
        `Approve: ${action.title}`,
        actionConfirmDescription(kind, action.targets.length),
        actionConfirmButtonLabel(kind, action.targets.length),
        () => void runApprove(action, kind),
      );
    },
    [runApprove],
  );

  const runGrant = useCallback(
    async (kind: "submit_overdue" | "retry_failed") => {
      setBanner(null);
      try {
        await grant.mutateAsync({
          data: {
            kind,
            clientPartyId: clientPartyId ?? undefined,
            maxTargetsPerRun: POLICY_CAP_DEFAULT,
          },
        });
        invalidatePolicyQueries();
        setBanner({
          tone: "success",
          message: `Daily automation is on — ${policyKindLabel(
            kind,
          )}, up to ${POLICY_CAP_DEFAULT} per run. You can pause or revoke it below.`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(
            error,
            "We couldn't turn on that automation. Please try again.",
          ),
        });
      }
    },
    [grant, clientPartyId, invalidatePolicyQueries],
  );

  // The grant confirm IS the consent moment: the copy states the fixed cap
  // of 10 being agreed to (mobile v1 has no numeric input by design — a
  // different ceiling is chosen on the web).
  const confirmAutomate = useCallback(
    (action: ActionProposal) => {
      const kind = automatableActionKind(action.kind);
      if (!kind) return;
      confirmThen(
        policyKindLabel(kind),
        policyGrantDescription(kind, POLICY_CAP_DEFAULT),
        "Turn on daily automation",
        () => void runGrant(kind),
      );
    },
    [runGrant],
  );

  const runPolicyChange = useCallback(
    async (
      mutate: () => Promise<unknown>,
      successMessage: string,
      failureFallback: string,
    ) => {
      setBanner(null);
      try {
        await mutate();
        invalidatePolicyQueries();
        setBanner({ tone: "success", message: successMessage });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(error, failureFallback),
        });
      }
    },
    [invalidatePolicyQueries],
  );

  const confirmPause = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_PAUSE_CONFIRM.title,
        POLICY_PAUSE_CONFIRM.message,
        POLICY_PAUSE_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => pause.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} is paused.`,
            "We couldn't pause that automation. Please try again.",
          ),
      ),
    [pause, runPolicyChange],
  );

  const confirmResume = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_RESUME_CONFIRM.title,
        POLICY_RESUME_CONFIRM.message,
        POLICY_RESUME_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => resume.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} will run again from its next sweep.`,
            "We couldn't resume that automation. Please try again.",
          ),
      ),
    [resume, runPolicyChange],
  );

  const confirmRevoke = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_REVOKE_CONFIRM.title,
        POLICY_REVOKE_CONFIRM.message,
        POLICY_REVOKE_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => revoke.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} is revoked.`,
            "We couldn't revoke that automation. Please try again.",
          ),
        true,
      ),
    [revoke, runPolicyChange],
  );

  const proposals = proposalsQuery.data?.actions ?? [];
  const policies = policiesQuery.data?.policies ?? [];
  const policyKinds = new Set(policies.map((p) => p.kind));
  const decisions = decisionsQuery.data?.decisions ?? [];
  const isLoading =
    proposalsQuery.isLoading ||
    policiesQuery.isLoading ||
    decisionsQuery.isLoading;
  const isEmpty =
    proposals.length === 0 && policies.length === 0 && decisions.length === 0;

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
            refreshing={
              proposalsQuery.isRefetching ||
              policiesQuery.isRefetching ||
              decisionsQuery.isRefetching
            }
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
              here for one batch, or as a standing daily approval you can
              pause or revoke at any time.
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
                {proposals.length === 0 ? (
                  <View testID="text-actions-empty">
                    <AppText variant="body" color={colors.mutedForeground}>
                      Nothing to suggest right now — automation and history
                      below.
                    </AppText>
                  </View>
                ) : (
                  proposals.map((action) => (
                    <ProposalCard
                      key={action.kind}
                      action={action}
                      canAct={canAct}
                      canAutomate={
                        !!policiesQuery.data?.enabled &&
                        !!automatableActionKind(action.kind) &&
                        !policyKinds.has(action.kind)
                      }
                      busy={execute.isPending || policyBusy}
                      onApprove={() => confirmApprove(action)}
                      onAutomate={() => confirmAutomate(action)}
                    />
                  ))
                )}

                {policies.length > 0 ? (
                  <View style={{ gap: 10 }}>
                    <AppText variant="heading">Standing approvals</AppText>
                    <Card style={{ gap: 4 }}>
                      {policies.map((policy, index) => (
                        <View key={policy.id}>
                          {index > 0 ? <Divider /> : null}
                          <PolicyRow
                            policy={policy}
                            canAct={canAct}
                            busy={policyBusy || execute.isPending}
                            onPause={() => confirmPause(policy)}
                            onResume={() => confirmResume(policy)}
                            onRevoke={() => confirmRevoke(policy)}
                          />
                        </View>
                      ))}
                    </Card>
                  </View>
                ) : null}

                {decisions.length > 0 ? (
                  <View style={{ gap: 10 }}>
                    <AppText variant="heading">Run record</AppText>
                    <Card style={{ gap: 8 }}>
                      {decisions.slice(0, DECISION_DISPLAY_CAP).map((d) => (
                        <View key={d.id} testID={`decision-${d.id}`}>
                          <AppText
                            variant="caption"
                            color={colors.mutedForeground}
                          >
                            {decisionLine(d)}
                          </AppText>
                        </View>
                      ))}
                    </Card>
                  </View>
                ) : null}

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

const styles = StyleSheet.create({
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
});
