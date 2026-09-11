import { Feather } from "@expo/vector-icons";
import type { SubmissionAttempt } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Card, CardSkeleton, Divider } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { humanize, timeAgo } from "@/lib/format";
import {
  ATTEMPT_ICON,
  attemptFailed,
  attemptIconColor,
} from "@/lib/invoice-detail";

import { styles } from "./styles";

/** Every transmission attempt, newest first, with its rail and outcome. */
export function TransmissionHistory({
  attempts,
  loading,
}: {
  attempts: SubmissionAttempt[];
  loading: boolean;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="heading">Submission history</AppText>
      {loading ? (
        <CardSkeleton lines={2} />
      ) : attempts.length === 0 ? (
        <Card>
          <AppText variant="body" color={colors.mutedForeground}>
            No submission attempts yet. Submit the invoice to send it to your
            configured submission service.
          </AppText>
        </Card>
      ) : (
        <Card padded={false}>
          {attempts.map((a, i) => (
            <AttemptRow key={a.id} attempt={a} index={i} />
          ))}
        </Card>
      )}
    </View>
  );
}

function AttemptRow({
  attempt: a,
  index: i,
}: {
  attempt: SubmissionAttempt;
  index: number;
}) {
  const colors = useColors();
  const meta = ATTEMPT_ICON[a.status] ?? ATTEMPT_ICON.pending;
  const iconColor = attemptIconColor(meta, colors);
  return (
    <View>
      {i > 0 ? <Divider /> : null}
      <View style={styles.attemptRow}>
        <Feather name={meta.icon} size={18} color={iconColor} />
        <View style={{ flex: 1 }}>
          <AppText variant="label">
            Attempt {a.attemptNo} · {humanize(a.status)}
          </AppText>
          <AppText variant="caption" color={colors.mutedForeground}>
            {humanize(a.rail)} · {timeAgo(a.createdAt)}
          </AppText>
          {attemptFailed(a) && a.errorCode ? (
            <AppText
              variant="caption"
              color={colors.destructiveText}
              style={{ marginTop: 2 }}
            >
              Error code: {a.errorCode}
            </AppText>
          ) : null}
        </View>
      </View>
    </View>
  );
}
