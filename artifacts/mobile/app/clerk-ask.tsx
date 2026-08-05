import { Feather } from "@expo/vector-icons";
import { useAskClerk, useSubmitClerkFeedback } from "@workspace/api-client-react";
import type { ClerkAnswer } from "@workspace/api-client-react";
import { Stack, useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Banner,
  Card,
  Divider,
  EmptyState,
  rowBetween,
  screenContent,
  stackHeaderOptions,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage, hasStatus } from "@/lib/api-error";
import {
  answerLinks,
  answerSections,
  answerSourceNote,
  askableQuestion,
  dataAnswerScope,
  feedbackToSubmit,
  followupPinsLine,
  heldAnswer,
  holdsFollowupCase,
  planLine,
  QUESTION_MAX,
  sectionKey,
  SUGGESTED_QUESTIONS,
  type AskFeedback,
  type HeldAnswer,
} from "@/lib/clerk-ask";
import { useSession } from "@/lib/session";

// Register-grounded Q&A behind clerk.ask — the mobile cousin of the SME web
// app's Ask page. Firm principals ask across their portfolio; a client_user
// asks too, pinned server-side to their own business (SEC-03). Every answer
// cites an approved claim from the compliance register or a fixed lookup
// over the asker's own records; anything not covered is refused, never
// improvised.

export default function ClerkAskScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const canAsk = !!me?.capabilities?.includes("clerk.ask");

  const [question, setQuestion] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  // Multi-turn (round 12): follow-ups carry the previous data answer's scope
  // ("and for June?"); the server re-verifies the id belongs to this asker
  // before using it, so threading a stale id is safe.
  const [previousCaseId, setPreviousCaseId] = useState<string | null>(null);
  // The rendered answer lives in state, NOT ask.data: submitting a follow-up
  // resets the mutation's data, which would blank the very answer being
  // followed up on (and never bring it back if the follow-up errors). Held
  // here it stays visible through the in-flight follow-up and survives a
  // follow-up error; every SUCCESS replaces it via heldAnswer — including a
  // success with no answer payload, which clears a stale one. That is the
  // console Ask page's tested semantic, mirrored in the SME web app too.
  // The carrier also threads the answered case's id, which the feedback
  // thumbs and deep links act on.
  const [lastAnswer, setLastAnswer] = useState<HeldAnswer | null>(null);

  const ask = useAskClerk();

  // One submit path for the Ask button and the suggested chips. A chip
  // passes its own text because setState hasn't landed yet when it fires.
  const submitQuestion = async (raw: string) => {
    const q = askableQuestion(raw);
    if (!q || ask.isPending) return;
    setBanner(null);
    try {
      const row = await ask.mutateAsync({
        data: {
          question: q,
          ...(previousCaseId ? { previousCaseId } : {}),
        },
      });
      setLastAnswer((prev) =>
        heldAnswer(prev, { type: "success", answer: row.answer, caseId: row.id }),
      );
      // Only an answer carrying scope worth inheriting threads: a data
      // answer, a multi-intent (sections) answer, or pinned scope (Ask 2.0).
      // Keeping the last such id preserves the thread across a refusal or a
      // register-claim answer in between.
      if (holdsFollowupCase(row.answer)) {
        setPreviousCaseId(row.id);
      }
      setQuestion("");
    } catch (error) {
      // The held answer is deliberately untouched here — heldAnswer's error
      // semantic: the previous answer is still the newest truth given.
      // The capture screen's friendly split: 429 is the firm's monthly Clerk
      // allowance, 503 is the kill switch; anything else relays the server's
      // own words before the fallback.
      if (hasStatus(error, 429)) {
        setBanner(
          "Clerk has reached its usage limit for now. Please try again later.",
        );
        return;
      }
      if (hasStatus(error, 503)) {
        setBanner("Clerk is switched off right now. Please try again later.");
        return;
      }
      setBanner(
        apiErrorMessage(
          error,
          "Clerk couldn't take that question. Please try again.",
        ),
      );
    }
  };

  // The visible face of the multi-turn thread: when the held answer pinned a
  // display scope (a month label, a client name), say what a follow-up will
  // keep — and offer a way off the thread. Clearing drops previousCaseId
  // only; the answer stays on screen.
  const pinsLine = previousCaseId ? followupPinsLine(lastAnswer?.answer) : "";

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Ask Clerk")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          screenContent,
          { paddingBottom: insets.bottom + 48 },
        ]}
        bottomOffset={20}
      >
        {!canAsk ? (
          <EmptyState
            icon="lock"
            title="Ask Clerk isn't available on your account"
            message="Ask your accounting firm to enable Clerk questions for you."
          />
        ) : (
          <View style={{ gap: 20 }}>
            <Banner
              tone="info"
              message="Answers come from the approved compliance register or live lookups over your own records — nothing is improvised."
            />

            {banner ? <Banner tone="error" message={banner} /> : null}

            <Card style={{ gap: 12 }}>
              <TextField
                label="Your question"
                value={question}
                onChangeText={setQuestion}
                placeholder="What VAT rate applies to a consulting invoice? What is overdue this week?"
                multiline
                maxLength={QUESTION_MAX}
                autoCapitalize="sentences"
                style={{ minHeight: 90, textAlignVertical: "top" }}
                hint="Rules come from the approved register; numbers are computed live from your own records. Anything else is refused rather than guessed."
                testID="input-ask-question"
              />
              {pinsLine ? (
                <View style={styles.followupRow} testID="chip-followup-pins">
                  <AppText
                    variant="caption"
                    color={colors.mutedForeground}
                    style={styles.followupLabel}
                  >
                    {pinsLine}
                  </AppText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start a new topic"
                    hitSlop={8}
                    onPress={() => setPreviousCaseId(null)}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        borderColor: colors.border,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                    testID="button-clear-followup"
                  >
                    <AppText variant="caption" color={colors.mutedForeground}>
                      × New topic
                    </AppText>
                  </Pressable>
                </View>
              ) : null}
              <View style={styles.chipRow}>
                {SUGGESTED_QUESTIONS.map((q, i) => (
                  <Pressable
                    key={q}
                    accessibilityRole="button"
                    accessibilityLabel={`Ask: ${q}`}
                    disabled={ask.isPending}
                    onPress={() => {
                      setQuestion(q);
                      void submitQuestion(q);
                    }}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        backgroundColor: colors.secondary,
                        borderColor: colors.border,
                        opacity: ask.isPending ? 0.5 : pressed ? 0.7 : 1,
                      },
                    ]}
                    testID={`chip-suggested-${i}`}
                  >
                    <AppText variant="caption" color={colors.secondaryForeground}>
                      {q}
                    </AppText>
                  </Pressable>
                ))}
              </View>
              <AppButton
                label={ask.isPending ? "Checking the register…" : "Ask Clerk"}
                icon="message-circle"
                onPress={() => void submitQuestion(question)}
                disabled={!askableQuestion(question) || ask.isPending}
                loading={ask.isPending}
                testID="button-ask"
              />
            </Card>

            {lastAnswer ? (
              // Keyed by case so the feedback selection resets per answer.
              <AnswerCard
                key={lastAnswer.caseId ?? "answer"}
                answer={lastAnswer.answer}
                caseId={lastAnswer.caseId}
              />
            ) : null}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}

function AnswerCard({
  answer,
  caseId,
}: {
  answer: ClerkAnswer;
  caseId: string | null;
}) {
  const colors = useColors();
  const router = useRouter();
  // The asker's helpfulness signal, held per answer (the card remounts per
  // case via its key). Optimistic: the thumb fills on press and reverts if
  // the server rejects the write — feedback is best-effort, never noisy.
  const [feedback, setFeedback] = useState<AskFeedback | null>(null);
  // Plain generated mutation, same client idiom as the ask call above —
  // session auth rides on the shared fetch, no per-call headers.
  const submitFeedback = useSubmitClerkFeedback();

  const pressFeedback = (pressed: AskFeedback) => {
    if (!caseId || submitFeedback.isPending) return;
    const next = feedbackToSubmit(feedback, pressed);
    if (next == null) return; // same thumb again — the server already knows
    const previous = feedback;
    setFeedback(next);
    submitFeedback.mutate(
      { id: caseId, data: { helpful: next === "helpful" } },
      { onError: () => setFeedback(previous) },
    );
  };

  if (!answer.answered) {
    return (
      <Card style={{ gap: 10 }}>
        <View style={styles.refusalHeader}>
          <Feather name="shield" size={16} color={colors.mutedForeground} />
          <AppText variant="label">Clerk declined to answer</AppText>
        </View>
        <AppText variant="body" color={colors.mutedForeground}>
          {answer.refusalReason ??
            "That isn't covered by the approved register yet."}
        </AppText>
      </Card>
    );
  }
  const links = answerLinks(answer);
  // Multi-intent answers (contract 0.56.0) carry sections — the proposition
  // is a lead-in line and the flat facts are empty. Single-intent answers
  // carry no sections and render the flat fields exactly as before.
  const sections = answerSections(answer);
  const hasSections = sections.length > 0;
  const plan = planLine(answer);
  const sourceNote = answerSourceNote(answer);
  return (
    <Card style={{ gap: 12 }}>
      <AppText variant="body">{answer.proposition ?? ""}</AppText>
      {/* Plan transparency: which catalogued intents answered, in server
          order — quiet, above the sections. */}
      {plan ? (
        <View testID="text-answer-plan">
          <AppText variant="caption" color={colors.mutedForeground}>
            {plan}
          </AppText>
        </View>
      ) : null}
      {hasSections
        ? sections.map((s, i) => {
            const sectionLinks = answerLinks({ links: s.links });
            const scope = dataAnswerScope(s.dataParams);
            return (
              <View
                key={`section-${i}`}
                style={[styles.section, { borderColor: colors.border }]}
                testID={`section-answer-${i}`}
              >
                <AppText variant="label">{s.title}</AppText>
                <AppText variant="body">{s.text}</AppText>
                {/* Do with Clerk (round 31): mobile has no approval control
                    for action-proposal sections — say so instead of letting
                    the section text's "approve it below" dangle. Approval
                    lives on the web app (and the dashboard's actions card),
                    where the execute route re-checks everything. */}
                {s.action ? (
                  <View testID={`text-action-web-only-${i}`}>
                    <AppText variant="caption" color={colors.mutedForeground}>
                      To approve and run this proposal, open MeridianIQ on
                      the web — approvals are not available in the mobile
                      app yet.
                    </AppText>
                  </View>
                ) : null}
                {s.facts.length > 0 ? (
                  <View style={{ gap: 8 }}>
                    {s.facts.map((f) => (
                      <View
                        key={f.key}
                        style={rowBetween}
                        // Section-indexed (`row-fact-<i>-<key>`) so the row
                        // stays unique when two sections carry the same
                        // fact key (e.g. "count").
                        testID={sectionKey(i, f.key)}
                      >
                        <AppText
                          variant="caption"
                          color={colors.mutedForeground}
                        >
                          {f.label}
                        </AppText>
                        <AppText
                          variant="label"
                          numberOfLines={2}
                          style={styles.factValue}
                        >
                          {f.value}
                          {f.unit ? ` ${f.unit}` : ""}
                        </AppText>
                      </View>
                    ))}
                  </View>
                ) : null}
                {sectionLinks.length > 0 ? (
                  <View style={styles.linkRow}>
                    {sectionLinks.map((l) => (
                      <AppButton
                        key={l.id}
                        label={`Open ${l.label}`}
                        icon="arrow-right"
                        variant="ghost"
                        fullWidth={false}
                        onPress={() => router.push(`/invoices/${l.id}`)}
                        testID={`link-answer-invoice-${l.id}`}
                      />
                    ))}
                  </View>
                ) : null}
                {scope ? (
                  <View testID={`text-section-scope-${i}`}>
                    <AppText variant="caption" color={colors.mutedForeground}>
                      {scope}
                    </AppText>
                  </View>
                ) : null}
              </View>
            );
          })
        : null}
      {!hasSections && answer.facts && answer.facts.length > 0 ? (
        <>
          <Divider />
          <View style={{ gap: 8 }}>
            {answer.facts.map((f) => (
              <View key={f.key} style={rowBetween}>
                <AppText variant="caption" color={colors.mutedForeground}>
                  {f.label}
                </AppText>
                <AppText variant="label" numberOfLines={2} style={styles.factValue}>
                  {f.value}
                  {f.unit ? ` ${f.unit}` : ""}
                </AppText>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {/* Deep links to the records the answer named: invoice-kind links with
          an id only — anything else was dropped by answerLinks. */}
      {!hasSections && links.length > 0 ? (
        <View style={styles.linkRow}>
          {links.map((l) => (
            <AppButton
              key={l.id}
              label={`Open ${l.label}`}
              icon="arrow-right"
              variant="ghost"
              fullWidth={false}
              onPress={() => router.push(`/invoices/${l.id}`)}
              testID={`link-answer-invoice-${l.id}`}
            />
          ))}
        </View>
      ) : null}
      {sourceNote ? (
        <AppText variant="caption" color={colors.mutedForeground}>
          {sourceNote}
        </AppText>
      ) : null}
      {caseId ? (
        <View style={styles.feedbackRow}>
          <AppText variant="caption" color={colors.mutedForeground}>
            Was this helpful?
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="This answer was helpful"
            accessibilityState={{ selected: feedback === "helpful" }}
            hitSlop={8}
            onPress={() => pressFeedback("helpful")}
            style={({ pressed }) => [
              styles.thumb,
              {
                borderColor:
                  feedback === "helpful" ? colors.primary : colors.border,
                backgroundColor:
                  feedback === "helpful" ? colors.secondary : "transparent",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            testID="button-feedback-helpful"
          >
            <Feather
              name="thumbs-up"
              size={16}
              color={
                feedback === "helpful"
                  ? colors.primary
                  : colors.mutedForeground
              }
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="This answer was not helpful"
            accessibilityState={{ selected: feedback === "not_helpful" }}
            hitSlop={8}
            onPress={() => pressFeedback("not_helpful")}
            style={({ pressed }) => [
              styles.thumb,
              {
                borderColor:
                  feedback === "not_helpful" ? colors.primary : colors.border,
                backgroundColor:
                  feedback === "not_helpful"
                    ? colors.secondary
                    : "transparent",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            testID="button-feedback-not-helpful"
          >
            <Feather
              name="thumbs-down"
              size={16}
              color={
                feedback === "not_helpful"
                  ? colors.primary
                  : colors.mutedForeground
              }
            />
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  followupRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  followupLabel: {
    flexShrink: 1,
  },
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  refusalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  factValue: {
    flexShrink: 1,
    marginLeft: 12,
    textAlign: "right",
  },
  linkRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  feedbackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  thumb: {
    padding: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
