import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

// The server caps voice uploads at 5 MB; reject oversized files before
// wasting time base64-encoding them.
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

// In-browser recordings auto-stop at 120 s — comfortably covers the
// ~90-second voice-note demo and keeps the blob far under the 5 MB cap.
export const MAX_RECORD_SECONDS = 120;

// In-browser voice recording (MediaRecorder). The recorded blob becomes a
// File the parent feeds through the SAME captureVoice path as an attached
// audio file, so submit, duplicate guard and post-success reset all behave
// identically. Refs hold the live recorder and timer so unmount cleanup can
// reach them.
export function useVoiceRecorder({
  onRecorded,
  onCleared,
}: {
  /** A finished recording is ready — the parent stores it as the voice file. */
  onRecorded: (file: File) => void;
  /** Recording started — the parent clears state a new source makes stale. */
  onCleared: () => void;
}) {
  const { toast } = useToast();
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hide the button entirely where the APIs are missing (old browsers,
  // insecure origins) — a button that can only fail is worse than none.
  const recordingSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    "MediaRecorder" in window;

  const stopRecording = () => {
    // onstop assembles the blob, stops the mic tracks and clears the timer.
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startRecording = async () => {
    if (isRecording || recorderRef.current) return;
    onCleared();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast({
        title: "Microphone unavailable",
        description:
          "Microphone access was denied or no microphone was found — allow access in the browser, or attach an audio file instead.",
        variant: "destructive",
      });
      return;
    }
    // Default mimeType (typically audio/webm) — the backend transcriber
    // handles webm natively.
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      recorderRef.current = null;
      setIsRecording(false);
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      if (blob.size === 0) return;
      if (blob.size > MAX_VOICE_BYTES) {
        toast({
          title: "Recording too large",
          description:
            "Voice notes are capped at 5 MB — record a shorter note.",
          variant: "destructive",
        });
        return;
      }
      onRecorded(new File([blob], "recording.webm", { type: blob.type }));
    };
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
    recorder.start();
    const startedAt = Date.now();
    recordTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setRecordSeconds(elapsed);
      // Hard cap — matches the ~90-second voice-note demo with headroom.
      if (
        elapsed >= MAX_RECORD_SECONDS &&
        recorderRef.current?.state === "recording"
      ) {
        recorderRef.current.stop();
      }
    }, 1000);
  };

  // Never leave the mic held after unmount (no dangling recording indicator).
  useEffect(() => {
    return () => {
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
      }
      const rec = recorderRef.current;
      if (rec) {
        rec.stream.getTracks().forEach((t) => t.stop());
        if (rec.state !== "inactive") rec.stop();
        recorderRef.current = null;
      }
    };
  }, []);

  return {
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
  };
}
