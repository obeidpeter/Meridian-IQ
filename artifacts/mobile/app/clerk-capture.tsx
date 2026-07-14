import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListClerkCasesQueryKey,
  useCreateClerkCase,
  useListClerkCases,
} from "@workspace/api-client-react";
import type {
  ClerkCase,
  ClerkCaseCreateInput,
} from "@workspace/api-client-react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Stack } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
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
  rowBetween,
  stackHeaderOptions,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage, hasStatus } from "@/lib/api-error";
import { clerkStatusMeta, fieldLabel, pickSourceType } from "@/lib/clerk-capture";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

// The API server caps JSON bodies at 8 MB and base64 inflates a file by ~4/3,
// so anything over ~5 MB raw would bounce with an opaque 413. Catch it locally
// with a friendlier message instead.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// How each capture source presents in the submissions list — the mobile
// cousin of the console's INTAKE_KIND map, using Feather glyphs.
const SOURCE_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  voice: "mic",
  pdf: "file-text",
  image: "maximize",
  text: "message-square",
};

const SOURCE_LABEL: Record<string, string> = {
  voice: "Voice note",
  pdf: "Invoice scan",
  image: "Invoice scan",
  text: "Message",
};

export default function ClerkCaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { me } = useSession();
  const canCapture = !!me?.capabilities?.includes("clerk.capture");

  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  // The payload a 409 DUPLICATE_SOURCE bounced — held so "Create anyway" can
  // resend the exact same submission with allowDuplicate: true.
  const [duplicate, setDuplicate] = useState<ClerkCaseCreateInput | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const listKey = getListClerkCasesQueryKey({ kind: "extraction" });

  // The server scopes this list to the caller's own submissions.
  const casesQuery = useListClerkCases(
    { kind: "extraction" },
    {
      query: {
        enabled: canCapture,
        queryKey: listKey,
        retry: false,
        // Extraction runs async after create; keep polling while anything is
        // still being read so "Reading…" advances without a manual refresh.
        refetchInterval: (query) =>
          (query.state.data ?? []).some((c) => c.status === "pending")
            ? 3000
            : false,
      },
    },
  );
  const cases = casesQuery.data ?? [];

  const createMut = useCreateClerkCase();
  const busy = working || createMut.isPending;

  // Manual state rather than `isRefetching`: the pending-case poll would
  // otherwise flash the pull-to-refresh spinner on every background refetch.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await casesQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [casesQuery]);

  const submit = async (input: ClerkCaseCreateInput) => {
    setBanner(null);
    setDuplicate(null);
    try {
      await createMut.mutateAsync({ data: input });
      if (input.sourceType === "text") setText("");
      // Not awaited: a background refetch rejection must not read as a failed
      // submission after the case was already created.
      void queryClient.invalidateQueries({ queryKey: listKey });
      setBanner({
        tone: "success",
        message: "Sent to Clerk. It appears below while it's read and reviewed.",
      });
    } catch (error) {
      if (hasStatus(error, 409)) {
        // DUPLICATE_SOURCE: Clerk already has a case for this exact content.
        setDuplicate(input);
        return;
      }
      if (hasStatus(error, 422)) {
        // PDF_NO_TEXT: a scan-only PDF with no extractable text layer.
        setBanner({
          tone: "error",
          message:
            "We couldn't find any text in that PDF. Send a photo of the document instead.",
        });
        return;
      }
      if (hasStatus(error, 429)) {
        // CLERK_BUDGET_EXHAUSTED.
        setBanner({
          tone: "error",
          message: "Clerk has reached its usage limit for now. Please try again later.",
        });
        return;
      }
      if (hasStatus(error, 503)) {
        // CLERK_DISABLED kill switch.
        setBanner({
          tone: "error",
          message: "Clerk is switched off right now. Please try again later.",
        });
        return;
      }
      setBanner({
        tone: "error",
        message: apiErrorMessage(
          error,
          "We couldn't send that to Clerk. Please try again.",
        ),
      });
    }
  };

  const pickDocument = async () => {
    setBanner(null);
    setDuplicate(null);
    setWorking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "image/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (asset.size != null && asset.size > MAX_FILE_BYTES) {
        setBanner({
          tone: "error",
          message:
            "That file is too large to send. Keep it under 5 MB — a phone photo of the document works well.",
        });
        return;
      }
      const base64 = await new File(asset.uri).base64();
      const sourceType = pickSourceType(asset.name ?? "", asset.mimeType);
      await submit({
        sourceType,
        ...(asset.name ? { name: asset.name } : {}),
        ...(asset.mimeType ? { contentType: asset.mimeType } : {}),
        ...(sourceType === "pdf" ? { pdfBase64: base64 } : { imageBase64: base64 }),
      });
    } catch {
      setBanner({
        tone: "error",
        message:
          "We couldn't read that file. Pick a PDF or a photo of the invoice, or paste its text below.",
      });
    } finally {
      setWorking(false);
    }
  };

  const submitText = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void submit({ sourceType: "text", text: trimmed });
  };

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Send to Clerk")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 48 },
        ]}
        bottomOffset={20}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
      >
        {!canCapture ? (
          <EmptyState
            icon="lock"
            title="Clerk isn't available on your account"
            message="Ask your accounting firm to enable Clerk capture for you."
          />
        ) : (
          <View style={{ gap: 20 }}>
            <Banner
              tone="info"
              message="Clerk reads it — your accountant reviews before anything is created."
            />

            {banner ? (
              <Banner tone={banner.tone} message={banner.message} />
            ) : null}

            {duplicate ? (
              <Card style={{ gap: 12 }}>
                <Banner
                  tone="warning"
                  message="Clerk has already seen this exact document. Send it again anyway?"
                />
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <AppButton
                      label="Create anyway"
                      icon="copy"
                      onPress={() =>
                        void submit({ ...duplicate, allowDuplicate: true })
                      }
                      disabled={busy}
                      loading={createMut.isPending}
                      testID="button-create-anyway"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppButton
                      label="Cancel"
                      icon="x"
                      variant="secondary"
                      onPress={() => setDuplicate(null)}
                      disabled={busy}
                      testID="button-duplicate-cancel"
                    />
                  </View>
                </View>
              </Card>
            ) : null}

            <View style={{ gap: 12 }}>
              <AppText variant="heading">Capture an invoice</AppText>
              <Card style={{ gap: 12 }}>
                {Platform.OS !== "web" ? (
                  <AppButton
                    label="Pick a document"
                    icon="upload"
                    variant="secondary"
                    onPress={() => void pickDocument()}
                    disabled={busy}
                    loading={working}
                    testID="button-pick-document"
                  />
                ) : null}
                <TextField
                  label="Or paste the invoice text"
                  value={text}
                  onChangeText={setText}
                  placeholder="Paste an email, message, or typed-out invoice — Clerk pulls out the details."
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ minHeight: 110, textAlignVertical: "top" }}
                />
                <AppButton
                  label={createMut.isPending ? "Sending…" : "Send text to Clerk"}
                  icon="send"
                  onPress={submitText}
                  disabled={!text.trim() || busy}
                  loading={createMut.isPending}
                  testID="button-send-text"
                />
              </Card>
            </View>

            <View style={{ gap: 12 }}>
              <AppText variant="heading">My submissions</AppText>
              {casesQuery.isLoading ? (
                <View style={{ gap: 12 }}>
                  <CardSkeleton lines={1} />
                  <CardSkeleton lines={1} />
                </View>
              ) : casesQuery.isError ? (
                <ErrorState
                  message="We couldn't load your submissions."
                  onRetry={() => void casesQuery.refetch()}
                />
              ) : cases.length === 0 ? (
                <EmptyState
                  icon="inbox"
                  title="Nothing sent yet"
                  message="Send a document or paste text above — your submissions and their review status appear here."
                />
              ) : (
                cases.map((kase) => (
                  <CaseRow
                    key={kase.id}
                    kase={kase}
                    expanded={expandedId === kase.id}
                    onToggle={() =>
                      setExpandedId((prev) => (prev === kase.id ? null : kase.id))
                    }
                  />
                ))
              )}
            </View>
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}

function CaseRow({
  kase,
  expanded,
  onToggle,
}: {
  kase: ClerkCase;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colors = useColors();
  const meta = clerkStatusMeta(kase.status);
  const icon = SOURCE_ICON[kase.sourceType ?? ""] ?? "file-text";
  const title = kase.sourceName || SOURCE_LABEL[kase.sourceType ?? ""] || "Document";
  const fields = kase.extraction?.fields ?? [];
  const failed = kase.status === "failed";

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${title}, ${meta.label}, ${timeAgo(kase.createdAt)}`}
      accessibilityHint="Shows what Clerk read from this submission"
      testID={`clerk-case-${kase.id}`}
    >
      <Card style={{ gap: 10 }}>
        <View style={styles.caseRow}>
          <View
            style={[
              styles.iconTile,
              { backgroundColor: failed ? colors.destructiveSoft : colors.accent },
            ]}
          >
            <Feather
              name={icon}
              size={15}
              color={failed ? colors.destructiveText : colors.accentForeground}
            />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="label" numberOfLines={1}>
              {title}
            </AppText>
            <AppText variant="caption" color={colors.mutedForeground}>
              {timeAgo(kase.createdAt)}
            </AppText>
          </View>
          <Badge label={meta.label} tone={meta.tone} />
          <Feather
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.mutedForeground}
          />
        </View>
        {expanded ? (
          <>
            <Divider />
            {failed && kase.failReason ? (
              <Banner tone="error" message={kase.failReason} />
            ) : null}
            {fields.length > 0 ? (
              <View style={{ gap: 8 }}>
                {fields.map((f) => (
                  <View key={f.field} style={rowBetween}>
                    <AppText variant="caption" color={colors.mutedForeground}>
                      {fieldLabel(f.field)}
                    </AppText>
                    <AppText
                      variant="label"
                      numberOfLines={2}
                      style={styles.fieldValue}
                    >
                      {f.value ?? "—"}
                    </AppText>
                  </View>
                ))}
              </View>
            ) : !failed ? (
              <AppText variant="caption" color={colors.mutedForeground}>
                {kase.status === "pending"
                  ? "Clerk is still reading this — extracted fields appear here shortly."
                  : "Nothing was extracted from this submission."}
              </AppText>
            ) : null}
          </>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
  caseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  fieldValue: {
    flexShrink: 1,
    marginLeft: 12,
    textAlign: "right",
  },
});
