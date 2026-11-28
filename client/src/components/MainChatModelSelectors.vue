<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ModelConfig } from "../api/types";
import { normalizeReasoningEffort } from "../lib/chatPreferences";
import { supportsAgentModel } from "../lib/model_agent";
import SettingsSheet from "./SettingsSheet.vue";
import ReasoningEffortSlider from "./ReasoningEffortSlider.vue";

type AgentOption = {
  id: string;
  name: string;
  ready: boolean;
  error?: string;
  accountEmail?: string | null;
  tier?: string | null;
};

const DEFAULT_REASONING_EFFORTS = ["medium", "high"] as const;
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
  (e: "pickerClose"): void;
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
  return normalizeModelId(model.id);
}

function modelKeyOrEmpty(model: ModelConfig | null): string {
  return model ? modelKey(model) : "";
}

function formatModelLabel(model: ModelConfig): string {
  return String(model.displayName ?? "").trim() || String(model.modelId ?? "").trim() || "Model";
}

function isAgyAgentId(agentId: string): boolean {
  return agentId === "agy" || agentId.startsWith("agy:");
}

function runtimeBadgeLabel(agent: AgentOption | null): string {
  if (!agent) return "";
  return isAgyAgentId(agent.id) ? "Antigravity" : agent.name;
}

function agyAccountTitle(agent: AgentOption): string {
  const email = typeof agent.accountEmail === "string" ? agent.accountEmail.trim() : "";
  if (email) return email;
  if (agent.id === "agy") return "Host default";
  return agent.name || "Antigravity account";
}

function formatReadyAgentDetail(agent: AgentOption): string {
  const email = typeof agent.accountEmail === "string" ? agent.accountEmail.trim() : "";
  return email ? `${email} · ${agent.id}` : agent.id;
}

const agyAgents = computed(() => agentOptions.value.filter((agent) => isAgyAgentId(agent.id)));
const nonAgyAgents = computed(() => agentOptions.value.filter((agent) => !isAgyAgentId(agent.id)));
const hasMultipleAgyAccounts = computed(() => agyAgents.value.length > 1);
const readyAgyAgents = computed(() => agyAgents.value.filter((agent) => Boolean(agent.ready)));
const isAgySelected = computed(() => isAgyAgentId(selectedAgentId.value));
const preferredReadyAgy = computed(() => {
  const active = agyAgents.value.find((agent) => agent.id === selectedAgentId.value && agent.ready);
  return active ?? readyAgyAgents.value[0] ?? null;
});
const agyRuntimeDetail = computed(() => {
  if (!readyAgyAgents.value.length) {
    return agyAgents.value[0]?.error || "Unavailable";
  }
  const active = activeAgent.value;
  if (isAgySelected.value && active && active.ready) {
    const email = typeof active.accountEmail === "string" ? active.accountEmail.trim() : "";
    return email
      ? `${email} · ${readyAgyAgents.value.length}/${agyAgents.value.length} ready`
      : `${readyAgyAgents.value.length} of ${agyAgents.value.length} accounts ready`;
  }
  return `${readyAgyAgents.value.length} of ${agyAgents.value.length} accounts ready`;
});

function selectAgyRuntime(): void {
  if (!canChange.value || isAgySelected.value) return;
  const target = preferredReadyAgy.value;
  if (target) selectAgent(target.id);
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
  if (!isUnsetModelId(current) && options.some((model) => modelKey(model) === current)) return current;
  const legacy = options.filter((model) => model.modelId === current);
  if (legacy.length === 1) return modelKey(legacy[0]);
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
    const desired = effectiveModelId.value;
    if (!desired) return;
    const current = normalizeModelId(props.modelId);
    if (options.some((model) => modelKey(model) === current)) return;
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
  const order = Object.keys(REASONING_EFFORT_LABELS);
  return values.length > 0 ? [...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b)) : [...DEFAULT_REASONING_EFFORTS];
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
const activeAgent = computed(() =>
  agentOptions.value.find((agent) => String(agent?.id ?? "").trim() === selectedAgentId.value) ?? null,
);
const hasMultipleAgents = computed(() => agentOptions.value.length > 1);
const canChange = computed(() => props.connected && !props.busy && !props.inputLocked);
const canOpenPicker = computed(() =>
  canChange.value && (compatibleModelOptions.value.length > 0 || hasMultipleAgents.value),
);

const capsuleLabel = computed(() => {
  const agentPrefix = hasMultipleAgents.value && activeAgent.value ? `${runtimeBadgeLabel(activeAgent.value)} · ` : "";
  if (!compatibleModelOptions.value.length) return `${agentPrefix}No models`;
  const name = selectedModelLabel.value;
  if (!reasoningEffortOptions.value.length || (reasoningEffortOptions.value.length === 1 && (reasoningEffortOptions.value[0] === "none" || reasoningEffortOptions.value[0] === "off"))) {
    return `${agentPrefix}${name}`;
  }
  const effort = REASONING_EFFORT_SHORT_LABELS[reasoningEffortValue.value] || REASONING_EFFORT_LABELS[reasoningEffortValue.value] || reasoningEffortValue.value;
  return `${agentPrefix}${name} · ${effort}`;
});

const displayEfforts = computed(() => reasoningEffortOptions.value.map(id => ({
  id, label: REASONING_EFFORT_LABELS[id] || id,
})));

function togglePicker(): void {
  if (!canOpenPicker.value) return;
  pickerOpen.value = !pickerOpen.value;
  if (!pickerOpen.value) emit("pickerClose");
}

function closePicker(): void {
  pickerOpen.value = false;
  emit("pickerClose");
}

function selectAgent(agentId: string): void {
  if (!canChange.value || !readyAgentIds.value.includes(agentId)) return;
  if (agentId === selectedAgentId.value) return;
  emit("switchAgent", agentId);
}

function selectModel(modelId: string): void {
  if (!canChange.value || !compatibleModelOptions.value.some((model) => modelKey(model) === modelId)) return;
  emit("setModel", modelId);
}

function selectReasoningEffort(effort: string): void {
  if (!canChange.value || !reasoningEffortOptions.value.includes(effort)) return;
  emit("setReasoningEffort", effort);
}

function openPicker(): void {
  if (!canOpenPicker.value) return;
  pickerOpen.value = true;
}

defineExpose({
  openPicker,
  closePicker,
  togglePicker,
  pickerOpen,
  selectedModelLabel,
  reasoningEffortValue,
  capsuleLabel,
  canChange,
  compatibleModelOptions,
  selectedAgentId,
});
</script>

<template>
  <div class="modelSelectors" role="group" aria-label="Model settings">
    <!-- Consolidated capsule button -->
    <button
      type="button"
      class="modelCapsule"
      :class="{ 'modelCapsule--disabled': !canOpenPicker }"
      data-testid="chat-model-capsule"
      :disabled="!canOpenPicker"
      :title="capsuleLabel"
      @click="togglePicker"
    >
      <span v-if="hasMultipleAgents && activeAgent" class="modelCapsuleAgent" data-testid="chat-capsule-agent">{{ runtimeBadgeLabel(activeAgent) }}</span>
      <span class="modelCapsuleText" data-testid="chat-capsule-text">{{ compatibleModelOptions.length ? selectedModelLabel : "No models" }}</span>
      <span v-if="compatibleModelOptions.length" class="modelCapsuleEffort" data-testid="chat-capsule-effort">{{ REASONING_EFFORT_SHORT_LABELS[reasoningEffortValue] || reasoningEffortValue }}</span>
      <span class="modelCapsuleChevron" aria-hidden="true">▾</span>
    </button>

    <!-- Legacy programmatic controls stay out of keyboard and screen-reader navigation. -->
    <div class="sr-native-selectors" aria-hidden="true">
      <label class="modelField" :class="{ 'modelField--disabled': !canChange || !compatibleModelOptions.length }">
        <span class="modelFieldValue" data-testid="chat-model-value">
          {{ compatibleModelOptions.length ? selectedModelLabel : "No models" }}
        </span>
        <select
          class="modelSelect"
          tabindex="-1"
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
          tabindex="-1"
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

    <SettingsSheet
      v-if="pickerOpen"
      title="Model & reasoning"
      action-label="Done"
      action-test-id="model-picker-done"
      close-label=""
      test-id="model-picker-sheet"
      @close="closePicker"
      @submit="closePicker"
    >
      <div v-if="hasMultipleAgents" class="settingsBlock" data-testid="agent-picker-section">
        <h2 class="settingsBlockTitle">Runtime</h2>
        <div class="settingsList">
          <button
            v-for="agent in nonAgyAgents"
            :key="agent.id"
            type="button"
            class="settingsRow"
            :aria-pressed="agent.id === selectedAgentId"
            :disabled="!canChange || !agent.ready"
            :data-testid="`agent-picker-item-${agent.id}`"
            @click="selectAgent(agent.id)"
          >
            <span class="settingsRowContent">
              <span>
                {{ agent.name }}
                <small
                  v-if="agent.ready && agent.tier"
                  class="agentTierBadge"
                  :data-testid="`agent-picker-tier-${agent.id}`"
                >{{ agent.tier }}</small>
              </span>
              <small v-if="!agent.ready" class="settingsDetail">{{ agent.error || 'Unavailable' }}</small>
              <small v-else class="settingsDetail" :data-testid="`agent-picker-detail-${agent.id}`">{{ formatReadyAgentDetail(agent) }}</small>
            </span>
            <span class="settingsCheckmark" aria-hidden="true">{{ agent.id === selectedAgentId ? '✓' : '' }}</span>
          </button>
          <button
            v-if="agyAgents.length === 1"
            type="button"
            class="settingsRow"
            :aria-pressed="agyAgents[0].id === selectedAgentId"
            :disabled="!canChange || !agyAgents[0].ready"
            :data-testid="`agent-picker-item-${agyAgents[0].id}`"
            @click="selectAgent(agyAgents[0].id)"
          >
            <span class="settingsRowContent">
              <span>
                Antigravity
                <small
                  v-if="agyAgents[0].ready && agyAgents[0].tier"
                  class="agentTierBadge"
                  :data-testid="`agent-picker-tier-${agyAgents[0].id}`"
                >{{ agyAgents[0].tier }}</small>
              </span>
              <small v-if="!agyAgents[0].ready" class="settingsDetail">{{ agyAgents[0].error || 'Unavailable' }}</small>
              <small v-else class="settingsDetail" :data-testid="`agent-picker-detail-${agyAgents[0].id}`">{{ formatReadyAgentDetail(agyAgents[0]) }}</small>
            </span>
            <span class="settingsCheckmark" aria-hidden="true">{{ agyAgents[0].id === selectedAgentId ? '✓' : '' }}</span>
          </button>
          <button
            v-else-if="hasMultipleAgyAccounts"
            type="button"
            class="settingsRow"
            :aria-pressed="isAgySelected"
            :disabled="!canChange || !readyAgyAgents.length"
            data-testid="agent-picker-runtime-agy"
            @click="selectAgyRuntime"
          >
            <span class="settingsRowContent">
              <span>
                Antigravity
                <small
                  v-if="isAgySelected && activeAgent?.ready && activeAgent?.tier"
                  class="agentTierBadge"
                >{{ activeAgent.tier }}</small>
              </span>
              <small class="settingsDetail">{{ agyRuntimeDetail }}</small>
            </span>
            <span class="settingsCheckmark" aria-hidden="true">{{ isAgySelected ? '✓' : '' }}</span>
          </button>
        </div>
      </div>
      <div v-if="hasMultipleAgyAccounts" class="settingsBlock" data-testid="agy-account-picker-section">
        <h2 class="settingsBlockTitle">Antigravity account</h2>
        <div class="settingsList">
          <button
            v-for="agent in agyAgents"
            :key="agent.id"
            type="button"
            class="settingsRow"
            :aria-pressed="agent.id === selectedAgentId"
            :disabled="!canChange || !agent.ready"
            :data-testid="`agent-picker-item-${agent.id}`"
            @click="selectAgent(agent.id)"
          >
            <span class="settingsRowContent">
              <span>
                {{ agyAccountTitle(agent) }}
                <small v-if="agent.id === 'agy' && agent.accountEmail" class="accountTag">Host default</small>
                <small
                  v-if="agent.ready && agent.tier"
                  class="agentTierBadge"
                  :data-testid="`agent-picker-tier-${agent.id}`"
                >{{ agent.tier }}</small>
              </span>
              <small v-if="!agent.ready" class="settingsDetail">{{ agent.error || 'Unavailable' }}</small>
              <small v-else class="settingsDetail" :data-testid="`agent-picker-detail-${agent.id}`">{{ formatReadyAgentDetail(agent) }}</small>
            </span>
            <span class="settingsCheckmark" aria-hidden="true">{{ agent.id === selectedAgentId ? '✓' : '' }}</span>
          </button>
        </div>
      </div>
      <div class="settingsBlock">
        <h2 class="settingsBlockTitle">Conversation models</h2>
        <div class="settingsList">
          <button v-for="model in compatibleModelOptions" :key="modelKey(model)" type="button" class="settingsRow"
            :aria-pressed="modelKey(model) === effectiveModelId" :disabled="!canChange"
            :data-testid="`model-picker-item-${modelKey(model)}`" @click="selectModel(modelKey(model))">
            <span class="settingsRowContent"><span>{{ formatModelLabel(model) }}</span><small class="settingsDetail">{{ model.provider }}</small></span>
            <span class="settingsCheckmark" aria-hidden="true">{{ modelKey(model) === effectiveModelId ? '✓' : '' }}</span>
          </button>
        </div>
        <p v-if="!compatibleModelOptions.length" class="settingsNote">Enable conversation models in Models → Chat first.</p>
      </div>
      <div v-if="selectedModel" class="settingsBlock">
        <div class="settingsList">
          <ReasoningEffortSlider :options="displayEfforts" :model-value="reasoningEffortValue" :disabled="!canChange" @change="selectReasoningEffort" />
        </div>
        <p class="settingsNote">{{ reasoningEffortOptions.length > 1 ? 'Slide to a configured level. Release to apply.' : 'This model has one configured reasoning level.' }}</p>
      </div>
    </SettingsSheet>
  </div>
</template>

<style scoped>
.modelSelectors {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}

/* Keep the selector visually attached to the lane surface while giving it
   enough contrast to read as an interactive control. */
.modelCapsule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.42);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
  width: 100%;
  min-width: 0;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, transform 0.12s ease;
  white-space: nowrap;
}

/* Cap the model segment to roughly one lane tab on wide viewports. The label
   is a user-editable alias, so the cap is a fixed length, never derived from
   the text; on narrow viewports the pill splits the space naturally. */
@media (min-width: 901px) {
  .modelCapsule {
    max-width: 100%;
  }
}

.modelCapsuleAgent {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.07);
  color: var(--text);
}

.accountTag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(15, 23, 42, 0.06);
  color: var(--settings-secondary, #64748b);
}

.agentTierBadge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(0, 122, 255, 0.12);
  color: var(--settings-tint, #007aff);
}

.modelCapsuleEffort { flex: 0 0 auto; font-size: 11px; opacity: .8; }

.modelCapsule:hover:not(:disabled) {
  border-color: rgba(15, 23, 42, 0.12);
  background-color: var(--surface);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 1px 2px rgba(15, 23, 42, 0.06);
}

.modelCapsule:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.modelCapsule:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.18), 0 1px 3px rgba(15, 23, 42, 0.12);
}

.modelCapsule--disabled {
  opacity: 0.55;
  cursor: not-allowed;
  background: transparent;
  box-shadow: none;
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

</style>
