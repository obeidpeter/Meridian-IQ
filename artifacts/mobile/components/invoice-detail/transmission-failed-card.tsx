import { Feather } from "@expo/vector-icons";
import type { ErrorCatalogueEntry } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppButton, AppText, Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

import { styles } from "./styles";

/**
 * The failed-transmission card: the catalogue's cause and fix when the code
 * is known, the reference code, and the retry/fix pair — ordered by whether
 * a plain retry can succeed.
 */
export function TransmissionFailedCard({
  catalogue,
  errorCode,
  retriableKnown,
  busy,
  onRetry,
  onFix,
}: {
  catalogue: ErrorCatalogueEntry | undefined;
  errorCode: string | undefined;
  /** False only when the catalogue says this code is not retriable. */
  retriableKnown: boolean;
  busy: boolean;
  onRetry: () => void;
  onFix: () => void;
}) {
  const colors = useColors();
  return (
    <Card
      style={{
        borderColor: colors.destructiveText,
        borderWidth: 1,
      }}
    >
      <View style={styles.bannerRow}>
        <Feather
          name="alert-triangle"
          size={18}
          color={colors.destructiveText}
        />
        <AppText variant="heading" color={colors.destructiveText}>
          Submission failed
        </AppText>
      </View>
      {catalogue ? (
        <View style={{ marginTop: 12, gap: 10 }}>
          <View>
            <AppText variant="label">What went wrong</AppText>
            <AppText
              variant="body"
              color={colors.mutedForeground}
              style={{ marginTop: 2 }}
            >
              {catalogue.cause}
            </AppText>
          </View>
          <View>
            <AppText variant="label">How to fix it</AppText>
            <AppText
              variant="body"
              color={colors.mutedForeground}
              style={{ marginTop: 2 }}
            >
              {catalogue.fix}
            </AppText>
          </View>
        </View>
      ) : (
        <AppText
          variant="body"
          color={colors.mutedForeground}
          style={{ marginTop: 10 }}
        >
          The submission service could not process this invoice
          {errorCode ? ` (code ${errorCode})` : ""}. Review the invoice details
          before trying again.
        </AppText>
      )}
      {errorCode ? (
        <AppText
          variant="caption"
          color={colors.mutedForeground}
          style={{ marginTop: 10 }}
        >
          Reference code: {errorCode}
          {catalogue
            ? catalogue.retriable
              ? " · can be tried again"
              : " · correct the invoice first"
            : ""}
        </AppText>
      ) : null}
      <View style={{ marginTop: 14, gap: 10 }}>
        {/* Non-retriable errors need the data fixed first, so the
            fix flow leads and a blind retry is demoted. */}
        {retriableKnown ? (
          <>
            <AppButton
              label={busy ? "Submitting…" : "Try again"}
              icon="refresh-cw"
              onPress={onRetry}
              loading={busy}
              disabled={busy}
              testID="button-retry-transmission"
            />
            <AppButton
              label="Fix invoice details"
              icon="edit-3"
              variant="secondary"
              onPress={onFix}
              disabled={busy}
              testID="button-fix-invoice"
            />
          </>
        ) : (
          <>
            <AppButton
              label="Fix invoice details"
              icon="edit-3"
              onPress={onFix}
              disabled={busy}
              testID="button-fix-invoice"
            />
            <AppButton
              label={busy ? "Submitting…" : "Try again anyway"}
              icon="refresh-cw"
              variant="secondary"
              onPress={onRetry}
              loading={busy}
              disabled={busy}
              testID="button-retry-transmission"
            />
            <AppText
              variant="caption"
              color={colors.mutedForeground}
              style={{ textAlign: "center" }}
            >
              Correct the invoice first. Submitting it again without changes
              will fail.
            </AppText>
          </>
        )}
      </View>
    </Card>
  );
}
