import React from "react";
import { View } from "react-native";

import { AppButton, AppText, Badge, Card, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { VoiceDraftState } from "@/hooks/useVoiceDraft";

/** The "Speak it" card — only for users who may capture with Clerk. */
export function VoiceDraftCard({
  voice,
  busy,
  verified,
}: {
  voice: VoiceDraftState;
  /** The form is submitting or not yet hydrated. */
  busy: boolean;
  verified: boolean;
}) {
  const colors = useColors();
  if (!voice.canSpeak) return null;
  return (
    <Card style={{ gap: 8 }}>
      <View style={rowBetween}>
        <AppText variant="label">Speak it</AppText>
        {voice.recording ? <Badge label="Recording…" tone="warning" /> : null}
      </View>
      <AppText variant="caption" color={colors.mutedForeground}>
        Say the invoice — buyer, amount, what it&apos;s for — and Clerk prefills
        this form. Nothing is saved until you submit.
      </AppText>
      <AppButton
        label={
          voice.busy
            ? "Drafting…"
            : voice.recording
              ? "Stop & draft"
              : "Record a voice note"
        }
        variant="ghost"
        icon={voice.recording ? "square" : "mic"}
        onPress={voice.recording ? voice.stopAndDraft : voice.startRecording}
        loading={voice.busy}
        disabled={voice.busy || busy || !verified}
      />
    </Card>
  );
}
