import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { IncomingImage } from "./types";
import { autosizeTextarea } from "../../lib/textarea_autosize";

type VoiceStatusKind = "idle" | "recording" | "transcribing" | "error" | "ok";
type TranscriptionResponse = { ok?: boolean; text?: string; error?: string; message?: string };

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

export function useMainChatComposer(params: {
  pendingImages: ReadonlyArray<IncomingImage>;
  isBusy: () => boolean;
  getApiToken: () => string;
  onSend: (content: string) => void;
  onAddImages: (images: IncomingImage[]) => void;
}) {
  const input = ref("");
  const inputEl = ref<HTMLTextAreaElement | null>(null);

  const resizeComposer = (): void => {
    const el = inputEl.value;
    if (!el) return;
    autosizeTextarea(el, { minRows: 5, maxRows: 8 });
  };

  // Resize after Vue commits DOM updates (v-model, conditional UI that affects wrapping, etc).
  watch([input, inputEl], resizeComposer, { flush: "post", immediate: true });

  // Some environments/layout changes won't trigger reactive updates (e.g. viewport resize affects wrapping).
  // Attach lightweight native listeners so the composer reliably grows up to maxRows.
  let attachedEl: HTMLTextAreaElement | null = null;
  const onNativeInput = (): void => {
    resizeComposer();
  };

  const attachNativeListeners = (el: HTMLTextAreaElement | null): void => {
    if (attachedEl) {
      attachedEl.removeEventListener("input", onNativeInput);
      attachedEl = null;
    }
    if (!el) return;
    attachedEl = el;
    el.addEventListener("input", onNativeInput, { passive: true });
  };

  watch(
    inputEl,
    (el) => {
      attachNativeListeners(el);
      resizeComposer();
    },
    { flush: "post", immediate: true },
  );

  const onWindowResize = (): void => {
    resizeComposer();
  };

  onMounted(() => {
    window.addEventListener("resize", onWindowResize, { passive: true });
    resizeComposer();
  });

  const recording = ref(false);
  const transcribing = ref(false);
  const voiceStatusKind = ref<VoiceStatusKind>("idle");
  const voiceStatusMessage = ref("");
  let voiceToastTimer: ReturnType<typeof setTimeout> | null = null;

  let recorder: MediaRecorder | null = null;
  let recorderStream: MediaStream | null = null;
  let recorderMime = "";
  let recorderChunks: Blob[] = [];

  const clearVoiceToast = (): void => {
    if (voiceToastTimer) {
      clearTimeout(voiceToastTimer);
      voiceToastTimer = null;
    }
  };

  const setVoiceStatus = (kind: VoiceStatusKind, message: string, autoClearMs?: number): void => {
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
  };

  const cleanupRecorder = (): void => {
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
  };

  onBeforeUnmount(() => {
    window.removeEventListener("resize", onWindowResize);
    attachNativeListeners(null);
  });

  const insertIntoComposer = async (text: string): Promise<void> => {
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
  };

  const transcribeAudio = async (blob: Blob): Promise<void> => {
    transcribing.value = true;
    setVoiceStatus("idle", "");
    try {
      const headers: Record<string, string> = {};
      const token = params.getApiToken().trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      headers["Content-Type"] = blob.type || "application/octet-stream";

      const res = await fetch("/api/audio/transcriptions", { method: "POST", headers, body: blob });
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
        lowered.includes("fetch failed") || lowered.includes("failed to fetch") ? "语音识别上游连接失败（检查网络/KEY）" : raw;
      setVoiceStatus("error", message || "语音识别失败", 4000);
    } finally {
      transcribing.value = false;
    }
  };

  const startRecording = async (): Promise<void> => {
    const micSupported =
      typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    if (!micSupported) {
      setVoiceStatus("error", "当前浏览器不支持录音", 3500);
      return;
    }
    if (params.isBusy() || transcribing.value || recording.value) {
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
  };

  const stopRecording = (): void => {
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
  };

  const toggleRecording = async (): Promise<void> => {
    if (recording.value) {
      stopRecording();
      return;
    }
    await startRecording();
  };

  const send = (): void => {
    if (recording.value || transcribing.value) return;
    const text = input.value.trim();
    if (!text && params.pendingImages.length === 0) return;
    params.onSend(text);
    input.value = "";
  };

  const onInputKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter") return;
    if ((ev as { isComposing?: boolean }).isComposing) return;
    if (ev.altKey) return;
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    send();
  };

  const onPaste = async (ev: ClipboardEvent): Promise<void> => {
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
        params.onAddImages(images);
        return;
      }

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
  };

  const fileInputEl = ref<HTMLInputElement | null>(null);

  const triggerFileInput = (): void => {
    fileInputEl.value?.click();
  };

  const onFileInputChange = async (ev: Event): Promise<void> => {
    const target = ev.target as HTMLInputElement | null;
    if (!target?.files) return;
    const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
    const images: IncomingImage[] = [];
    for (const file of Array.from(target.files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) continue;
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl) continue;
      images.push({ name: file.name, mime: file.type, data: dataUrl });
    }
    if (images.length) {
      params.onAddImages(images);
    }
    target.value = "";
  };

  onBeforeUnmount(() => {
    clearVoiceToast();
    try {
      recorder?.stop();
    } catch {
      // ignore
    }
    cleanupRecorder();
  });

  return {
    input,
    inputEl,
    fileInputEl,
    send,
    onInputKeydown,
    onPaste,
    recording,
    transcribing,
    voiceStatusKind,
    voiceStatusMessage,
    toggleRecording,
    triggerFileInput,
    onFileInputChange,
  };
}
