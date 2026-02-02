<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import type { CreateTaskInput, ModelConfig } from "../api/types";

type UploadedImageAttachment = {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
};

type LocalAttachment = {
  localId: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
  uploaded?: UploadedImageAttachment;
  xhr?: XMLHttpRequest;
};

const props = defineProps<{ models: ModelConfig[]; apiToken?: string; workspaceRoot?: string }>();
const emit = defineEmits<{
  (e: "submit", v: CreateTaskInput): void;
  (e: "submit-and-run", v: CreateTaskInput): void;
  (e: "reset-thread"): void;
  (e: "cancel"): void;
}>();

const title = ref("");
const prompt = ref("");
const promptEl = ref<HTMLTextAreaElement | null>(null);
const model = ref("auto");
const priority = ref(0);
const maxRetries = ref(3);

type VoiceStatusKind = "idle" | "recording" | "transcribing" | "error" | "ok";
type TranscriptionResponse = { ok?: boolean; text?: string; error?: string; message?: string };

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

const attachments = ref<LocalAttachment[]>([]);
const attachmentError = ref<string | null>(null);

const uploadingCount = computed(() => attachments.value.filter((a) => a.status === "uploading").length);
const failedCount = computed(() => attachments.value.filter((a) => a.status === "error").length);

const canSubmit = computed(() => {
  if (prompt.value.trim().length === 0) return false;
  if (recording.value || transcribing.value) return false;
  if (uploadingCount.value > 0) return false;
  if (failedCount.value > 0) return false;
  return true;
});

const voiceOverlayExpanded = computed(() => {
  return Boolean(recording.value || transcribing.value || (lastAudioBlob.value && lastTranscriptionFailed.value));
});

const recordingTimeText = computed(() => {
  const total = Math.max(0, Math.floor(recordingSeconds.value));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
});

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

async function insertIntoPrompt(text: string): Promise<void> {
  if (disposed) return;
  const normalized = String(text ?? "").trim();
  if (!normalized) return;

  const el = promptEl.value;
  if (!el) {
    const prefix = prompt.value.trim() ? `${prompt.value}\n` : prompt.value;
    prompt.value = `${prefix}${normalized}`;
    return;
  }

  const current = prompt.value;
  const start = typeof el.selectionStart === "number" ? el.selectionStart : current.length;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const needsSpacer = before && !/[\s\n]$/.test(before);
  const insert = `${needsSpacer ? "\n" : ""}${normalized}`;
  prompt.value = before + insert + after;
  await nextTick();
  try {
    const pos = before.length + insert.length;
    el.focus();
    el.setSelectionRange(pos, pos);
  } catch {
    // ignore
  }
}

async function insertPromptNewline(): Promise<void> {
  if (disposed) return;
  const el = promptEl.value;
  const current = prompt.value;
  if (!el) {
    prompt.value = `${current}\n`;
    return;
  }

  const start = typeof el.selectionStart === "number" ? el.selectionStart : current.length;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  prompt.value = `${before}\n${after}`;
  await nextTick();
  try {
    const pos = before.length + 1;
    el.focus();
    el.setSelectionRange(pos, pos);
  } catch {
    // ignore
  }
}

function onPromptKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Enter") return;
  if ((ev as { isComposing?: boolean }).isComposing) return;
  if (!ev.altKey) return;
  ev.preventDefault();
  void insertPromptNewline();
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
    const token = String(props.apiToken ?? "").trim();
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
    await insertIntoPrompt(text);
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

function withWorkspaceQuery(apiPath: string): string {
  const root = String(props.workspaceRoot ?? "").trim();
  if (!root) return apiPath;
  const joiner = apiPath.includes("?") ? "&" : "?";
  return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
}

function withTokenQuery(url: string): string {
  const token = String(props.apiToken ?? "").trim();
  if (!token) return url;
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}token=${encodeURIComponent(token)}`;
}

function safeRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function updateAttachment(localId: string, patch: Partial<LocalAttachment>): void {
  attachments.value = attachments.value.map((a) => (a.localId === localId ? { ...a, ...patch } : a));
}

function removeAttachment(localId: string): void {
  const a = attachments.value.find((x) => x.localId === localId);
  if (!a) return;
  try {
    a.xhr?.abort();
  } catch {
    // ignore
  }
  try {
    URL.revokeObjectURL(a.previewUrl);
  } catch {
    // ignore
  }
  attachments.value = attachments.value.filter((x) => x.localId !== localId);
}

function guessFileName(file: File): string {
  const name = String(file.name ?? "").trim();
  if (name) return name;
  const t = String(file.type ?? "").toLowerCase();
  if (t === "image/png") return "pasted.png";
  if (t === "image/webp") return "pasted.webp";
  if (t === "image/jpeg" || t === "image/jpg") return "pasted.jpg";
  return "pasted.bin";
}

function uploadImageAttachment(local: LocalAttachment): Promise<UploadedImageAttachment> {
  const url = withWorkspaceQuery("/api/attachments/images");
  const token = String(props.apiToken ?? "").trim();
  const form = new FormData();
  form.append("file", local.file, guessFileName(local.file));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.responseType = "text";

    xhr.upload.onprogress = (ev: ProgressEvent<EventTarget>) => {
      if (!ev.lengthComputable) return;
      const ratio = ev.total > 0 ? Math.max(0, Math.min(1, ev.loaded / ev.total)) : 0;
      updateAttachment(local.localId, { progress: ratio });
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.onload = () => {
      const status = xhr.status;
      const text = String(xhr.responseText ?? "");
      const parseErrorMessage = (): string => {
        try {
          const obj = JSON.parse(text) as { error?: unknown };
          const msg = String(obj?.error ?? "").trim();
          return msg || `HTTP ${status}`;
        } catch {
          return text.trim() || `HTTP ${status}`;
        }
      };
      if (status >= 200 && status < 300) {
        try {
          const parsed = JSON.parse(text) as UploadedImageAttachment;
          resolve(parsed);
        } catch {
          reject(new Error("Invalid JSON response"));
        }
        return;
      }
      reject(new Error(parseErrorMessage()));
    };

    updateAttachment(local.localId, { xhr });
    xhr.send(form);
  });
}

async function addAttachmentFromFile(file: File): Promise<void> {
  attachmentError.value = null;
  const maxBytes = 5 * 1024 * 1024;
  if (!file || file.size <= 0) return;
  if (file.size > maxBytes) {
    attachmentError.value = "图片过大（>5MB）";
    return;
  }
  const mime = String(file.type ?? "").toLowerCase();
  if (mime && !mime.startsWith("image/")) {
    return;
  }

  const localId = safeRandomId();
  const previewUrl = URL.createObjectURL(file);
  const local: LocalAttachment = {
    localId,
    file,
    previewUrl,
    status: "uploading",
    progress: 0,
  };
  attachments.value = [...attachments.value, local];

  try {
    const uploaded = await uploadImageAttachment(local);
    updateAttachment(localId, { status: "ready", progress: 1, uploaded, xhr: undefined });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateAttachment(localId, { status: "error", error: msg, xhr: undefined });
  }
}

async function retryUpload(localId: string): Promise<void> {
  const a = attachments.value.find((x) => x.localId === localId);
  if (!a) return;
  updateAttachment(localId, { status: "uploading", progress: 0, error: undefined, uploaded: undefined });
  try {
    const uploaded = await uploadImageAttachment(a);
    updateAttachment(localId, { status: "ready", progress: 1, uploaded, xhr: undefined });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateAttachment(localId, { status: "error", error: msg, xhr: undefined });
  }
}

async function onPromptPaste(ev: ClipboardEvent): Promise<void> {
  attachmentError.value = null;
  const data = ev.clipboardData;
  if (!data) return;

  const isImageFile = (file: File): boolean => {
    const mime = String(file.type ?? "").toLowerCase();
    if (mime.startsWith("image/")) return true;
    const name = String(file.name ?? "").toLowerCase();
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
  };

  const sha256Hex = async (blob: Blob): Promise<string> => {
    const subtle = (globalThis.crypto as undefined | { subtle?: SubtleCrypto })?.subtle;
    if (!subtle?.digest) return "";
    const buf = await blob.arrayBuffer();
    const digest = await subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const items = data.items ? Array.from(data.items) : [];
  const filesFromItems = items
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter(Boolean) as File[];
  const filesFromList = data.files ? Array.from(data.files) : [];
  const files = [...filesFromItems, ...filesFromList].filter((f) => f && f.size > 0 && isImageFile(f));
  if (files.length === 0) {
    return; // Let the browser handle normal text paste.
  }

  ev.preventDefault();

  const imageFiles = await (async () => {
    const byHash = new Map<string, File>();
    const byFallback = new Map<string, File>();

    for (const file of files) {
      const hash = await sha256Hex(file).catch(() => "");
      if (hash) {
        if (!byHash.has(hash)) byHash.set(hash, file);
        continue;
      }

      const name = String(file.name ?? "");
      const type = String(file.type ?? "");
      const key = `${name}|${type}|${file.size}`;
      if (!byFallback.has(key)) byFallback.set(key, file);
    }

    return [...Array.from(byHash.values()), ...Array.from(byFallback.values())];
  })();
  for (const f of imageFiles) {
    await addAttachmentFromFile(f);
  }
}

function submit(): void {
  emitSubmit("submit");
}

function submitAndRun(): void {
  emitSubmit("submit-and-run");
}

function emitSubmit(event: "submit" | "submit-and-run"): void {
  if (!canSubmit.value) return;
  const titleTrimmed = title.value.trim();
  const uploadedIds = attachments.value
    .filter((a) => a.status === "ready" && a.uploaded?.id)
    .map((a) => String(a.uploaded!.id))
    .filter(Boolean);
  emit(event, {
    title: titleTrimmed.length ? titleTrimmed : undefined,
    prompt: prompt.value.trim(),
    model: model.value,
    priority: Number.isFinite(priority.value) ? priority.value : 0,
    maxRetries: Number.isFinite(maxRetries.value) ? maxRetries.value : 3,
    attachments: uploadedIds.length ? uploadedIds : undefined,
  });

  title.value = "";
  prompt.value = "";
  for (const a of attachments.value) {
    try {
      a.xhr?.abort();
    } catch {
      // ignore
    }
    try {
      URL.revokeObjectURL(a.previewUrl);
    } catch {
      // ignore
    }
  }
  attachments.value = [];
}

function resetThread(): void {
  emit("reset-thread");
}

const modelOptions = computed(() => {
  const enabled = props.models.filter((m) => m.isEnabled);
  return [{ id: "auto", displayName: "Auto", provider: "" }, ...enabled];
});

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
  for (const a of attachments.value) {
    try {
      a.xhr?.abort();
    } catch {
      // ignore
    }
    try {
      URL.revokeObjectURL(a.previewUrl);
    } catch {
      // ignore
    }
  }
});
</script>

<template>
  <div class="card">
    <h3 class="form-title" data-drag-handle>新建任务</h3>

    <div class="fields">
      <div class="form-row">
        <label class="form-field">
          <span class="label-text">标题（可选）</span>
          <input v-model="title" placeholder="不填会自动生成" />
        </label>
      </div>

      <div class="form-row form-row-3">
        <label class="form-field">
          <span class="label-text">模型</span>
          <select v-model="model">
            <option v-for="m in modelOptions" :key="m.id" :value="m.id">
              {{ m.displayName }}{{ m.provider ? ` (${m.provider})` : "" }}
            </option>
          </select>
        </label>
        <label class="form-field">
          <span class="label-text">优先级</span>
          <input v-model.number="priority" type="number" />
        </label>
        <label class="form-field">
          <span class="label-text">最大重试</span>
          <input v-model.number="maxRetries" type="number" min="0" />
        </label>
      </div>

      <div class="form-row prompt-row">
        <label class="form-field">
          <span class="label-text">任务描述</span>
          <div
            class="promptInputWrap"
            :class="{
              voiceEnabled,
              voiceExpanded: voiceOverlayExpanded,
              voiceBottomCentered: voiceEnabled && !prompt.trim(),
            }"
          >
            <textarea
              v-model="prompt"
              ref="promptEl"
              rows="10"
              placeholder="描述任务内容..."
              :disabled="recording || transcribing"
              @keydown="onPromptKeydown"
              @paste="onPromptPaste"
            />
            <div v-if="voiceEnabled" class="voiceAffordance">
              <div v-if="recording || transcribing || (lastAudioBlob && lastTranscriptionFailed)" class="voiceRow">
                <div v-if="recording" class="voiceIndicator recording" aria-hidden="true">
                  <div class="voiceBars">
                    <span class="bar" />
                    <span class="bar" />
                    <span class="bar" />
                  </div>
                  <span class="voiceTime">{{ recordingTimeText }}</span>
                </div>
                <div v-else-if="transcribing" class="voiceIndicator transcribing" aria-hidden="true">
                  <span class="voiceSpinner" />
                </div>
                <button
                  v-if="lastAudioBlob && lastTranscriptionFailed && !recording && !transcribing"
                  class="voiceAuxBtn voiceRetryBtn"
                  type="button"
                  title="Retry transcription"
                  aria-label="Retry transcription"
                  @click="retryTranscription"
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M10 4a6 6 0 1 0 5.61 8.13.75.75 0 0 1 1.4.52A7.5 7.5 0 1 1 10 2.5c1.6 0 3.08.5 4.29 1.36V2.75a.75.75 0 0 1 1.5 0V6.5a.75.75 0 0 1-.75.75H11.25a.75.75 0 0 1 0-1.5h2.06A5.98 5.98 0 0 0 10 4Z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </div>

              <div class="voiceRow">
                <button
                  v-if="recording || transcribing"
                  class="voiceAuxBtn voiceCancelBtn"
                  type="button"
                  title="Cancel voice input"
                  aria-label="Cancel voice input"
                  @click="cancelVoiceInput"
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
                <button
                  class="micIcon"
                  :class="{ recording, transcribing }"
                  type="button"
                  :disabled="transcribing"
                  :title="recording ? 'Stop recording' : 'Start voice input'"
                  aria-label="Voice input"
                  @click="toggleVoiceInput"
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M10 13.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4.5a3 3 0 0 0 3 3Z" />
                    <path
                      d="M5.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 1 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V18a.75.75 0 0 1-1.5 0v-1.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75Z"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <div
              v-if="(voiceStatusKind === 'ok' || voiceStatusKind === 'error') && voiceStatusMessage"
              class="voiceToast"
              :class="voiceStatusKind"
              role="status"
              aria-live="polite"
            >
              <span class="voiceToastText">{{ voiceStatusMessage }}</span>
            </div>
          </div>
        </label>
      </div>

      <div v-if="attachmentError" class="errorBox">附件：{{ attachmentError }}</div>

      <div v-if="attachments.length" class="attachments">
          <div v-for="a in attachments" :key="a.localId" class="thumbCard" :data-status="a.status">
            <div class="thumbWrap">
              <a
                v-if="a.uploaded?.url"
                class="thumbLink"
                :href="withTokenQuery(a.uploaded.url)"
                target="_blank"
                rel="noreferrer"
                @click.stop
              >
                <img class="thumbImg" :src="a.previewUrl" alt="" />
              </a>
              <img v-else class="thumbImg" :src="a.previewUrl" alt="" />

              <div v-if="a.status === 'uploading'" class="overlay">
                <div class="progressRow">
                  <div class="progressBar">
                    <div class="progressFill" :style="{ width: `${Math.round(a.progress * 100)}%` }" />
                  </div>
                  <span class="progressText">{{ Math.round(a.progress * 100) }}%</span>
                </div>
              </div>

              <div v-else-if="a.status === 'error'" class="overlay error">
                <div class="errorText">{{ a.error || "上传失败" }}</div>
                <button class="retryBtn" type="button" @click="retryUpload(a.localId)">重试</button>
              </div>

              <button class="removeBtn" type="button" title="移除" @click="removeAttachment(a.localId)">×</button>
            </div>
          </div>
      </div>
    </div>

    <div class="actions">
      <button class="btnSecondary" type="button" @click="emit('cancel')">取消</button>
      <button class="btnSecondary" type="button" :disabled="!canSubmit" @click="submit">保存</button>
      <button class="btnPrimary" type="button" :disabled="!canSubmit" data-testid="task-create-submit-and-run" @click="submitAndRun">
        保存并提交
      </button>
    </div>
  </div>
</template>

<style src="./TaskCreateForm.css" scoped></style>
