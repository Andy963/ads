<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import MarkdownContent from "./MarkdownContent.vue";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
  streaming?: boolean;
};

type IncomingImage = { name?: string; mime?: string; data: string };
type QueuedPrompt = { id: string; text: string; imagesCount: number };

const props = defineProps<{
  messages: ChatMessage[];
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  connected: boolean;
  busy: boolean;
  apiToken?: string;
}>();

const emit = defineEmits<{
  (e: "send", content: string): void;
  (e: "interrupt"): void;
  (e: "clear"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeQueued", id: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);

const canInterrupt = computed(() => props.busy);
const micSupported = computed(() => {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
});

const copiedMessageId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const recording = ref(false);
const transcribing = ref(false);
const voiceStatusKind = ref<"idle" | "recording" | "transcribing" | "error" | "ok">("idle");
const voiceStatusMessage = ref("");
let voiceToastTimer: ReturnType<typeof setTimeout> | null = null;

let recorder: MediaRecorder | null = null;
let recorderStream: MediaStream | null = null;
let recorderMime = "";
let recorderChunks: Blob[] = [];

type TranscriptionResponse = { ok?: boolean; text?: string; error?: string; message?: string };

function handleScroll() {
  if (!listRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 50;
}

watch(
  () => props.messages.length,
  async () => {
    if (autoScroll.value && listRef.value) {
      await nextTick();
      listRef.value.scrollTop = listRef.value.scrollHeight;
    }
  },
);

function send(): void {
  if (recording.value || transcribing.value) return;
  const text = input.value.trim();
  if (!text && props.pendingImages.length === 0) return;
  emit("send", text);
  input.value = "";
}

function clearVoiceToast(): void {
  if (voiceToastTimer) {
    clearTimeout(voiceToastTimer);
    voiceToastTimer = null;
  }
}

function clearCopiedToast(): void {
  if (copiedTimer) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  copiedMessageId.value = null;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const normalized = String(text ?? "");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized);
      return true;
    } catch {
      // fallback below
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = normalized;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

async function onCopyMessage(message: ChatMessage): Promise<void> {
  const ok = await copyToClipboard(message.content);
  if (!ok) return;
  clearCopiedToast();
  copiedMessageId.value = message.id;
  copiedTimer = setTimeout(() => {
    copiedMessageId.value = null;
    copiedTimer = null;
  }, 1400);
}

function setVoiceStatus(
  kind: "idle" | "recording" | "transcribing" | "error" | "ok",
  message: string,
  autoClearMs?: number,
): void {
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

async function insertIntoComposer(text: string): Promise<void> {
  const normalized = String(text ?? "").trim();
  if (!normalized) return;

  const el = inputEl.value;
  if (!el) {
    const prefix = input.value.trim() ? `${input.value}\n` : input.value;
    input.value = `${prefix}${normalized}`;
    return;
  }

  const current = input.value;
  const start = typeof el.selectionStart === "number" ? el.selectionStart : current.length;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const needsSpacer = before && !/[\s\n]$/.test(before);
  const insert = `${needsSpacer ? "\n" : ""}${normalized}`;
  input.value = before + insert + after;
  await nextTick();
  try {
    const pos = before.length + insert.length;
    el.focus();
    el.setSelectionRange(pos, pos);
  } catch {
    // ignore
  }
}

function cleanupRecorder(): void {
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

function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
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
  transcribing.value = true;
  setVoiceStatus("idle", "");
  try {
    const headers: Record<string, string> = {};
    const token = String(props.apiToken ?? "").trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    headers["Content-Type"] = blob.type || "application/octet-stream";

    const res = await fetch("/api/audio/transcriptions", {
      method: "POST",
      headers,
      body: blob,
    });
    const payload = (await res.json().catch(() => null)) as TranscriptionResponse | null;
    if (!res.ok) {
      const message = String(payload?.error ?? payload?.message ?? `HTTP ${res.status}`).trim();
      throw new Error(message || `HTTP ${res.status}`);
    }

    const text = String(payload?.text ?? "").trim();
    if (!text) {
      setVoiceStatus("error", "未识别到文本", 3500);
      return;
    }
    await insertIntoComposer(text);
    setVoiceStatus("ok", "已追加语音文本", 1200);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const lowered = raw.trim().toLowerCase();
    const message =
      lowered.includes("fetch failed") || lowered.includes("failed to fetch")
        ? "语音识别上游连接失败（检查网络/KEY）"
        : raw;
    setVoiceStatus("error", message || "语音识别失败", 4000);
  } finally {
    transcribing.value = false;
  }
}

async function startRecording(): Promise<void> {
  if (!micSupported.value) {
    setVoiceStatus("error", "当前浏览器不支持录音", 3500);
    return;
  }
  if (props.busy || transcribing.value || recording.value) {
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    cleanupRecorder();
    recorderStream = stream;
    recorderChunks = [];
    recorderMime = pickRecorderMime();
    recorder = new MediaRecorder(stream, recorderMime ? { mimeType: recorderMime } : undefined);

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        recorderChunks.push(ev.data);
      }
    };
    recorder.onerror = () => {
      recording.value = false;
      cleanupRecorder();
      setVoiceStatus("error", "录音失败", 3500);
    };
    recorder.onstop = () => {
      const type = recorderMime || recorder?.mimeType || recorderChunks[0]?.type || "audio/webm";
      const blob = new Blob(recorderChunks, { type });
      cleanupRecorder();
      void transcribeAudio(blob);
    };

    recorder.start();
    recording.value = true;
    setVoiceStatus("idle", "");
  } catch (error) {
    recording.value = false;
    cleanupRecorder();
    const message = error instanceof Error ? error.message : String(error);
    setVoiceStatus("error", `无法访问麦克风：${message}`, 4500);
  }
}

function stopRecording(): void {
  if (!recording.value) return;
  recording.value = false;
  transcribing.value = true;
  setVoiceStatus("idle", "");
  try {
    recorder?.stop();
  } catch {
    cleanupRecorder();
    transcribing.value = false;
    setVoiceStatus("error", "停止录音失败", 3500);
  }
}

async function toggleRecording(): Promise<void> {
  if (recording.value) {
    stopRecording();
    return;
  }
  await startRecording();
}

function onInputKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Enter") return;
  if ((ev as { isComposing?: boolean }).isComposing) return;
  if (ev.altKey) return; // Alt+Enter: newline
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  send();
}

function getCommands(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.match(/^\$\s*/))
    .map((line) => line.replace(/^\$\s*/, ""));
}

async function onPaste(ev: ClipboardEvent): Promise<void> {
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const data = ev.clipboardData;
  const target = ev.target instanceof HTMLTextAreaElement ? ev.target : null;

  const items = data?.items ? Array.from(data.items) : [];
  const fromItems = items
    .filter((i) => i.kind === "file" && ((i.type || "").startsWith("image/") || !i.type))
    .map((i) => i.getAsFile())
    .filter(Boolean) as File[];
  const fromFiles = data?.files
    ? Array.from(data.files).filter((f) => ((f.type || "").startsWith("image/") || !f.type) && f.size > 0)
    : [];
  const files = [...fromItems, ...fromFiles].filter((f) => f.size > 0);
  const uniqueFiles = (() => {
    const rank = (mime: string) => {
      const t = String(mime ?? "").toLowerCase();
      if (t === "image/png") return 100;
      if (t === "image/webp") return 90;
      if (t === "image/jpeg" || t === "image/jpg") return 80;
      if (t === "image/gif") return 70;
      if (t === "image/bmp") return 60;
      if (t === "image/svg+xml") return 50;
      if (t.startsWith("image/")) return 40;
      if (!t) return 10;
      return 0;
    };

    const byKey = new Map<string, File>();
    for (const f of files) {
      const key = `${f.name}|${f.size}`;
      const existing = byKey.get(key);
      if (!existing || rank(f.type) > rank(existing.type)) {
        byKey.set(key, f);
      }
    }
    return Array.from(byKey.values());
  })();

  const html = (data?.getData("text/html") ?? "").trim();
  const plainRaw = data?.getData("text/plain") ?? "";
  const plain = plainRaw.trim();
  const uriList = (data?.getData("text/uri-list") ?? "").trim();

  const imgSrcFromHtml = html ? /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] : undefined;
  const directSrcFromHtml = String(imgSrcFromHtml ?? "").trim();
  const uriFromUriList = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  const isImageUrl = (value: string): boolean => {
    const v = String(value ?? "").trim();
    if (!v) return false;
    if (v.startsWith("data:image/")) return true;
    if (!/^https?:\/\//i.test(v)) return false;
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(v);
  };
  const srcFromText = (() => {
    if (plain.startsWith("data:image/")) return plain;
    const maybeUrl = plain.trim();
    if (!/^https?:\/\//i.test(maybeUrl)) return "";
    if (!/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(maybeUrl)) return "";
    return maybeUrl;
  })();
  const srcFromUriList = uriFromUriList && isImageUrl(uriFromUriList) ? uriFromUriList : "";
  const directSrc = (directSrcFromHtml || srcFromUriList || srcFromText || "").trim();

  const clipboardTypes = data?.types ? Array.from(data.types).map((t) => String(t ?? "")) : [];
  const hasExplicitImageType = clipboardTypes.some((t) => t === "Files" || t.startsWith("image/"));
  const hasFileLikeItem = items.some((i) => i.kind === "file");
  const shouldHandleImages = uniqueFiles.length > 0 || Boolean(directSrc) || hasExplicitImageType || hasFileLikeItem;

  const images: IncomingImage[] = [];
  if (shouldHandleImages) {
    // Vue paste handlers are not awaited by the browser; preventDefault must happen
    // before the first await to reliably stop the native paste.
    ev.preventDefault();

    if (directSrc && uniqueFiles.length === 0) {
      const isFromHtml = directSrcFromHtml.length > 0 && directSrc === directSrcFromHtml;
      if (directSrc.startsWith("data:image/")) {
        images.push({ data: directSrc });
      } else if (/^https?:\/\//i.test(directSrc) && (isFromHtml || isImageUrl(directSrc))) {
        const fetched = await fetch(directSrc)
          .then(async (r) => {
            if (!r.ok) return "";
            const blob = await r.blob();
            const mime = String(blob.type ?? "");
            if (!mime.startsWith("image/")) return "";
            if (blob.size > MAX_IMAGE_BYTES) return "";
            return await blobToDataUrl(blob);
          })
          .catch(() => "");
        if (fetched) images.push({ data: fetched });
      }
    }

    for (const file of uniqueFiles) {
      if (file.size > MAX_IMAGE_BYTES) {
        continue;
      }
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl) continue;
      images.push({ name: file.name, mime: file.type, data: dataUrl });
    }

    if (images.length === 0) {
      const fromNavigator = await readImagesFromNavigatorClipboard(MAX_IMAGE_BYTES);
      images.push(...fromNavigator);
    }

    if (images.length) {
      emit("addImages", images);
      return;
    }

    // We took over the paste event but failed to extract images. Fall back to text paste.
    const fallbackText = plainRaw || uriFromUriList || "";
    const finalText = fallbackText
      ? fallbackText
      : await (async () => {
          try {
            const clipboard = navigator.clipboard as undefined | { readText?: () => Promise<string> };
            return (await clipboard?.readText?.()) ?? "";
          } catch {
            return "";
          }
        })();

    if (!finalText) return;
    const start = target?.selectionStart ?? input.value.length;
    const end = target?.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + finalText + input.value.slice(end);
    await nextTick();
    try {
      const pos = start + finalText.length;
      target?.setSelectionRange(pos, pos);
    } catch {
      // ignore
    }
    return;
  }

  // No images detected: let the browser handle text paste by default.
  // If clipboardData has no text types at all, try navigator.clipboard.readText() as a last resort.
  const hasTextType = clipboardTypes.some((t) => t.startsWith("text/"));
  if (target && !plainRaw && !html && !uriList && !hasTextType) {
    const clipboard = navigator.clipboard as undefined | { readText?: () => Promise<string> };
    if (!clipboard?.readText) return;
    ev.preventDefault();
    const navText = await clipboard.readText().catch(() => "");
    if (!navText) return;
    const start = target.selectionStart ?? input.value.length;
    const end = target.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + navText + input.value.slice(end);
    await nextTick();
    try {
      const pos = start + navText.length;
      target.setSelectionRange(pos, pos);
    } catch {
      // ignore
    }
  }
}

async function readImagesFromNavigatorClipboard(maxBytes: number): Promise<IncomingImage[]> {
  try {
    const clipboard = navigator.clipboard as undefined | { read?: () => Promise<ClipboardItem[]> };
    if (!clipboard?.read) return [];
    const items = await clipboard.read().catch(() => []);
    const out: IncomingImage[] = [];
    for (const item of items) {
      const types = Array.isArray(item.types) ? item.types : [];
      for (const type of types) {
        const t = String(type ?? "");
        if (!t.startsWith("image/")) continue;
        const blob = await item.getType(t).catch(() => null);
        if (!blob) continue;
        if (blob.size <= 0 || blob.size > maxBytes) continue;
        const data = await blobToDataUrl(blob);
        if (!data) continue;
        out.push({ mime: t, data });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(blob);
  }).catch(() => "");
}

async function fileToDataUrl(file: File): Promise<string> {
  const viaReader = await blobToDataUrl(file);
  if (viaReader) return viaReader;
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const mime = (file.type || "image/png").trim();
    return `data:${mime};base64,${base64}`;
  } catch {
    return "";
  }
}

onBeforeUnmount(() => {
  clearVoiceToast();
  clearCopiedToast();
  try {
    recorder?.stop();
  } catch {
    // ignore
  }
  cleanupRecorder();
});
</script>

<template>
  <div class="detail">
    <div class="header">
      <div class="header-left">
        <div class="meta">
          <span v-if="busy" class="meta-item">busy</span>
        </div>
      </div>
    </div>

    <div ref="listRef" class="chat" @scroll="handleScroll">
      <div v-if="messages.length === 0" class="chat-empty">
        <span>直接开始对话…</span>
      </div>
      <div v-for="m in messages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div v-if="m.kind === 'command'" class="command-block">
          <div class="command-tree-header">
            <span class="command-tag">EXECUTE</span>
            <span class="command-count">{{ getCommands(m.content).length }} 条命令</span>
          </div>
          <div class="command-tree">
            <div
              v-for="(cmd, cIdx) in getCommands(m.content)"
              :key="cIdx"
              class="command-tree-item"
            >
              <span class="command-tree-branch">├─</span>
              <span class="command-cmd">{{ cmd }}</span>
            </div>
          </div>
        </div>
        <div v-else class="bubble">
          <div v-if="m.role === 'assistant' && m.kind === 'text' && m.streaming && m.content.length === 0" class="typing" aria-label="AI 正在回复">
            <span class="dot" />
            <span class="dot" />
            <span class="dot" />
          </div>
          <MarkdownContent v-else :content="m.content" />
          <div v-if="!(m.streaming && m.content.length === 0)" class="msgActions">
            <button class="msgCopyBtn" type="button" aria-label="Copy message" @click="onCopyMessage(m)">
              <svg v-if="copiedMessageId === m.id" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="composer">
      <div v-if="queuedPrompts.length" class="queue" aria-label="排队消息">
        <div v-for="q in queuedPrompts" :key="q.id" class="queue-item">
          <div class="queue-text">
            {{ q.text || `[图片 x${q.imagesCount}]` }}
            <span v-if="q.text && q.imagesCount" class="queue-sub"> · 图片 x{{ q.imagesCount }}</span>
          </div>
          <button class="queue-del" type="button" title="移除" @click="emit('removeQueued', q.id)">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="pendingImages.length" class="attachmentsBar" aria-label="已粘贴图片">
        <div class="attachmentsPill">
          <span class="attachmentsText">图片 x{{ pendingImages.length }}</span>
          <button class="attachmentsClear" type="button" title="清空图片" @click="emit('clearImages')">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="inputWrap">
        <textarea
          v-model="input"
          ref="inputEl"
          rows="2"
          class="composer-input"
          placeholder="输入…（Enter 发送，Alt+Enter 换行，粘贴图片）"
          @keydown="onInputKeydown"
          @paste="onPaste"
        />
        <div class="inputActions">
          <div v-if="recording" class="voiceIndicator recording" aria-hidden="true">
            <div class="voiceBars">
              <span class="bar" />
              <span class="bar" />
              <span class="bar" />
            </div>
          </div>
          <div v-else-if="transcribing" class="voiceIndicator transcribing" aria-hidden="true">
            <span class="voiceSpinner" />
          </div>
          <button
            class="micIcon"
            :class="{ recording, transcribing }"
            :disabled="canInterrupt || transcribing"
            type="button"
            :title="recording ? '停止录音' : '语音输入（追加到输入框）'"
            @click="toggleRecording"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 13.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4.5a3 3 0 0 0 3 3Z" />
              <path
                d="M5.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 1 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V18a.75.75 0 0 1-1.5 0v-1.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75Z"
              />
            </svg>
          </button>
          <button
            v-if="canInterrupt"
            class="stopIcon"
            type="button"
            title="中断"
            @click="emit('interrupt')"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M6 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm0 2h8v8H6V6Z" clip-rule="evenodd" />
            </svg>
          </button>
          <button
            v-else
            class="sendIcon"
            :disabled="(!input.trim() && pendingImages.length === 0) || recording || transcribing"
            type="button"
            title="发送"
            @click="send"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M10 3a.75.75 0 0 1 .53.22l4.5 4.5a.75.75 0 1 1-1.06 1.06l-3.22-3.22V16a.75.75 0 0 1-1.5 0V5.56L6.03 8.78A.75.75 0 1 1 4.97 7.72l4.5-4.5A.75.75 0 0 1 10 3Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
        <div
          v-if="(voiceStatusKind === 'ok' || voiceStatusKind === 'error') && voiceStatusMessage"
          class="voiceToast"
          :class="voiceStatusKind"
          role="status"
          aria-live="polite"
        >
          <svg v-if="voiceStatusKind === 'ok'" class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.53-9.47a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L6.47 11.1a.75.75 0 1 1 1.06-1.06l1.72 1.72 3.22-3.22a.75.75 0 0 1 1.06 0Z"
              clip-rule="evenodd"
            />
          </svg>
          <svg v-else class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5Zm-1.5 7.5a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 0 1.5H10a.75.75 0 0 1-.75-.75Z"
              clip-rule="evenodd"
            />
          </svg>
          <span class="voiceToastText">{{ voiceStatusMessage }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  overflow: hidden;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 10px;
}
.meta {
  display: flex;
  gap: 10px;
  align-items: center;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #ef4444;
}
.dot.on {
  background: #22c55e;
}
.meta-item {
  font-size: 12px;
  color: var(--muted);
}
.actions {
  display: flex;
  gap: 8px;
}
.iconBtn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: #f1f5f9;
  color: #475569;
}
.iconBtn:hover:not(:disabled) {
  background: #e2e8f0;
}
.iconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.iconBtn.danger {
  background: #fee2e2;
  color: #dc2626;
}
.iconBtn.danger:hover:not(:disabled) {
  background: #fecaca;
}

.chat {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 10px;
  background: var(--surface-2);
  min-height: 0;
}
.chat-empty {
  padding: 18px;
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
}
.msg {
  display: flex;
  margin-bottom: 10px;
  max-width: 100%;
  overflow: hidden;
  justify-content: flex-start;
}
.command-block {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
}
.command-tree-header {
  padding: 4px 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.command-tag {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(37, 99, 235, 0.08);
  border: 1px solid rgba(37, 99, 235, 0.25);
  border-radius: 999px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-transform: uppercase;
}
.command-count {
  color: #94a3b8;
  font-size: 12px;
  margin-left: auto;
}
.command-tree {
  padding-left: 8px;
}
.command-tree-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0;
  max-width: 100%;
  overflow: hidden;
}
.command-tree-branch {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  user-select: none;
  flex-shrink: 0;
}
.command-cmd {
  color: #64748b;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 0;
}
.bubble {
  max-width: 100%;
  border-radius: 12px;
  padding: 10px 12px 32px 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  position: relative;
  overflow: hidden;
}
.copyBtn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(255, 255, 255, 0.85);
  color: #475569;
  display: grid;
  place-items: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.msg:hover .copyBtn {
  opacity: 1;
}
.copyBtn:hover {
  background: #ffffff;
  color: #0f172a;
}
.copyBtn:active {
  transform: translateY(0.5px);
}
.command-block .copyBtn {
  position: static;
  opacity: 1;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  margin-left: 0;
}
.msgActions {
  position: absolute;
  left: 10px;
  bottom: 8px;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  opacity: 0.55;
  transition: opacity 120ms ease;
}
.msg:hover .msgActions {
  opacity: 1;
}
.msgCopyBtn {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid rgba(226, 232, 240, 0.95);
  background: rgba(255, 255, 255, 0.92);
  color: #64748b;
  border-radius: 999px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.msgCopyBtn:hover {
  color: #0f172a;
  background: #ffffff;
}
.msg[data-role="user"] .bubble {
  background: rgba(37, 99, 235, 0.08);
  border-color: rgba(37, 99, 235, 0.25);
}
.msg[data-role="system"] .bubble {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(148, 163, 184, 0.35);
}
.msg[data-kind="command"] .bubble {
  background: white;
  border-color: rgba(226, 232, 240, 0.9);
}
.msg[data-kind="command"] .mono {
  color: #0f172a;
}
.formatted {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.textBlock {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.codeBlock {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.03);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: #0f172a;
  white-space: pre;
  overflow-x: auto;
}
.codeBlock code {
  font-family: inherit;
}
.mono {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  overflow-x: hidden;
}
.cursor {
  position: absolute;
  right: 10px;
  bottom: 6px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.typing {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 16px;
}
.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--muted-2);
  animation: bounce 0.6s ease-in-out infinite;
}
.typing .dot:nth-child(2) {
  animation-delay: 0.12s;
}
.typing .dot:nth-child(3) {
  animation-delay: 0.24s;
}
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
  40% { transform: translateY(-2px); opacity: 1; }
}

.composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 12px calc(8px + env(safe-area-inset-bottom, 0px) * var(--safe-bottom-multiplier, 1)) 12px;
  border-top: 1px solid #e2e8f0;
  background: white;
}
.queue {
  display: grid;
  gap: 6px;
  max-height: 140px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding-right: 2px;
}
.queue-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: #f8fafc;
}
.queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #0f172a;
  font-weight: 700;
}
.queue-sub {
  color: #64748b;
  font-weight: 600;
}
.queue-del {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.queue-del:hover {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.06);
}
.cmdText {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(226, 232, 240, 0.92);
  white-space: pre-wrap;
  word-break: break-word;
  text-align: left;
}
.inputWrap {
  position: relative;
  display: flex;
  align-items: stretch;
}
.inputActions {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.voiceIndicator {
  width: 22px;
  height: 18px;
  display: grid;
  place-items: center;
}
.voiceIndicator.recording {
  color: #dc2626;
}
.voiceIndicator.transcribing {
  color: #2563eb;
}
.voiceBars {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 14px;
}
.voiceBars .bar {
  width: 3px;
  border-radius: 3px;
  background: currentColor;
  animation: voiceBars 0.45s ease-in-out infinite;
}
.voiceBars .bar:nth-child(2) {
  animation-delay: 0.08s;
}
.voiceBars .bar:nth-child(3) {
  animation-delay: 0.16s;
}
.voiceSpinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(37, 99, 235, 0.22);
  border-top-color: currentColor;
  animation: voiceSpin 0.75s linear infinite;
}
.voiceToast {
  position: absolute;
  right: 8px;
  bottom: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-size: 12px;
  color: var(--muted);
  max-width: min(72vw, 380px);
  pointer-events: none;
  animation: voiceToastIn 0.14s ease-out;
}
.voiceToast.ok {
  border-color: rgba(16, 185, 129, 0.25);
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
}
.voiceToast.error {
  border-color: rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.06);
  color: #dc2626;
}
.voiceToastIcon {
  width: 14px;
  height: 14px;
  display: block;
  flex-shrink: 0;
}
.voiceToastText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachmentsBar {
  display: flex;
  justify-content: flex-start;
  height: 10px;
}
.attachmentsPill {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: 10px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.04);
  color: #0f172a;
}
.attachmentsText {
  font-size: 8px;
  font-weight: 800;
  color: #475569;
  line-height: 10px;
}
.attachmentsClear {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.attachmentsClear svg {
  width: 10px;
  height: 10px;
  display: block;
}
.attachmentsClear:hover {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.06);
}
.composer-input {
  width: 100%;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  padding: 10px 84px 10px 12px;
  font-size: 16px;
  background: transparent;
  color: #0f172a;
  box-sizing: border-box;
}
.composer-input:focus {
  outline: none;
  border-color: #2563eb;
  background: transparent;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}
.micIcon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s, transform 0.1s;
}
.micIcon:hover:not(:disabled) {
  color: #0f172a;
}
.micIcon:active:not(:disabled) {
  transform: scale(0.98);
}
.micIcon:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.micIcon.recording {
  color: #dc2626;
}
.micIcon.recording:hover:not(:disabled) {
  color: #b91c1c;
}
.micIcon.transcribing {
  color: #2563eb;
}
.sendIcon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #2563eb;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.sendIcon:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.sendIcon:hover:not(:disabled) {
  color: #1d4ed8;
}
.stopIcon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #dc2626;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.stopIcon:hover {
  color: #b91c1c;
}
@keyframes voiceBars {
  0%, 100% { height: 4px; opacity: 0.55; }
  50% { height: 14px; opacity: 1; }
}
@keyframes voiceSpin {
  to { transform: rotate(360deg); }
}
@keyframes voiceToastIn {
  from { transform: translateY(4px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
