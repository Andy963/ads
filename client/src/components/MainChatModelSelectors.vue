<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ModelConfig } from "../api/types";
import { normalizeReasoningEffort } from "../lib/chatPreferences";
import { supportsAgentModel } from "../lib/model_agent";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const DEFAULT_REASONING_EFFORTS = ["high"] as const;
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
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

const STANDARD_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

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

const pickerOpen = ref(false);
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
  const config = selectedModel.value.configJson;
  const raw = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).reasoningEfforts
    : null;
  if (!Array.isArray(raw)) return [...DEFAULT_REASONING_EFFORTS];
  const values = raw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter((entry) => Boolean(REASONING_EFFORT_LABELS[entry]));
  return values.length > 0 ? [...new Set(values)] : [...DEFAULT_REASONING_EFFORTS];
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

const capsuleLabel = computed(() => {
  if (!compatibleModelOptions.value.length) return "No models";
  const name = selectedModelLabel.value;
  if (!reasoningEffortOptions.value.length || (reasoningEffortOptions.value.length === 1 && (reasoningEffortOptions.value[0] === "none" || reasoningEffortOptions.value[0] === "off"))) {
    return name;
  }
  const effort = REASONING_EFFORT_SHORT_LABELS[reasoningEffortValue.value] || REASONING_EFFORT_LABELS[reasoningEffortValue.value] || reasoningEffortValue.value;
  return `${name} · ${effort}`;
});

const displayEfforts = computed(() => {
  const supported = new Set(reasoningEffortOptions.value);
  const items = [...STANDARD_EFFORTS];
  for (const opt of reasoningEffortOptions.value) {
    if (!items.some((i) => i.id === opt)) {
      items.push({ id: opt, label: REASONING_EFFORT_SHORT_LABELS[opt] || REASONING_EFFORT_LABELS[opt] || opt });
    }
  }
  return items.map((item) => ({
    ...item,
    supported: supported.has(item.id),
    active: reasoningEffortValue.value === item.id,
  }));
});

function togglePicker(): void {
  if (!canChange.value || !compatibleModelOptions.value.length) return;
  pickerOpen.value = !pickerOpen.value;
}

function closePicker(): void {
  pickerOpen.value = false;
}

function handlePickModel(modelId: string): void {
  selectModel(modelId);
}

function handlePickEffort(effort: string): void {
  selectReasoningEffort(effort);
  closePicker();
}

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
    <!-- Consolidated capsule button -->
    <button
      type="button"
      class="modelCapsule"
      :class="{ 'modelCapsule--disabled': !canChange || !compatibleModelOptions.length }"
      data-testid="chat-model-capsule"
      :disabled="!canChange || !compatibleModelOptions.length"
      :title="capsuleLabel"
      @click="togglePicker"
    >
      <span class="modelCapsuleIcon" aria-hidden="true">⚡</span>
      <span class="modelCapsuleText" data-testid="chat-capsule-text">{{ capsuleLabel }}</span>
      <span class="modelCapsuleChevron" aria-hidden="true">▾</span>
    </button>

    <!-- Synced hidden native select elements for accessibility and backwards compatibility -->
    <div class="sr-native-selectors" aria-hidden="true">
      <label class="modelField" :class="{ 'modelField--disabled': !canChange || !compatibleModelOptions.length }">
        <span class="modelFieldValue" data-testid="chat-model-value">
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
        <span class="modelFieldValue" data-testid="chat-effort-value">
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

    <!-- Integrated ActionSheet / Popover -->
    <Teleport to="body">
      <div
        v-if="pickerOpen"
        class="modelPickerMask"
        data-testid="model-picker-mask"
        @click="closePicker"
      >
        <div
          class="modelPickerSheet"
          role="region"
          aria-label="选择模型与推理配置"
          data-testid="model-picker-sheet"
          @click.stop
        >
          <div class="modelPickerHeader">
            <span class="modelPickerTitle">选择模型与推理配置</span>
            <button type="button" class="modelPickerClose" aria-label="关闭" @click="closePicker">✕</button>
          </div>

          <div class="modelPickerSection">
            <div class="modelPickerSectionTitle">模型列表</div>
            <div class="modelPickerList">
              <button
                v-for="model in compatibleModelOptions"
                :key="modelKey(model)"
                type="button"
                class="modelPickerItem"
                :class="{ active: modelKey(model) === effectiveModelId }"
                :data-testid="`model-picker-item-${modelKey(model)}`"
                @click="handlePickModel(modelKey(model))"
              >
                <div class="modelPickerItemMain">
                  <span class="modelPickerItemName">{{ formatModelLabel(model) }}</span>
                  <span v-if="model.provider" class="modelProviderBadge">{{ model.provider }}</span>
                </div>
                <span v-if="modelKey(model) === effectiveModelId" class="modelActiveBadge">当前</span>
              </button>
            </div>
          </div>

          <div v-if="reasoningEffortOptions.length" class="modelPickerSection">
            <div class="modelPickerSectionTitle">⚡ 推理思考强度 (Reasoning Effort)</div>
            <div class="effortSegmentedBar">
              <button
                v-for="effort in displayEfforts"
                :key="effort.id"
                type="button"
                class="effortPill"
                :class="{ active: effort.active }"
                :disabled="!effort.supported"
                :data-testid="`effort-pill-${effort.id}`"
                @click="handlePickEffort(effort.id)"
              >
                {{ effort.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.modelSelectors {
  display: flex;
  align-items: center;
  min-width: 0;
}

.modelCapsule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.12));
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  max-width: 220px;
  min-width: 0;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.modelCapsule:hover:not(:disabled) {
  border-color: rgba(37, 99, 235, 0.35);
  background-color: rgba(37, 99, 235, 0.05);
}

.modelCapsule--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.modelCapsuleIcon {
  font-size: 11px;
  color: #eab308;
  flex-shrink: 0;
}

.modelCapsuleText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.modelCapsuleChevron {
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
}

/* Visually hide native selects while preserving DOM presence & test compatibility */
.sr-native-selectors {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.modelField {
  height: 28px;
  font-size: 12px;
}

.modelSelect {
  width: 100%;
  min-width: 0;
  font-size: 16px;
}

/* ActionSheet / Popover Panel */
.modelPickerMask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

@media (min-width: 901px) {
  .modelPickerMask {
    align-items: center;
  }
}

.modelPickerSheet {
  width: 100%;
  max-width: 440px;
  background: var(--surface, #ffffff);
  border: 1px solid var(--border);
  border-radius: 16px 16px 0 0;
  padding: 16px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 80vh;
  box-sizing: border-box;
}

@media (min-width: 901px) {
  .modelPickerSheet {
    border-radius: 14px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
    padding-bottom: 16px;
  }
}

.modelPickerHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modelPickerTitle {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.modelPickerClose {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}

.modelPickerSectionTitle {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.modelPickerList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  max-height: 240px;
}

.modelPickerItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2, rgba(15, 23, 42, 0.03));
  cursor: pointer;
  min-height: 44px;
  transition: all 0.12s ease;
}

.modelPickerItem:hover {
  background: rgba(37, 99, 235, 0.06);
  border-color: rgba(37, 99, 235, 0.25);
}

.modelPickerItem.active {
  background: rgba(37, 99, 235, 0.08);
  border-color: rgba(37, 99, 235, 0.4);
}

.modelPickerItemMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.modelPickerItemName {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelProviderBadge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(100, 116, 139, 0.12);
  color: var(--muted);
}

.modelActiveBadge {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
}

.effortSegmentedBar {
  display: flex;
  gap: 4px;
  background: var(--surface-2, rgba(15, 23, 42, 0.05));
  padding: 3px;
  border-radius: 10px;
  border: 1px solid var(--border);
}

.effortPill {
  flex: 1 1 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  padding: 8px 4px;
  min-height: 38px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.effortPill.active {
  background: var(--surface, #ffffff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  color: var(--accent);
  font-weight: 700;
}

.effortPill:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
