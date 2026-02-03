import { computed, onBeforeUnmount, ref } from "vue";

import type { TranscriptionResponse, VoiceStatusKind } from "./types";

export function useVoiceInput(options: {
  apiToken?: () => string | undefined;
  insertIntoPrompt: (text: string) => Promise<void>;
}) {
  const voiceEnabled = ref(true);
  const recording = ref(false);
  const transcribing = ref(false);
  const voiceStatusKind = ref<VoiceStatusKind>("idle");
  const voiceStatusMessage = ref("");
  const recordingSeconds = ref(0);
  let voiceToastTimer: ReturnType<typeof setTimeout> | null = null;

  const MAX_RECORDING_MS = 60_000;
  const CLIENT_TRANSCRIBE_TIMEOUT_MS = 65_000;

  let disposed = false;
  let voiceSessionId = 0;
  let recorder: MediaRecorder | null = null;
  let recorderStream: MediaStream | null = null;
  let recorderMime = "";
  let recorderChunks: Blob[] = [];
  let recorderStopAction: "transcribe" | "cancel" = "transcribe";

  let recordStartedAt = 0;
  let recordTimer: ReturnType<typeof setInterval> | null = null;

  const lastAudioBlob = ref<Blob | null>(null);
  const lastTranscriptionFailed = ref(false);
  let transcribeAbort: AbortController | null = null;
  let transcribeAbortReason: "user" | "timeout" | "other" = "other";
  let transcribeTimeout: ReturnType<typeof setTimeout> | null = null;

  const voiceOverlayExpanded = computed(() => {
    return Boolean(recording.value || transcribing.value || (lastAudioBlob.value && lastTranscriptionFailed.value));
  });

  const recordingTimeText = computed(() => {
    const total = Math.max(0, Math.floor(recordingSeconds.value));
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  });

  function getApiToken(): string {
    const raw = options.apiToken?.();
    return String(raw ?? "").trim();
  }

  function clearVoiceToast(): void {
    if (!voiceToastTimer) return;
    clearTimeout(voiceToastTimer);
    voiceToastTimer = null;
  }

  function setVoiceStatus(kind: VoiceStatusKind, message: string, autoClearMs?: number): void {
    if (disposed) return;
    clearVoiceToast();
    voiceStatusKind.value = kind;
    voiceStatusMessage.value = message;
    if (kind === "idle" || !message) {
      voiceStatusKind.value = "idle";
      voiceStatusMessage.value = "";
      return;
    }
    if (autoClearMs && autoClearMs > 0) {
      voiceToastTimer = setTimeout(() => {
        if (voiceStatusKind.value === kind && voiceStatusMessage.value === message) {
          voiceStatusKind.value = "idle";
          voiceStatusMessage.value = "";
        }
        voiceToastTimer = null;
      }, autoClearMs);
    }
  }

  function stopRecordingTimer(): void {
    if (!recordTimer) return;
    clearInterval(recordTimer);
    recordTimer = null;
  }

  function cleanupRecorder(): void {
    stopRecordingTimer();
    if (recorderStream) {
      for (const track of recorderStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    recorderStream = null;
    recorder = null;
    recorderChunks = [];
    recorderMime = "";
  }

  function clearTranscribeTimeout(): void {
    if (!transcribeTimeout) return;
    clearTimeout(transcribeTimeout);
    transcribeTimeout = null;
  }

  function abortTranscription(reason: "user" | "timeout" | "other"): void {
    transcribeAbortReason = reason;
    const controller = transcribeAbort;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }

  function pickRecorderMime(): string {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
    for (const mime of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) {
          return mime;
        }
      } catch {
        // ignore
      }
    }
    return "";
  }

  async function transcribeAudio(blob: Blob): Promise<void> {
    const audio = blob.size > 0 ? blob : null;
    if (!audio) {
      transcribing.value = false;
      lastTranscriptionFailed.value = true;
      setVoiceStatus("error", "Empty audio.", 3500);
      return;
    }

    abortTranscription("other");
    clearTranscribeTimeout();
    transcribeAbort = new AbortController();
    transcribeAbortReason = "other";

    const controller = transcribeAbort;
    transcribing.value = true;
    setVoiceStatus("idle", "");

    transcribeTimeout = setTimeout(() => {
      transcribeTimeout = null;
      abortTranscription("timeout");
    }, CLIENT_TRANSCRIBE_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {};
      const token = getApiToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      headers["Content-Type"] = audio.type || "application/octet-stream";

      const res = await fetch("/api/audio/transcriptions", {
        method: "POST",
        headers,
        body: audio,
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as TranscriptionResponse | null;
      if (!res.ok) {
        const msg = String(payload?.error ?? payload?.message ?? `HTTP ${res.status}`).trim();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const text = String(payload?.text ?? "").trim();
      if (!text) {
        lastTranscriptionFailed.value = true;
        setVoiceStatus("error", "No text recognized.", 3500);
        return;
      }
      await options.insertIntoPrompt(text);
      lastTranscriptionFailed.value = false;
      setVoiceStatus("ok", "Voice text inserted.", 1200);
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = transcribeAbortReason === "timeout";
        if (timedOut) {
          lastTranscriptionFailed.value = true;
        } else {
          lastTranscriptionFailed.value = false;
        }
        const msg = timedOut ? "Transcription timed out." : "Transcription cancelled.";
        setVoiceStatus(timedOut ? "error" : "ok", msg, 2500);
        return;
      }

      lastTranscriptionFailed.value = true;
      const raw = error instanceof Error ? error.message : String(error);
      const lowered = raw.trim().toLowerCase();
      const message =
        lowered.includes("fetch failed") || lowered.includes("failed to fetch")
          ? "Transcription request failed (network)."
          : raw || "Transcription failed.";
      setVoiceStatus("error", message, 4500);
    } finally {
      clearTranscribeTimeout();
      transcribeAbort = null;
      transcribing.value = false;
    }
  }

  async function startRecording(): Promise<void> {
    if (!voiceEnabled.value) return;

    const micSupported =
      typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    if (!micSupported) {
      setVoiceStatus("error", "Voice recording is not supported in this browser.", 3500);
      return;
    }
    if (recording.value || transcribing.value) return;

    setVoiceStatus("idle", "");
    lastAudioBlob.value = null;
    lastTranscriptionFailed.value = false;
    voiceSessionId += 1;
    const sessionId = voiceSessionId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      cleanupRecorder();
      recorderStream = stream;
      recorderChunks = [];
      recorderMime = pickRecorderMime();
      recorderStopAction = "transcribe";

      recorder = new MediaRecorder(stream, recorderMime ? { mimeType: recorderMime } : undefined);
      recorder.ondataavailable = (ev) => {
        if (sessionId !== voiceSessionId) return;
        if (ev.data && ev.data.size > 0) {
          recorderChunks.push(ev.data);
        }
      };
      recorder.onerror = () => {
        if (sessionId !== voiceSessionId) return;
        recording.value = false;
        transcribing.value = false;
        cleanupRecorder();
        setVoiceStatus("error", "Recording failed.", 3500);
      };
      recorder.onstop = () => {
        if (sessionId !== voiceSessionId) return;
        stopRecordingTimer();
        const action = recorderStopAction;
        const type = recorderMime || recorder?.mimeType || recorderChunks[0]?.type || "audio/webm";
        const blob = new Blob(recorderChunks, { type });
        cleanupRecorder();

        if (action === "cancel") {
          recording.value = false;
          transcribing.value = false;
          setVoiceStatus("ok", "Recording cancelled.", 1200);
          return;
        }

        lastAudioBlob.value = blob;
        void transcribeAudio(blob);
      };

      recorder.start();
      recording.value = true;
      transcribing.value = false;
      recordingSeconds.value = 0;
      recordStartedAt = Date.now();
      recordTimer = setInterval(() => {
        if (!recording.value) return;
        const elapsed = Date.now() - recordStartedAt;
        recordingSeconds.value = Math.floor(elapsed / 1000);
        if (elapsed >= MAX_RECORDING_MS) {
          stopVoiceRecording("transcribe");
        }
      }, 250);
    } catch (error) {
      recording.value = false;
      transcribing.value = false;
      cleanupRecorder();

      const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
      const name = String(record?.name ?? "");
      const msg = error instanceof Error ? error.message : String(error);
      const message =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Microphone permission was denied."
          : name === "NotFoundError"
            ? "No microphone device found."
            : msg
              ? `Unable to access microphone: ${msg}`
              : "Unable to access microphone.";
      setVoiceStatus("error", message, 4500);
    }
  }

  function stopVoiceRecording(action: "transcribe" | "cancel"): void {
    if (!recording.value) return;
    recording.value = false;
    stopRecordingTimer();
    recorderStopAction = action;
    if (action === "transcribe") {
      transcribing.value = true;
      setVoiceStatus("idle", "");
    }
    try {
      recorder?.stop();
    } catch {
      cleanupRecorder();
      transcribing.value = false;
      setVoiceStatus("error", "Failed to stop recording.", 3500);
    }
  }

  function cancelVoiceInput(): void {
    if (recording.value) {
      stopVoiceRecording("cancel");
      return;
    }
    if (transcribing.value) {
      abortTranscription("user");
    }
  }

  async function toggleVoiceInput(): Promise<void> {
    if (!voiceEnabled.value) return;
    if (recording.value) {
      stopVoiceRecording("transcribe");
      return;
    }
    await startRecording();
  }

  async function retryTranscription(): Promise<void> {
    const blob = lastAudioBlob.value;
    if (!blob || transcribing.value || recording.value) return;
    await transcribeAudio(blob);
  }

  onBeforeUnmount(() => {
    disposed = true;
    clearVoiceToast();
    abortTranscription("user");
    clearTranscribeTimeout();
    voiceSessionId += 1;
    try {
      recorderStopAction = "cancel";
      recorder?.stop();
    } catch {
      // ignore
    }
    cleanupRecorder();
  });

  return {
    voiceEnabled,
    recording,
    transcribing,
    voiceStatusKind,
    voiceStatusMessage,
    recordingTimeText,
    voiceOverlayExpanded,
    lastAudioBlob,
    lastTranscriptionFailed,
    cancelVoiceInput,
    toggleVoiceInput,
    retryTranscription,
  };
}

