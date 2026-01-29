<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
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
  (e: "reset-thread"): void;
  (e: "cancel"): void;
}>();

const title = ref("");
const prompt = ref("");
const model = ref("auto");
const priority = ref(0);
const maxRetries = ref(3);

const attachments = ref<LocalAttachment[]>([]);
const attachmentError = ref<string | null>(null);

const uploadingCount = computed(() => attachments.value.filter((a) => a.status === "uploading").length);
const failedCount = computed(() => attachments.value.filter((a) => a.status === "error").length);

const canSubmit = computed(() => {
  if (prompt.value.trim().length === 0) return false;
  if (uploadingCount.value > 0) return false;
  if (failedCount.value > 0) return false;
  return true;
});

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
    attachmentError.value = "Image too large (>5MB)";
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
  if (!canSubmit.value) return;
  const titleTrimmed = title.value.trim();
  const uploadedIds = attachments.value
    .filter((a) => a.status === "ready" && a.uploaded?.id)
    .map((a) => String(a.uploaded!.id))
    .filter(Boolean);
  emit("submit", {
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

function onPromptKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Enter") return;
  if ((ev as { isComposing?: boolean }).isComposing) return;
  if (ev.altKey) return; // Alt+Enter: newline
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  submit();
}

const modelOptions = computed(() => {
  const enabled = props.models.filter((m) => m.isEnabled);
  return [{ id: "auto", displayName: "Auto", provider: "" }, ...enabled];
});

onBeforeUnmount(() => {
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
    <h3 class="form-title">新建任务</h3>

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
          <textarea
            v-model="prompt"
            rows="10"
            placeholder="描述任务内容..."
            @keydown="onPromptKeydown"
            @paste="onPromptPaste"
          />
        </label>
      </div>

      <div v-if="attachmentError" class="errorBox">Attachments: {{ attachmentError }}</div>

      <div v-if="attachments.length" class="attachments">
        <div class="attachmentsHeader">
          <span class="attachmentsTitle">Images</span>
          <span class="attachmentsMeta">
            <span v-if="uploadingCount">Uploading {{ uploadingCount }}…</span>
            <span v-else-if="failedCount">Failed {{ failedCount }}</span>
            <span v-else>Ready {{ attachments.length }}</span>
          </span>
        </div>

        <div class="thumbGrid">
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
                <div class="errorText">{{ a.error || "Upload failed" }}</div>
                <button class="retryBtn" type="button" @click="retryUpload(a.localId)">Retry</button>
              </div>

              <button class="removeBtn" type="button" title="Remove" @click="removeAttachment(a.localId)">×</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btnSecondary" type="button" @click="emit('cancel')">取消</button>
      <button class="btnPrimary" type="button" :disabled="!canSubmit" @click="submit">确认</button>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 24px 26px;
  background: var(--surface);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.form-title {
  margin: 0 0 22px 0;
  font-size: 18px;
  font-weight: 800;
  color: var(--text);
  text-align: center;
  letter-spacing: 0.02em;
}
.form-row {
  margin-bottom: 16px;
}
.fields {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.prompt-row {
  flex: 1 1 auto;
  min-height: 0;
}
.prompt-row .form-field {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.form-row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.form-field {
  display: block;
}
.label-text {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 8px;
}
input,
select,
textarea {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--border);
  font-size: 15px;
  background: rgba(248, 250, 252, 0.95);
  color: #1e293b;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}
input:hover,
select:hover,
textarea:hover {
  border-color: rgba(148, 163, 184, 0.8);
  background: rgba(255, 255, 255, 0.95);
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
input::placeholder,
textarea::placeholder {
  color: #94a3b8;
}
textarea {
  resize: none;
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  min-height: 180px;
}
.errorBox {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #fee2e2;
  color: #991b1b;
  font-size: 13px;
  font-weight: 600;
}
.attachments {
  margin-top: 12px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 12px;
  padding: 10px;
  background: rgba(248, 250, 252, 0.75);
}
.attachmentsHeader {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.attachmentsTitle {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #0f172a;
}
.attachmentsMeta {
  font-size: 12px;
  color: #64748b;
  font-weight: 600;
}
.thumbGrid {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 0;
  scrollbar-gutter: stable;
  overscroll-behavior-inline: contain;
}
.thumbCard {
  display: block;
  flex: 0 0 auto;
  width: 160px;
}
.thumbWrap {
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: white;
  width: 100%;
  height: 56px;
}
.thumbImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumbLink {
  display: block;
  width: 100%;
  height: 100%;
}
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 4px;
  background: rgba(15, 23, 42, 0.35);
  color: white;
}
.overlay.ready {
  background: linear-gradient(180deg, rgba(15, 23, 42, 0), rgba(15, 23, 42, 0.45));
  align-items: end;
  justify-items: end;
}
.overlay.error {
  background: rgba(127, 29, 29, 0.75);
  place-items: center;
  gap: 8px;
}
.errorText {
  font-size: 9px;
  font-weight: 700;
  text-align: center;
  line-height: 1.2;
  max-height: 3.6em;
  overflow: hidden;
}
.retryBtn {
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.95);
  color: #0f172a;
}
.retryBtn:hover {
  background: white;
}
.progressRow {
  width: 100%;
  display: grid;
  gap: 4px;
}
.progressBar {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.35);
  overflow: hidden;
}
.progressFill {
  height: 100%;
  background: rgba(255, 255, 255, 0.95);
}
.progressText {
  font-size: 9px;
  font-weight: 800;
  text-align: center;
}
.removeBtn {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.2);
  background: rgba(255, 255, 255, 0.92);
  color: #0f172a;
  font-weight: 900;
  cursor: pointer;
  line-height: 12px;
}
.removeBtn:hover {
  background: white;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 16px;
  margin-top: auto;
  padding-top: 18px;
}
.btnPrimary {
  border-radius: 18px;
  padding: 12px 44px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: none;
  background: linear-gradient(90deg, #4f8ef7 0%, #7aa9ff 100%);
  color: white;
  box-shadow: 0 10px 20px rgba(79, 142, 247, 0.35);
  transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}
.btnPrimary:hover:not(:disabled) {
  transform: translateY(-1px);
}
.btnPrimary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
}
.btnSecondary {
  border-radius: 18px;
  padding: 12px 40px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(79, 142, 247, 0.35);
  background: rgba(79, 142, 247, 0.12);
  color: #2563eb;
  transition: border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}
.btnSecondary:hover {
  border-color: rgba(79, 142, 247, 0.6);
  background: rgba(79, 142, 247, 0.18);
  transform: translateY(-1px);
}
.btnSecondary:active {
  background: rgba(79, 142, 247, 0.22);
}
@media (max-width: 600px) {
  .form-row-3 {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .thumbGrid {
    gap: 6px;
  }
  .thumbCard {
    width: 140px;
  }
  .thumbWrap {
    height: 52px;
  }
  .actions {
    flex-direction: column;
    align-items: stretch;
  }
  .actions button {
    width: 100%;
  }
}
</style>
