<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { CreateTaskInput } from "../api/types";

import TaskCreateFormConfigFields from "./TaskCreateFormConfigFields.vue";
import { useImageAttachments } from "./taskCreateForm/useImageAttachments";
import { useVoiceInput } from "./taskCreateForm/useVoiceInput";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const props = defineProps<{
  apiToken?: string;
  workspaceRoot?: string;
  agents?: AgentOption[];
  activeAgentId?: string;
}>();
const emit = defineEmits<{
  (e: "submit", v: CreateTaskInput): void;
  (e: "submit-and-run", v: CreateTaskInput): void;
  (e: "reset-thread"): void;
  (e: "cancel"): void;
}>();

const title = ref("");
const prompt = ref("");
const promptEl = ref<HTMLTextAreaElement | null>(null);
const agentId = ref("");
const priority = ref(0);
const maxRetries = ref(3);
const reviewRequired = ref(false);

const bootstrapEnabled = ref(false);
const bootstrapProject = ref("");
const bootstrapMaxIterations = ref(10);

const agentOptions = computed(() => {
  const raw = Array.isArray(props.agents) ? props.agents : [];
  return raw
    .map((a) => {
      const id = String(a?.id ?? "").trim();
      if (!id) return null;
      const name = String(a?.name ?? "").trim() || id;
      const ready = Boolean(a?.ready);
      const error = typeof a?.error === "string" && a.error.trim() ? a.error.trim() : undefined;
      return { id, name, ready, error } satisfies AgentOption;
    })
    .filter(Boolean) as AgentOption[];
});

const readyAgentOptions = computed(() => agentOptions.value.filter((a) => a.ready));

const normalizedActiveAgentId = computed(() => String(props.activeAgentId ?? "").trim());

watch([readyAgentOptions, normalizedActiveAgentId], () => {
  const options = readyAgentOptions.value;
  const current = String(agentId.value ?? "").trim();
  if (current && options.some((a) => a.id === current)) {
    return;
  }

  const preferred = normalizedActiveAgentId.value;
  if (preferred && options.some((a) => a.id === preferred)) {
    agentId.value = preferred;
    return;
  }

  agentId.value = options[0]?.id ?? "";
}, { immediate: true });

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
  if (!prompt.value.trim().length) return false;
  if (recording.value || transcribing.value) return false;
  if (uploadingCount.value > 0) return false;
  if (failedCount.value > 0) return false;
  if (bootstrapEnabled.value && !bootstrapProject.value.trim()) return false;
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

  const mergedPrompt = prompt.value.trim();

  const bootstrapConfig = bootstrapEnabled.value && bootstrapProject.value.trim()
    ? {
        enabled: true as const,
        projectRef: bootstrapProject.value.trim(),
        maxIterations: Number.isFinite(bootstrapMaxIterations.value)
          ? Math.max(1, Math.min(10, bootstrapMaxIterations.value))
          : 10,
      }
    : undefined;

  emit(event, {
    title: titleTrimmed.length ? titleTrimmed : undefined,
    prompt: mergedPrompt,
    ...(agentId.value ? { agentId: agentId.value } : {}),
    priority: Number.isFinite(priority.value) ? priority.value : 0,
    maxRetries: Number.isFinite(maxRetries.value) ? maxRetries.value : 3,
    reviewRequired: reviewRequired.value,
    attachments: uploadedIds.length ? uploadedIds : undefined,
    bootstrap: bootstrapConfig,
  });

  title.value = "";
  prompt.value = "";
  bootstrapEnabled.value = false;
  bootstrapProject.value = "";
  bootstrapMaxIterations.value = 10;
  reviewRequired.value = false;
  clearAllAttachments();
}

</script>

<template>
  <div class="createModalInner">
    <div class="modalBody">
      <div class="modalTitle" data-drag-handle>新建任务</div>

      <TaskCreateFormConfigFields
        :title="title"
        :review-required="reviewRequired"
        :bootstrap-enabled="bootstrapEnabled"
        :bootstrap-project="bootstrapProject"
        :bootstrap-max-iterations="bootstrapMaxIterations"
        @update:title="title = $event"
        @update:review-required="reviewRequired = $event"
        @update:bootstrap-enabled="bootstrapEnabled = $event"
        @update:bootstrap-project="bootstrapProject = $event"
        @update:bootstrap-max-iterations="bootstrapMaxIterations = $event"
      />

      <label class="field promptField">
        <span class="label">任务描述</span>
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

            <button class="removeBtn" type="button" title="移除" aria-label="移除附件" @click="removeAttachment(a.localId)">×</button>
          </div>
        </div>
      </div>

      <div class="actions">
        <div class="actionsLeft">
          <label class="inlineToggle">
            <input type="checkbox" :checked="reviewRequired" @change="reviewRequired = ($event.target as HTMLInputElement).checked" data-testid="task-create-review-required" />
            <span class="toggleLabel">需要审核</span>
          </label>
          <label class="inlineToggle">
            <input type="checkbox" :checked="bootstrapEnabled" @change="bootstrapEnabled = ($event.target as HTMLInputElement).checked" data-testid="task-create-bootstrap-toggle" />
            <span class="toggleLabel">自举模式</span>
          </label>
        </div>
        <div class="actionsRight">
          <button class="btnSecondary" type="button" @click="emit('cancel')">取消</button>
          <button class="btnSecondary" type="button" :disabled="!canSubmit" @click="submit">保存</button>
          <button class="btnPrimary" type="button" :disabled="!canSubmit" data-testid="task-create-submit-and-run" @click="submitAndRun">
            保存并提交
          </button>
        </div>
      </div>

      <div v-if="bootstrapEnabled" class="bootstrapConfig">
        <label class="field bootstrapProjectField">
          <span class="label">项目路径 / Git URL</span>
          <input
            :value="bootstrapProject"
            placeholder="/path/to/project 或 https://..."
            data-testid="task-create-bootstrap-project"
            @input="bootstrapProject = ($event.target as HTMLInputElement).value"
          />
        </label>
        <label class="field bootstrapIterationsField">
          <span class="label">最大迭代</span>
          <input
            :value="bootstrapMaxIterations"
            type="number"
            min="1"
            max="10"
            data-testid="task-create-bootstrap-max-iterations"
            @input="bootstrapMaxIterations = Number(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.createModalInner {
  display: flex;
  flex-direction: column;
  height: min(680px, 80vh);
  overflow: hidden;
}

.modalBody {
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.modalTitle {
  font-size: 18px;
  font-weight: 800;
  color: #0f172a;
  text-align: center;
  letter-spacing: 0.02em;
  margin: 0 0 2px 0;
}

.field {
  display: block;
  min-width: 0;
}

.label {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

textarea {
  width: 100%;
  padding: 8px 10px;
  border-radius: 14px;
  border: 1px solid var(--border);
  font-size: 14px;
  background: rgba(248, 250, 252, 0.95);
  color: #1e293b;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

textarea:hover {
  border-color: rgba(148, 163, 184, 0.8);
  background: rgba(255, 255, 255, 0.95);
}

textarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

textarea::placeholder {
  color: #94a3b8;
}

.promptField {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

textarea {
  resize: none;
  flex: 1;
  min-height: 120px;
  max-height: none;
  overflow-y: auto;
}

.promptInputWrap {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.promptInputWrap textarea {
  flex: 1;
  min-height: 120px;
}

.promptInputWrap.voiceEnabled textarea {
  padding-right: 62px;
  padding-bottom: 44px;
}

.promptInputWrap.voiceEnabled.voiceExpanded textarea {
  padding-right: 160px;
  padding-bottom: 78px;
}

.voiceAffordance {
  position: absolute;
  right: 10px;
  bottom: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.voiceRow {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.voiceIndicator {
  height: 18px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

.voiceTime {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: currentColor;
}

.voiceAuxBtn {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: rgba(255, 255, 255, 0.72);
  color: #475569;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s, transform 0.1s, background-color 0.15s, border-color 0.15s;
}

.voiceAuxBtn:hover:not(:disabled) {
  color: #0f172a;
  border-color: rgba(148, 163, 184, 0.7);
  background: rgba(255, 255, 255, 0.9);
}

.voiceAuxBtn:active:not(:disabled) {
  transform: scale(0.98);
}

.voiceAuxBtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.voiceCancelBtn {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.04);
}

.voiceCancelBtn:hover:not(:disabled) {
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.06);
}

.voiceRetryBtn {
  color: #2563eb;
  border-color: rgba(37, 99, 235, 0.25);
  background: rgba(37, 99, 235, 0.05);
}

.voiceRetryBtn:hover:not(:disabled) {
  color: #1d4ed8;
  border-color: rgba(37, 99, 235, 0.4);
  background: rgba(37, 99, 235, 0.07);
}

.micIcon {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: none;
  background: rgba(15, 23, 42, 0.02);
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s, transform 0.1s, background-color 0.15s;
}

.micIcon:hover:not(:disabled) {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.04);
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
  background: rgba(239, 68, 68, 0.06);
}

.voiceToast {
  position: absolute;
  bottom: 44px;
  right: 8px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 600;
  color: #475569;
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

.voiceToastText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes voiceBars {
  0%,
  100% {
    height: 4px;
    opacity: 0.55;
  }

  50% {
    height: 14px;
    opacity: 1;
  }
}

@keyframes voiceSpin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes voiceToastIn {
  from {
    transform: translateY(4px);
    opacity: 0;
  }

  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.errorBox {
  padding: 8px 10px;
  border-radius: 8px;
  background: #fee2e2;
  color: #991b1b;
  font-size: 13px;
  font-weight: 600;
}

.attachments {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.thumbCard {
  display: block;
  flex: 0 0 auto;
  width: 80px;
}

.thumbWrap {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: white;
  width: 100%;
  height: 24px;
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
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
}

.actionsLeft {
  display: flex;
  align-items: center;
  gap: 16px;
}

.actionsRight {
  display: flex;
  align-items: center;
  gap: 32px;
}

.inlineToggle {
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
}

.inlineToggle input[type="checkbox"] {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
  accent-color: #2563eb;
}

.toggleLabel {
  margin-left: 5px;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
}

.bootstrapConfig {
  display: grid;
  grid-template-columns: 1fr 100px;
  gap: 12px;
  align-items: end;
}

.bootstrapProjectField {
  min-width: 0;
}

.bootstrapIterationsField {
  min-width: 0;
}

.bootstrapConfig .label {
  display: block;
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

.bootstrapConfig input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  font-size: 13px;
  background: rgba(248, 250, 252, 0.95);
  color: #1e293b;
  box-sizing: border-box;
}

.bootstrapConfig input:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.btnPrimary {
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
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
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
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
  .actions {
    flex-direction: column;
    align-items: stretch;
  }

  .actionsLeft {
    justify-content: flex-start;
  }

  .actionsRight {
    flex-direction: column;
    gap: 8px;
  }

  .actionsRight button {
    width: 100%;
  }

  .bootstrapConfig {
    grid-template-columns: 1fr;
  }
}
</style>
