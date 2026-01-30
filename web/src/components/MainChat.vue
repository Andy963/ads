<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import MarkdownContent from "./MarkdownContent.vue";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  command?: string;
  hiddenLineCount?: number;
  ts?: number;
  streaming?: boolean;
};

type RenderMessage = ChatMessage & {
  stackCount?: number;
  stackUnderlays?: number;
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
const showScrollToBottom = ref(false);
const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);

const COMMAND_COLLAPSE_THRESHOLD = 3;
const openCommandTrees = ref<Set<string>>(new Set());

function isCommandTreeOpen(id: string, commandsCount: number): boolean {
  if (commandsCount <= COMMAND_COLLAPSE_THRESHOLD) return true;
  return openCommandTrees.value.has(id);
}

function toggleCommandTree(id: string): void {
  const next = new Set(openCommandTrees.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openCommandTrees.value = next;
}

function caretPath(open: boolean): string {
  return open ? "M6 8l4 4 4-4" : "M8 6l4 4-4 4";
}

const renderMessages = computed<RenderMessage[]>(() => {
  const out: RenderMessage[] = [];
  const stack: ChatMessage[] = [];

  const flush = () => {
    if (stack.length === 0) return;
    if (stack.length === 1) {
      out.push(stack[0]!);
      stack.length = 0;
      return;
    }
    const top = stack[stack.length - 1]!;
    out.push({
      ...top,
      id: `execstack:${top.id}`,
      role: "system",
      kind: "execute",
      stackCount: stack.length,
      stackUnderlays: Math.min(2, Math.max(0, stack.length - 1)),
    });
    stack.length = 0;
  };

  for (const m of props.messages) {
    if (m.kind === "execute") {
      stack.push(m);
      continue;
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
});

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
  const distance = scrollHeight - scrollTop - clientHeight;
  autoScroll.value = distance < 80;
  showScrollToBottom.value = distance >= 80;
}

async function scrollToBottom(): Promise<void> {
  if (!listRef.value) return;
  await nextTick();
  listRef.value.scrollTop = listRef.value.scrollHeight;
  autoScroll.value = true;
  showScrollToBottom.value = false;
}

watch(
  () => props.messages.length,
  async () => {
    if (autoScroll.value && listRef.value) {
      await nextTick();
      listRef.value.scrollTop = listRef.value.scrollHeight;
      showScrollToBottom.value = false;
      return;
    }
    showScrollToBottom.value = true;
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

function formatMessageTs(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "";

  const pad2 = (num: number) => String(num).padStart(2, "0");
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
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
      <div v-for="m in renderMessages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div v-if="m.kind === 'command'" class="command-block">
          <div class="command-tree-header">
            <button
              v-if="getCommands(m.content).length > COMMAND_COLLAPSE_THRESHOLD"
              class="command-caret"
              type="button"
              aria-label="Toggle command tree"
              :aria-expanded="isCommandTreeOpen(m.id, getCommands(m.content).length)"
              @click="toggleCommandTree(m.id)"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="caretPath(isCommandTreeOpen(m.id, getCommands(m.content).length))" />
              </svg>
            </button>
            <span class="command-tag">EXECUTE</span>
            <span class="command-count">{{ getCommands(m.content).length }} 条命令</span>
          </div>
          <div v-if="isCommandTreeOpen(m.id, getCommands(m.content).length)" class="command-tree">
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
        <div v-else-if="m.kind === 'execute'" class="execute-stack" :data-stack="m.stackCount ?? 0">
          <div v-if="(m.stackUnderlays ?? 0) > 0" class="execute-underlays" aria-hidden="true">
            <div v-for="n in m.stackUnderlays" :key="n" class="execute-underlay" :data-layer="n" />
          </div>
          <div class="execute-block">
            <div class="execute-header">
              <span class="command-tag">EXECUTE</span>
              <span class="execute-cmd" :title="m.command || ''">{{ m.command || "" }}</span>
              <span v-if="m.stackCount" class="execute-stack-count">{{ m.stackCount }} 条命令</span>
            </div>
            <pre v-if="m.content.trim()" class="execute-output">{{ m.content }}</pre>
            <div v-if="(m.hiddenLineCount ?? 0) > 0" class="execute-more">… {{ m.hiddenLineCount }} more lines</div>
          </div>
        </div>
        <div
          v-else
          :class="[
            'bubble',
            {
              'bubble--compact':
                m.role === 'assistant' &&
                m.kind === 'text' &&
                m.streaming &&
                m.content.length === 0,
            },
          ]"
        >
          <div v-if="m.role === 'assistant' && m.kind === 'text' && m.streaming && m.content.length === 0" class="typing" aria-label="AI is thinking">
            <span class="thinkingText">thinking</span>
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
            <span v-if="m.ts" class="msgTime">{{ formatMessageTs(m.ts) }}</span>
          </div>
        </div>
      </div>
      <button
        v-if="showScrollToBottom"
        class="scrollToBottom"
        type="button"
        aria-label="Scroll to bottom"
        title="回到底部"
        @click="scrollToBottom"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </button>
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

<style src="./MainChat.css" scoped></style>
