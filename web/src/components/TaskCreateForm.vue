<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { CreateTaskInput, ModelConfig } from "../api/types";

import { useImageAttachments } from "./taskCreateForm/useImageAttachments";
import { useVoiceInput } from "./taskCreateForm/useVoiceInput";

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

async function insertIntoPrompt(text: string): Promise<void> {
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

const voice = useVoiceInput({
  apiToken: () => props.apiToken,
  insertIntoPrompt,
});

const {
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
} = voice;

const imageAttachments = useImageAttachments({
  apiToken: () => props.apiToken,
  workspaceRoot: () => props.workspaceRoot,
});

const {
  attachments,
  attachmentError,
  uploadingCount,
  failedCount,
  withTokenQuery,
  retryUpload,
  removeAttachment,
  onPromptPaste,
  clearAllAttachments,
} = imageAttachments;

const canSubmit = computed(() => {
  if (prompt.value.trim().length === 0) return false;
  if (recording.value || transcribing.value) return false;
  if (uploadingCount.value > 0) return false;
  if (failedCount.value > 0) return false;
  return true;
});

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
  clearAllAttachments();
}

const modelOptions = computed(() => {
  const enabled = props.models.filter((m) => m.isEnabled);
  return [{ id: "auto", displayName: "Auto", provider: "" }, ...enabled];
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
