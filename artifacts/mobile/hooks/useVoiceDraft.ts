import { useDraftInvoiceWithClerk } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { useRef, useState } from "react";

import type { BuyerPickerState } from "@/hooks/useBuyerPicker";
import type { InvoiceDraftState } from "@/hooks/useInvoiceDraft";
import { hasStatus, serverMessage } from "@/lib/api-error";
import { applyDraftProposal } from "@/lib/draft-voice";
import { nextVoiceKeyPrefix } from "@/lib/invoice-create";

/**
 * "Speak it" (idea #7): record a short voice note, let the server
 * transcribe it and propose a draft, then prefill THIS form — the user
 * reviews and saves through the ordinary create path; nothing exists until
 * they do. Gated on the same capability as every Clerk capture surface.
 */
export function useVoiceDraft({
  me,
  buyerPicker,
  draft,
  scrollToTop,
}: {
  me: Me | null;
  buyerPicker: BuyerPickerState;
  draft: InvoiceDraftState;
  scrollToTop: () => void;
}) {
  const {
    setBanner,
    setInvoiceNumber,
    setIssueDate,
    setBuyerPartyId,
    setLines,
  } = draft;
  const canSpeak = !!me?.capabilities?.includes("clerk.capture");
  const voiceDraft = useDraftInvoiceWithClerk();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [voiceApplying, setVoiceApplying] = useState(false);
  // Synchronous re-entrancy guard, same hazard the shell's submittingRef
  // covers: a double-tap can fire before React commits the disabled prop,
  // and two stop-and-draft runs would mean two paid transcriptions.
  const voiceBusyRef = useRef(false);

  const startRecording = async () => {
    if (voiceBusyRef.current) return;
    voiceBusyRef.current = true;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setBanner({
          tone: "error",
          message: "Microphone access is needed to speak an invoice.",
        });
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      recorder.record();
      setRecording(true);
    } catch {
      // Recording never started: put the audio session back and say so —
      // a swallowed rejection here would strand the device in record mode.
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setBanner({
        tone: "error",
        message: "Recording couldn't start — try again.",
      });
    } finally {
      voiceBusyRef.current = false;
    }
  };

  const stopAndDraft = async () => {
    if (voiceBusyRef.current || voiceDraft.isPending || voiceApplying) return;
    voiceBusyRef.current = true;
    let audioBase64: string;
    try {
      setRecording(false);
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        setBanner({
          tone: "error",
          message: "Nothing was recorded — try again.",
        });
        return;
      }
      audioBase64 = await new File(uri).base64();
    } catch {
      setBanner({
        tone: "error",
        message: "The voice note couldn't be read — try recording again.",
      });
      return;
    } finally {
      // Whatever happened above, never leave the device audio session in
      // recording mode.
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      voiceBusyRef.current = false;
    }
    if (!buyerPicker.isCurrent()) return;
    voiceDraft.mutate(
      { data: { audioBase64 } },
      {
        onSuccess: async (res) => {
          if (!buyerPicker.isCurrent()) return;
          setVoiceApplying(true);
          try {
            const authorizedIds: string[] = [];
            const suggestedId = res.buyerSuggestions[0]?.partyId;
            if (suggestedId) {
              try {
                const buyer = await buyerPicker.resolveBuyer(suggestedId);
                authorizedIds.push(buyer.id);
              } catch {
                // A suggestion is not authorization, including one outside
                // the current search page. Never fall back to cached IDs.
              }
            }
            if (!buyerPicker.isCurrent()) return;
            const applied = applyDraftProposal(
              res,
              authorizedIds,
              nextVoiceKeyPrefix(),
            );
            if (applied.invoiceNumber) setInvoiceNumber(applied.invoiceNumber);
            if (applied.issueDate) setIssueDate(applied.issueDate);
            if (applied.buyerPartyId) setBuyerPartyId(applied.buyerPartyId);
            if (applied.lines) setLines(applied.lines);
            const heard = res.transcript ? `Heard: “${res.transcript}”. ` : "";
            setBanner({
              tone: "success",
              message:
                !applied.buyerPartyId && (suggestedId || applied.buyerNameRead)
                  ? `${heard}The suggested buyer could not be verified. Choose an available buyer, then check every field before saving.`
                  : `${heard}Check every field before saving.`,
            });
            scrollToTop();
          } finally {
            setVoiceApplying(false);
          }
        },
        onError: (e) => {
          if (!buyerPicker.isCurrent()) return;
          setBanner({
            tone: "error",
            message: hasStatus(e, 503)
              ? "Clerk is switched off right now — fill the form manually."
              : hasStatus(e, 429)
                ? "Your firm's monthly Clerk allowance is used up."
                : (serverMessage(e) ??
                  "Clerk couldn't draft from that voice note. Try again, or type the details."),
          });
          scrollToTop();
        },
      },
    );
  };

  return {
    canSpeak,
    recording,
    applying: voiceApplying,
    isPending: voiceDraft.isPending,
    busy: voiceDraft.isPending || voiceApplying,
    startRecording,
    stopAndDraft,
  };
}

export type VoiceDraftState = ReturnType<typeof useVoiceDraft>;
