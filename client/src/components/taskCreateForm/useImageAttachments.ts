import { computed, onBeforeUnmount, ref } from "vue";

import type { LocalAttachment, UploadedImageAttachment } from "./types";

export function useImageAttachments(options: { apiToken?: () => string | undefined; workspaceRoot?: () => string | undefined }) {
  const attachments = ref<LocalAttachment[]>([]);
  const attachmentError = ref<string | null>(null);

  const uploadingCount = computed(() => attachments.value.filter((a) => a.status === "uploading").length);
  const failedCount = computed(() => attachments.value.filter((a) => a.status === "error").length);

  function getApiToken(): string {
    const raw = options.apiToken?.();
    return String(raw ?? "").trim();
  }

  function getWorkspaceRoot(): string {
    const raw = options.workspaceRoot?.();
    return String(raw ?? "").trim();
  }

  function withWorkspaceQuery(apiPath: string): string {
    const root = getWorkspaceRoot();
    if (!root) return apiPath;
    const joiner = apiPath.includes("?") ? "&" : "?";
    return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
  }

  function withTokenQuery(url: string): string {
    const token = getApiToken();
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
    const token = getApiToken();
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

  function clearAllAttachments(): void {
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

  onBeforeUnmount(() => {
    clearAllAttachments();
  });

  return {
    attachments,
    attachmentError,
    uploadingCount,
    failedCount,
    withTokenQuery,
    addAttachmentFromFile,
    retryUpload,
    removeAttachment,
    onPromptPaste,
    clearAllAttachments,
  };
}

