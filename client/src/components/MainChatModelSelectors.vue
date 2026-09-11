<script setup lang="ts">
import { computed, ref, watch } from "vue";

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
  minimal: "Min",
  medium: "Med",
  xhigh: "XHigh",
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

const selectedModelLabel = computed(() => selectedModel.value ? formatModelLabel(selectedModel.value) : effectiveModelId.value || "Model");
const canChange = computed(() => props.connected && !props.busy && !props.inputLocked);

function selectModel(modelId: string): void {
  if (!canChange.value || !compatibleModelOptions.value.some((model) => modelKey(model) === modelId)) return;
  emit("setModel", modelId);
}

function selectReasoningEffort(effort: string): void {
  if (!canChange.value || !reasoningEffortOptions.value.includes(effort)) return;
  emit("setReasoningEffort", effort);
}
</script>

<template>
  <div class="modelSelectors" role="group" aria-label="Model settings">
    <label class="modelField" :class="{ 'modelField--disabled': !canChange || !compatibleModelOptions.length }">
      <span class="modelFieldValue" aria-hidden="true" data-testid="chat-model-value">
        {{ compatibleModelOptions.length ? selectedModelLabel : "No models" }}
      </span>
      <select
        class="modelSelect"
        aria-label="Model"
        :title="selectedModelLabel"
        data-testid="chat-model-select"
        :value="effectiveModelId"
        :disabled="!canChange || !compatibleModelOptions.length"
        @change="selectModel(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!compatibleModelOptions.length" value="" disabled>No models</option>
        <option v-else-if="!selectedModel && effectiveModelId" :value="effectiveModelId" disabled>{{ effectiveModelId }}</option>
        <option
          v-for="model in compatibleModelOptions"
          :key="modelKey(model)"
          :value="modelKey(model)"
          data-testid="chat-model-option"
          :data-model-id="modelKey(model)"
        >{{ formatModelLabel(model) }}</option>
      </select>
    </label>
    <label class="modelField" :class="{ 'modelField--disabled': !canChange || !reasoningEffortOptions.length }">
      <span class="modelFieldValue" aria-hidden="true" data-testid="chat-effort-value">
        {{ REASONING_EFFORT_SHORT_LABELS[reasoningEffortValue] || REASONING_EFFORT_LABELS[reasoningEffortValue] || "Effort" }}
      </span>
      <select
        class="modelSelect"
        aria-label="Reasoning effort"
        :title="REASONING_EFFORT_LABELS[reasoningEffortValue] || 'Reasoning effort'"
        data-testid="chat-reasoning-effort"
        :value="reasoningEffortValue"
        :disabled="!canChange || !reasoningEffortOptions.length"
        @change="selectReasoningEffort(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!reasoningEffortOptions.length" value="" disabled>Effort</option>
        <option
          v-for="effort in reasoningEffortOptions"
          :key="effort"
          :value="effort"
          :aria-label="REASONING_EFFORT_LABELS[effort]"
          :data-reasoning-effort="effort"
        >{{ REASONING_EFFORT_SHORT_LABELS[effort] ?? REASONING_EFFORT_LABELS[effort] ?? effort }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.modelSelectors {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 60px);
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.modelField {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  height: 26px;
  box-sizing: border-box;
  padding: 3px 18px 3px 6px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 999px;
  background-color: rgba(248, 250, 252, 0.98);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 20 20' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m5 7 5 5 5-5'/%3E%3C/svg%3E");
  background-position: right 5px center;
  background-repeat: no-repeat;
  color: #334155;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

.modelFieldValue {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelField--disabled {
  opacity: 0.55;
}

.modelField:hover:not(.modelField--disabled) {
  border-color: rgba(59, 130, 246, 0.35);
  background-color: rgba(239, 246, 255, 0.98);
}

.modelField:focus-within {
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.modelSelect {
  position: absolute;
  inset: 0;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  opacity: 0;
  /* Retain native keyboard/picker behavior without mobile focus zoom. */
  font-size: 16px;
  cursor: pointer;
}

.modelSelect:disabled {
  cursor: not-allowed;
}
</style>
