import { Feather } from "@expo/vector-icons";
import { useAskClerk } from "@workspace/api-client-react";
import type { ClerkAnswer } from "@workspace/api-client-react";
import { Stack } from "expo-router";
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
  stackHeaderOptions,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage, hasStatus } from "@/lib/api-error";
import {
  answerSourceNote,
  askableQuestion,
  heldAnswer,
  QUESTION_MAX,
  SUGGESTED_QUESTIONS,
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
  const [lastAnswer, setLastAnswer] = useState<ClerkAnswer | null>(null);

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
        heldAnswer(prev, { type: "success", answer: row.answer }),
      );
      // Only a DATA answer carries scope worth threading — keeping the last
      // data-answered id preserves the thread across a refusal or a
      // register-claim answer in between.
      if (row.answer?.answered && row.answer.dataIntent) {
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

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Ask Clerk")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
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

            {lastAnswer ? <AnswerCard answer={lastAnswer} /> : null}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  const colors = useColors();
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
  return (
    <Card style={{ gap: 12 }}>
      <AppText variant="body">{answer.proposition ?? ""}</AppText>
      {answer.facts && answer.facts.length > 0 ? (
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
      <AppText variant="caption" color={colors.mutedForeground}>
        {answerSourceNote(answer)}
      </AppText>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
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
});
