<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { ModelConfig } from "../api/types";
import { normalizeReasoningEffort } from "../lib/chatPreferences";
import { supportsAgentModel } from "../lib/model_agent";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const DEFAULT_CODEX_REASONING_EFFORTS = ["medium", "high", "xhigh", "max", "ultra"] as const;
const DEFAULT_CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const REASONING_EFFORT_SHORT_LABELS: Record<string, string> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "低 (low)",
  medium: "中 (medium)",
  high: "高 (high)",
  xhigh: "极高 (xhigh)",
  max: "Max",
  ultra: "Ultra",
};

const props = defineProps<{
  connected: boolean;
  busy: boolean;
  inputLocked?: boolean;
  agents?: AgentOption[];
  activeAgentId?: string;
  models?: ModelConfig[];
  modelId?: string;
  modelReasoningEffort?: string;
}>();

const emit = defineEmits<{
  (e: "switchAgent", agentId: string): void;
  (e: "setModel", modelId: string): void;
  (e: "setReasoningEffort", effort: string): void;
}>();

const popoverRoot = ref<HTMLElement | null>(null);
const open = ref(false);
const lastAutoSwitchedAgentId = ref<string | null>(null);

const agentOptions = computed(() => (Array.isArray(props.agents) ? props.agents : []));
const readyAgentIds = computed(() =>
  agentOptions.value
    .filter((agent) => Boolean(agent?.ready))
    .map((agent) => String(agent?.id ?? "").trim())
    .filter(Boolean),
);

const selectedAgentId = computed(() => {
  const active = String(props.activeAgentId ?? "").trim();
  if (active && readyAgentIds.value.includes(active)) return active;
  return readyAgentIds.value[0] ?? "";
});

watch(
  () => [
    Boolean(props.connected),
    Boolean(props.busy),
    Boolean(props.inputLocked),
    String(props.activeAgentId ?? "").trim(),
    readyAgentIds.value.join("\n"),
  ],
  () => {
    if (!props.connected || props.busy || props.inputLocked) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    if (readyAgentIds.value.length === 0) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    const active = String(props.activeAgentId ?? "").trim();
    if (active && readyAgentIds.value.includes(active)) {
      lastAutoSwitchedAgentId.value = null;
      return;
    }

    const next = selectedAgentId.value;
    if (!next || next === active || lastAutoSwitchedAgentId.value === next) return;
    lastAutoSwitchedAgentId.value = next;
    emit("switchAgent", next);
  },
  { immediate: true },
);

const modelOptions = computed(() =>
  (Array.isArray(props.models) ? props.models : []).filter((model) => model?.isEnabled !== false),
);

function normalizeModelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function isUnsetModelId(modelId: string): boolean {
  const id = String(modelId ?? "").trim().toLowerCase();
  return !id || id === "auto";
}

function modelKey(model: ModelConfig): string {
  return normalizeModelId(model.modelId ?? model.id);
}

function modelKeyOrEmpty(model: ModelConfig | null): string {
  return model ? modelKey(model) : "";
}

function formatModelLabel(model: ModelConfig): string {
  return String(model.displayName ?? "").trim() || modelKey(model) || "model";
}

function preferredModel(options: readonly ModelConfig[]): ModelConfig | null {
  return options.find((model) => model.isDefault) ?? options[0] ?? null;
}

const compatibleModelOptions = computed(() => {
  const agentId = selectedAgentId.value;
  if (!agentId) return [];
  return modelOptions.value.filter((model) => supportsAgentModel({ agentId, model }));
});

const effectiveModelId = computed(() => {
  const options = compatibleModelOptions.value;
  if (options.length === 0) return "";
  const current = normalizeModelId(props.modelId);
  const known = modelOptions.value.some((model) => modelKey(model) === current);
  if (!isUnsetModelId(current) && (!known || options.some((model) => modelKey(model) === current))) {
    return current;
  }
  return modelKeyOrEmpty(preferredModel(options));
});

watch(
  () => [
    Boolean(props.inputLocked),
    selectedAgentId.value,
    props.modelId,
    compatibleModelOptions.value
      .map((model) => `${modelKey(model)}:${model.isDefault ? "default" : "standard"}`)
      .join("\n"),
  ],
  () => {
    if (props.inputLocked) return;
    const options = compatibleModelOptions.value;
    if (options.length === 0) return;
    const desired = modelKeyOrEmpty(preferredModel(options));
    if (!desired) return;

    const current = normalizeModelId(props.modelId);
    const known = modelOptions.value.some((model) => modelKey(model) === current);
    if (!isUnsetModelId(current) && (!known || options.some((model) => modelKey(model) === current))) return;
    if (desired !== current) emit("setModel", desired);
  },
  { immediate: true },
);

const selectedModel = computed(() => {
  const modelId = effectiveModelId.value;
  return compatibleModelOptions.value.find((model) => modelKey(model) === modelId) ?? null;
});

const reasoningEffortOptions = computed(() => {
  if (!selectedModel.value) return [];

  const fallback = selectedAgentId.value === "codex"
    ? DEFAULT_CODEX_REASONING_EFFORTS
    : DEFAULT_CLAUDE_REASONING_EFFORTS;
  const config = selectedModel.value.configJson;
  const raw = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).reasoningEfforts
    : null;
  if (!Array.isArray(raw)) return [...fallback];

  const values = raw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter((entry) => Boolean(REASONING_EFFORT_LABELS[entry]));
  return values.length > 0 ? [...new Set(values)] : [...fallback];
});

const reasoningEffortValue = computed(() => {
  const normalized = normalizeReasoningEffort(props.modelReasoningEffort);
  if (reasoningEffortOptions.value.includes(normalized)) return normalized;
  if (reasoningEffortOptions.value.includes("high")) return "high";
  return reasoningEffortOptions.value[0] ?? "";
});

watch(
  () => [
    Boolean(props.inputLocked),
    selectedAgentId.value,
    effectiveModelId.value,
    String(props.modelReasoningEffort ?? "").trim().toLowerCase(),
    reasoningEffortOptions.value.join("\n"),
  ],
  () => {
    if (props.inputLocked || reasoningEffortOptions.value.length === 0) return;
    const current = String(props.modelReasoningEffort ?? "").trim().toLowerCase();
    if (!current || current === reasoningEffortValue.value) return;
    emit("setReasoningEffort", reasoningEffortValue.value);
  },
  { immediate: true },
);

const selectedModelLabel = computed(() => selectedModel.value ? formatModelLabel(selectedModel.value) : "选择模型");
const selectedReasoningLabel = computed(() => {
  const effort = reasoningEffortValue.value;
  return effort ? REASONING_EFFORT_SHORT_LABELS[effort] ?? effort : "";
});
const canChange = computed(() => props.connected && !props.busy && !props.inputLocked);

function selectModel(modelId: string): void {
  if (!canChange.value || !compatibleModelOptions.value.some((model) => modelKey(model) === modelId)) return;
  emit("setModel", modelId);
}

function selectReasoningEffort(effort: string): void {
  if (!canChange.value || !reasoningEffortOptions.value.includes(effort)) return;
  emit("setReasoningEffort", effort);
}

function onDocumentPointerDown(event: Event): void {
  const target = event.target;
  if (target instanceof Node && popoverRoot.value?.contains(target)) return;
  open.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div ref="popoverRoot" class="modelPopover">
    <button
      class="modelPopoverToggle"
      type="button"
      :disabled="busy || inputLocked"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="模型与推理强度"
      data-testid="chat-model-popover-toggle"
      @click.stop="open = !open"
    >
      <span class="modelPopoverIcon" aria-hidden="true">🧠</span>
      <span class="modelPopoverSummary" data-testid="chat-model-summary">
        <span class="modelPopoverModel">{{ selectedModelLabel }}</span>
        <span v-if="selectedReasoningLabel" class="modelPopoverEffort">⚡ {{ selectedReasoningLabel }}</span>
      </span>
      <svg class="modelPopoverChevron" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m5 7 5 5 5-5" />
      </svg>
    </button>

    <div
      v-show="open"
      class="modelPopoverMenu"
      role="dialog"
      aria-label="模型与推理强度设置"
      :aria-hidden="!open"
      data-testid="chat-model-popover-menu"
    >
      <section class="modelPopoverSection" aria-labelledby="model-popover-models-title">
        <div id="model-popover-models-title" class="modelPopoverSectionTitle">Models</div>
        <div v-if="compatibleModelOptions.length" class="modelPopoverOptions" role="radiogroup" aria-label="Models">
          <button
            v-for="model in compatibleModelOptions"
            :key="modelKey(model)"
            class="modelPopoverOption"
            :class="{ active: modelKey(model) === effectiveModelId }"
            type="button"
            role="radio"
            :aria-checked="modelKey(model) === effectiveModelId"
            :disabled="!canChange"
            data-testid="chat-model-option"
            :data-model-id="modelKey(model)"
            @click="selectModel(modelKey(model))"
          >
            <span class="modelPopoverOptionLabel">{{ formatModelLabel(model) }}</span>
            <span v-if="modelKey(model) === effectiveModelId" class="modelPopoverCheck" aria-hidden="true">✓</span>
          </button>
        </div>
        <div v-else class="modelPopoverEmpty">No compatible models</div>
      </section>

      <section v-if="reasoningEffortOptions.length" class="modelPopoverSection" aria-labelledby="model-popover-reasoning-title">
        <div id="model-popover-reasoning-title" class="modelPopoverSectionTitle">Reasoning effort</div>
        <div class="modelPopoverOptions" role="radiogroup" aria-label="Reasoning effort" data-testid="chat-reasoning-effort">
          <button
            v-for="effort in reasoningEffortOptions"
            :key="effort"
            class="modelPopoverOption"
            :class="{ active: effort === reasoningEffortValue }"
            type="button"
            role="radio"
            :aria-checked="effort === reasoningEffortValue"
            :aria-pressed="effort === reasoningEffortValue"
            :disabled="!canChange"
            :data-reasoning-effort="effort"
            @click="selectReasoningEffort(effort)"
          >
            <span class="modelPopoverOptionLabel">{{ REASONING_EFFORT_SHORT_LABELS[effort] ?? REASONING_EFFORT_LABELS[effort] ?? effort }}</span>
            <span v-if="effort === reasoningEffortValue" class="modelPopoverCheck" aria-hidden="true">✓</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.modelPopover {
  position: relative;
  min-width: 0;
  max-width: 100%;
}

.modelPopoverToggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: min(280px, 100%);
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 999px;
  background: rgba(248, 250, 252, 0.92);
  color: #334155;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.modelPopoverToggle:hover:not(:disabled),
.modelPopoverToggle[aria-expanded="true"] {
  border-color: rgba(37, 99, 235, 0.32);
  background: #ffffff;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
}

.modelPopoverToggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.modelPopoverToggle:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.modelPopoverIcon {
  flex: 0 0 auto;
  font-size: 14px;
  line-height: 1;
}

.modelPopoverSummary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.modelPopoverModel {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 800;
}

.modelPopoverEffort {
  flex: 0 0 auto;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
}

.modelPopoverChevron {
  flex: 0 0 auto;
  color: #64748b;
  transition: transform 0.15s ease;
}

.modelPopoverToggle[aria-expanded="true"] .modelPopoverChevron {
  transform: rotate(180deg);
}

.modelPopoverMenu {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 220;
  display: flex;
  flex-direction: column;
  width: min(340px, calc(100vw - 24px));
  max-height: min(70vh, 480px);
  overflow: auto;
  padding: 8px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.16);
}

.modelPopoverSection + .modelPopoverSection {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
}

.modelPopoverSectionTitle {
  padding: 3px 7px 6px;
  color: #64748b;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.modelPopoverOptions {
  display: grid;
  gap: 2px;
}

.modelPopoverOption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: #334155;
  text-align: left;
  cursor: pointer;
}

.modelPopoverOption:hover:not(:disabled),
.modelPopoverOption.active {
  background: rgba(37, 99, 235, 0.08);
  color: #1d4ed8;
}

.modelPopoverOption:focus-visible {
  outline: 2px solid rgba(37, 99, 235, 0.5);
  outline-offset: -2px;
}

.modelPopoverOption:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.modelPopoverOptionLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
}

.modelPopoverCheck {
  flex: 0 0 auto;
  color: #2563eb;
  font-size: 15px;
  font-weight: 900;
}

.modelPopoverEmpty {
  padding: 8px 9px;
  color: #94a3b8;
  font-size: 12px;
}

@media (max-width: 768px) {
  .modelPopoverIcon {
    display: none;
  }

  .modelPopoverToggle {
    max-width: min(230px, 100%);
    gap: 4px;
    padding-inline: 7px;
  }
}
</style>
