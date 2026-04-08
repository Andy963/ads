<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ModelConfig } from "../api/types";
import MainChatPendingImageViewer from "./MainChatPendingImageViewer.vue";
import { resolveComposerImagePreview } from "./mainChat/attachmentPreview";
import type { IncomingImage, QueuedPrompt } from "./mainChat/types";
import { useMainChatComposer } from "./mainChat/useComposer";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };
type AgentDelegation = {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  startedAt: number;
};

type PendingImagePreview = {
  key: string;
  src: string;
  href: string;
};

const props = defineProps<{
  draft?: string;
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  connected: boolean;
  busy: boolean;
  agents?: AgentOption[];
  activeAgentId?: string;
  models?: ModelConfig[];
  modelId?: string;
  modelReasoningEffort?: string;
  agentDelegations?: AgentDelegation[];
  apiToken?: string;
  runningTaskCount?: number;
  connectionStatusKind?: "disconnected" | "error" | null;
  connectionStatusMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:draft", value: string): void;
  (e: "send", content: string): void;
  (e: "interrupt"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeQueued", id: string): void;
  (e: "switchAgent", agentId: string): void;
  (e: "setModel", modelId: string): void;
  (e: "setReasoningEffort", effort: string): void;
}>();

const canInterrupt = computed(() => props.busy);

const agentOptions = computed(() => (Array.isArray(props.agents) ? props.agents : []));
const readyAgentOptions = computed(() => agentOptions.value.filter((a) => Boolean(a?.ready) && String(a?.id ?? "").trim()));
const modelOptions = computed(() => (Array.isArray(props.models) ? props.models : []));

const selectedAgentId = computed(() => {
  const active = String(props.activeAgentId ?? "").trim();
  if (active && readyAgentOptions.value.some((a) => String(a.id ?? "").trim() === active)) {
    return active;
  }
  const fallback = readyAgentOptions.value[0]?.id ?? "";
  return String(fallback ?? "").trim();
});

function formatAgentLabel(agent: AgentOption): string {
  const id = String(agent.id ?? "").trim();
  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name;
  if (agent.ready) return base || "agent";
  const suffix = String(agent.error ?? "").trim() || "unavailable";
  return base ? `${base} - ${suffix}` : suffix;
}

const lastAutoSwitchedAgentId = ref<string | null>(null);

watch(
  () => [
    Boolean(props.connected),
    Boolean(props.busy),
    String(props.activeAgentId ?? "").trim(),
    readyAgentOptions.value.map((a) => String(a.id ?? "").trim()).join("\n"),
  ],
  () => {
    if (!props.connected || props.busy) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    const options = readyAgentOptions.value;
    if (options.length === 0) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    const active = String(props.activeAgentId ?? "").trim();
    if (active && options.some((a) => String(a.id ?? "").trim() === active)) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    const next = selectedAgentId.value;
    if (!next || next === active) return;
    if (lastAutoSwitchedAgentId.value === next) return;

    lastAutoSwitchedAgentId.value = next;
    emit("switchAgent", next);
  },
  { immediate: true },
);

function onAgentChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
  const next = String(value ?? "").trim();
  if (!next) return;
  emit("switchAgent", next);
}

function normalizeModelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function isUnsetModelId(modelId: string): boolean {
  const id = String(modelId ?? "").trim().toLowerCase();
  return !id || id === "auto";
}

function modelAllowedAgents(model: ModelConfig): string[] | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return null;
  const agents = raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return agents.length > 0 ? agents : null;
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

function isGeminiModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.includes("gemini") || id.startsWith("auto-gemini");
}

function supportsAgentModel(args: { agentId: string; model: ModelConfig }): boolean {
  const agentId = String(args.agentId ?? "").trim().toLowerCase();
  if (!agentId) return true;

  const allowed = modelAllowedAgents(args.model);
  if (allowed) {
    return allowed.map((id) => id.toLowerCase()).includes(agentId);
  }

  const provider = String(args.model.provider ?? "").trim().toLowerCase();
  const modelId = String(args.model.id ?? "").trim();

  if (agentId === "claude") {
    if (provider.includes("anthropic")) return true;
    return isClaudeModelId(modelId);
  }
  if (agentId === "gemini") {
    if (provider.includes("google")) return true;
    return isGeminiModelId(modelId);
  }
  if (agentId === "codex") {
    if (provider.includes("anthropic") || provider.includes("google")) return false;
    if (isClaudeModelId(modelId) || isGeminiModelId(modelId)) return false;
    return true;
  }

  return true;
}

const filteredModelOptions = computed(() => {
  const agentId = selectedAgentId.value;
  return modelOptions.value.filter((model) => supportsAgentModel({ agentId, model }));
});

const effectiveModelId = computed(() => {
  const options = filteredModelOptions.value;
  if (options.length === 0) return "";
  const current = normalizeModelId(props.modelId);
  if (!isUnsetModelId(current) && options.some((m) => String(m.id ?? "").trim() === current)) {
    return current;
  }
  return String(options[0]?.id ?? "").trim();
});

watch(
  () => [selectedAgentId.value, props.modelId, filteredModelOptions.value.map((m) => String(m.id ?? "").trim()).join("\n")],
  () => {
    const options = filteredModelOptions.value;
    if (options.length === 0) return;
    const desired = String(options[0]?.id ?? "").trim();
    if (!desired) return;

    const current = normalizeModelId(props.modelId);
    if (!isUnsetModelId(current) && options.some((m) => String(m.id ?? "").trim() === current)) {
      return;
    }

    if (desired !== current) {
      emit("setModel", desired);
    }
  },
  { immediate: true },
);

function formatModelLabel(model: ModelConfig): string {
  const id = String(model.id ?? "").trim();
  const name = String(model.displayName ?? "").trim() || id;
  return name || "model";
}

function onModelChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
  const next = normalizeModelId(value);
  if (!next || isUnsetModelId(next)) return;
  emit("setModel", next);
}

const reasoningEffortValue = computed(() => {
  const raw = String(props.modelReasoningEffort ?? "").trim().toLowerCase();
  if (raw === "medium" || raw === "high" || raw === "xhigh") return raw;
  if (raw === "low") return "medium";
  return "high";
});

function onReasoningEffortChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
  emit("setReasoningEffort", String(value ?? "").trim());
}

const agentDelegationLabel = computed(() => {
  const entries = Array.isArray(props.agentDelegations) ? props.agentDelegations : [];
  if (!props.busy || entries.length === 0) return "";
  const names: string[] = [];
  for (const entry of entries) {
    const label = String(entry.agentName || entry.agentId || "").trim();
    if (!label) continue;
    if (!names.includes(label)) names.push(label);
  }
  if (names.length === 0) return "Delegating to agents…";
  const shown = names.slice(0, 3).join(", ");
  const hidden = Math.max(0, names.length - 3);
  const suffix = hidden ? ` +${hidden} more` : "";
  return `Delegating to: ${shown}${suffix}`;
});

const normalizedConnectionStatusKind = computed(() =>
  props.connectionStatusKind === "error" ? "error" : "disconnected",
);

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const pendingImageViewerOpen = ref(false);
const pendingImageViewerIndex = ref(0);

const pendingImagePreviews = computed<PendingImagePreview[]>(() => {
  const token = String(props.apiToken ?? "").trim();
  return props.pendingImages.map((image, idx) => {
    const resolved = resolveComposerImagePreview(String(image?.data ?? ""), { apiToken: token });
    const fallback = `pending-image-${idx + 1}`;
    const keySeed = resolved?.src ? resolved.src.slice(0, 96) : fallback;
    return {
      key: `${idx}-${keySeed}`,
      src: resolved?.src ?? "",
      href: resolved?.href ?? "",
    };
  });
});

function openPendingImageViewer(index = 0): void {
  const total = props.pendingImages.length;
  if (!total) return;
  pendingImageViewerIndex.value = clamp(index, 0, total - 1);
  pendingImageViewerOpen.value = true;
}

function closePendingImageViewer(): void {
  pendingImageViewerOpen.value = false;
}

watch(
  () => props.pendingImages.length,
  (len) => {
    if (len <= 0) {
      pendingImageViewerOpen.value = false;
      pendingImageViewerIndex.value = 0;
      return;
    }
    pendingImageViewerIndex.value = clamp(pendingImageViewerIndex.value, 0, len - 1);
  },
  { flush: "post" },
);

const {
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
} = useMainChatComposer({
  getDraft: () => String(props.draft ?? ""),
  onDraftChange: (draft) => emit("update:draft", draft),
  pendingImages: props.pendingImages,
  isBusy: () => props.busy,
  getApiToken: () => String(props.apiToken ?? ""),
  onSend: (content) => emit("send", content),
  onAddImages: (images) => emit("addImages", images),
});
</script>

<template>
  <div class="composer">
    <div v-if="agentDelegationLabel" class="delegationBar" aria-label="Agent delegation status">
      <span class="delegationSpinner" aria-hidden="true" />
      <span class="delegationText">{{ agentDelegationLabel }}</span>
    </div>

    <div
      v-if="connectionStatusMessage"
      class="laneStatusBar"
      :class="`laneStatusBar--${normalizedConnectionStatusKind}`"
      role="status"
      aria-live="polite"
      data-testid="lane-connection-status"
    >
      <span class="laneStatusDot" aria-hidden="true" />
      <span class="laneStatusText">{{ connectionStatusMessage }}</span>
    </div>

    <div v-if="queuedPrompts.length" class="queue" aria-label="排队消息">
      <div v-for="q in queuedPrompts" :key="q.id" class="queue-item">
        <div class="queue-text">
          {{ q.text || `[图片 x${q.imagesCount}]` }}
          <span v-if="q.text && q.imagesCount" class="queue-sub"> · 图片 x{{ q.imagesCount }}</span>
        </div>
        <button class="queue-del" type="button" title="移除" aria-label="移除排队消息" @click="emit('removeQueued', q.id)">
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
      <div class="attachmentsStrip" aria-label="图片附件缩略图">
        <button
          v-for="(img, idx) in pendingImagePreviews"
          :key="img.key"
          class="attachmentsThumb"
          type="button"
          :title="`预览图片 ${idx + 1}`"
          :aria-label="`预览图片 ${idx + 1}`"
          @click="openPendingImageViewer(idx)"
        >
          <img v-if="img.src" class="attachmentsThumbImg" :src="img.src" alt="" />
          <span v-else class="attachmentsThumbFallback">图片</span>
        </button>
      </div>
      <button class="attachmentsClear" type="button" title="清空图片" aria-label="清空图片" @click="emit('clearImages')">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>

    <div class="inputWrap">
      <input ref="fileInputEl" type="file" accept="image/*" multiple class="hiddenFileInput" @change="onFileInputChange" />
      <textarea
        ref="inputEl"
        v-model="input"
        rows="5"
        class="composer-input"
        placeholder="输入…（Enter 发送，Alt+Enter 换行，粘贴图片）"
        @keydown="onInputKeydown"
        @paste="onPaste"
      />
      <div class="inputToolbar">
        <div class="inputToolbarLeft">
          <button class="attachIcon" type="button" title="添加图片附件" @click="triggerFileInput">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M15.621 4.379a3.5 3.5 0 0 0-4.95 0l-7.07 7.07a5 5 0 0 0 7.07 7.072l4.95-4.95a.75.75 0 0 0-1.06-1.061l-4.95 4.95a3.5 3.5 0 1 1-4.95-4.95l7.07-7.07a2 2 0 1 1 2.83 2.828l-7.07 7.071a.5.5 0 0 1-.707-.707l4.95-4.95a.75.75 0 1 0-1.06-1.06l-4.95 4.95a2 2 0 0 0 2.828 2.828l7.07-7.071a3.5 3.5 0 0 0 0-4.95Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
          <div v-if="readyAgentOptions.length" class="agentSelect">
            <select
              class="agentSelectInput"
              :value="selectedAgentId"
              :disabled="!connected || busy"
              aria-label="Select agent"
              @change="onAgentChange"
            >
              <option v-for="a in readyAgentOptions" :key="a.id" :value="a.id">
                {{ formatAgentLabel(a) }}
              </option>
            </select>
          </div>
          <div v-if="agentOptions.length" class="agentSelect">
            <select
              class="agentSelectInput"
              :value="effectiveModelId"
              :disabled="!connected || busy || filteredModelOptions.length === 0"
              aria-label="Select model"
              data-testid="chat-model-select"
              @change="onModelChange"
            >
              <option v-if="filteredModelOptions.length === 0" value="" disabled>No models</option>
              <option v-for="m in filteredModelOptions" :key="m.id" :value="m.id">
                {{ formatModelLabel(m) }}
              </option>
            </select>
          </div>
          <div v-if="selectedAgentId === 'codex'" class="agentSelect">
            <select
              class="agentSelectInput"
              :value="reasoningEffortValue"
              :disabled="!connected || busy"
              aria-label="Select reasoning effort"
              data-testid="chat-reasoning-effort"
              @change="onReasoningEffortChange"
            >
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
            </select>
          </div>
        </div>
        <div class="inputToolbarRight">
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
          <button v-if="canInterrupt" class="stopIcon" type="button" title="中断" @click="emit('interrupt')">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
            <span v-if="runningTaskCount > 0" class="runningBadge">{{ runningTaskCount }}</span>
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

    <MainChatPendingImageViewer v-if="pendingImageViewerOpen" :previews="pendingImagePreviews" @close="closePendingImageViewer" />
  </div>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 12px calc(8px + env(safe-area-inset-bottom, 0px) * var(--safe-bottom-multiplier, 1)) 12px;
  border-top: 1px solid #e2e8f0;
  background: white;
}

.delegationBar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px dashed rgba(148, 163, 184, 0.9);
  background: #f1f5f9;
  color: #0f172a;
  font-size: 12px;
  font-weight: 700;
}

.delegationSpinner {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 2px solid rgba(29, 78, 216, 0.22);
  border-top-color: #1d4ed8;
  animation: voiceSpin 0.75s linear infinite;
  flex-shrink: 0;
}

.delegationText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.laneStatusBar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
  font-weight: 700;
}

.laneStatusBar--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: #fef2f2;
  color: #b91c1c;
}

.laneStatusDot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: currentColor;
  flex-shrink: 0;
}

.laneStatusText {
  min-width: 0;
  line-height: 1.35;
  word-break: break-word;
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

.inputWrap {
  position: relative;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: transparent;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.inputWrap:focus-within {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.hiddenFileInput {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.inputToolbar {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  flex-shrink: 0;
  gap: 6px;
}

.inputToolbarLeft {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.inputToolbarRight {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 0 0 auto;
  margin-left: auto;
}

.attachIcon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s;
}

.attachIcon:hover {
  color: #0f172a;
}

.agentSelect {
  display: flex;
  align-items: center;
  min-width: 0;
}

.agentSelectInput {
  height: 28px;
  max-width: 150px;
  min-width: 0;
  border-radius: 8px;
  border: 1px solid rgba(226, 232, 240, 0.95);
  background: white;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
  padding: 0 8px;
  cursor: pointer;
}

.agentSelectInput:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.agentSelectInput:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.65);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12);
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
  top: -36px;
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
  align-items: center;
  gap: 4px;
  min-height: 28px;
  margin-bottom: 2px;
}

.attachmentsStrip {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  max-width: min(56vw, 420px);
  padding: 2px 0;
}

.attachmentsThumb {
  width: 36px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.04);
  overflow: hidden;
  box-sizing: border-box;
  padding: 0;
  flex: 0 0 auto;
  cursor: pointer;
}

.attachmentsThumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.attachmentsThumbImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.attachmentsThumbFallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: #64748b;
}

.attachmentsClear {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.04);
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.attachmentsClear svg {
  width: 14px;
  height: 14px;
  display: block;
}

.attachmentsClear:hover {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.06);
}

.attachmentsClear:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.composer-input {
  width: 100%;
  resize: none;
  overflow-y: hidden;
  border-radius: 10px 10px 0 0;
  border: none;
  padding: 10px 12px;
  font-size: 16px;
  background: transparent;
  color: #0f172a;
  box-sizing: border-box;
}

.composer-input:focus {
  outline: none;
  background: transparent;
  box-shadow: none;
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
  position: relative;
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

.runningBadge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: #dc2626;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

.stopIcon:hover {
  color: #b91c1c;
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
</style>
