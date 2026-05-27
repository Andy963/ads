<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Close, Delete, Plus, Refresh } from "@element-plus/icons-vue";

import type { ApiClient } from "../api/client";
import type { ModelConfig } from "../api/types";

type AgentKind = "codex" | "claude";

type ModelForm = {
  id: string;
  modelId: string;
  displayName: string;
  agent: AgentKind;
  isEnabled: boolean;
  isDefault: boolean;
  configJsonText: string;
};

const props = defineProps<{
  api: ApiClient;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "changed"): void;
}>();

const modelConfigs = ref<ModelConfig[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const statusMessage = ref<string | null>(null);
const editingId = ref<string | null>(null);
const selectedAgent = ref<AgentKind>("codex");

const AGENT_GROUPS: Array<{ kind: AgentKind; label: string; description: string }> = [
  { kind: "codex", label: "Codex", description: "OpenAI Codex CLI 代理" },
  { kind: "claude", label: "Claude", description: "Anthropic Claude Code 代理" },
];

const emptyForm = (agent: AgentKind = "codex"): ModelForm => ({
  id: "",
  modelId: "",
  displayName: "",
  agent,
  isEnabled: true,
  isDefault: false,
  configJsonText: "{}",
});

const form = reactive<ModelForm>(emptyForm());

function assignForm(next: ModelForm): void {
  form.id = next.id;
  form.modelId = next.modelId;
  form.displayName = next.displayName;
  form.agent = next.agent;
  form.isEnabled = next.isEnabled;
  form.isDefault = next.isDefault;
  form.configJsonText = next.configJsonText;
}

function stringifyConfigJson(configJson: Record<string, unknown> | null | undefined): string {
  if (!configJson) return "{}";
  const { allowedAgents: _drop, ...rest } = configJson as Record<string, unknown>;
  if (Object.keys(rest).length === 0) return "{}";
  return JSON.stringify(rest, null, 2);
}

function parseConfigJson(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("configJson must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function normalizeModelId(value: unknown): string {
  return String(value ?? "").trim();
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

function isCodexModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("gpt-") || id.includes("codex");
}

function allowedAgents(model: ModelConfig): string[] {
  const cfg = model.configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean);
}

function resolveAgent(model: ModelConfig): AgentKind | null {
  const provider = String(model.provider ?? "").trim().toLowerCase();
  if (provider.includes("anthropic") || provider.includes("claude")) return "claude";
  if (provider.includes("openai") || provider.includes("codex")) return "codex";

  const id = normalizeModelId(model.modelId || model.id);
  if (isClaudeModelId(id)) return "claude";
  if (isCodexModelId(id)) return "codex";

  const allowed = allowedAgents(model);
  if (allowed.includes("claude")) return "claude";
  if (allowed.includes("codex")) return "codex";

  return null;
}

function providerForAgent(agent: AgentKind): string {
  return agent === "claude" ? "anthropic" : "openai";
}

const groupedModels = computed(() => {
  const buckets: Record<AgentKind, ModelConfig[]> = { codex: [], claude: [] };
  for (const model of modelConfigs.value) {
    const agent = resolveAgent(model);
    if (!agent) continue;
    buckets[agent].push(model);
  }
  for (const key of Object.keys(buckets) as AgentKind[]) {
    buckets[key].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
  }
  return buckets;
});

const isEditing = computed(() => Boolean(editingId.value));
const canSubmit = computed(() => {
  if (saving.value) return false;
  if (!form.modelId.trim()) return false;
  try {
    parseConfigJson(form.configJsonText);
    return true;
  } catch {
    return false;
  }
});

async function loadModelConfigs(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    modelConfigs.value = await props.api.get<ModelConfig[]>("/api/model-configs");
    const buckets: Record<AgentKind, number> = { codex: 0, claude: 0 };
    for (const model of modelConfigs.value) {
      const agent = resolveAgent(model);
      if (agent) buckets[agent] += 1;
    }
    if (buckets[selectedAgent.value] === 0) {
      const fallback = (Object.keys(buckets) as AgentKind[]).find((kind) => buckets[kind] > 0);
      if (fallback) selectedAgent.value = fallback;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function closeForm(): void {
  editingId.value = null;
  assignForm(emptyForm(selectedAgent.value));
  error.value = null;
  statusMessage.value = null;
}

function startCreate(agent: AgentKind): void {
  selectedAgent.value = agent;
  editingId.value = null;
  assignForm(emptyForm(agent));
  error.value = null;
  statusMessage.value = null;
}

function selectAgent(agent: AgentKind): void {
  if (selectedAgent.value === agent) return;
  selectedAgent.value = agent;
  if (!editingId.value) {
    assignForm(emptyForm(agent));
  }
  statusMessage.value = null;
}

function editModel(model: ModelConfig): void {
  const agent = resolveAgent(model) ?? "codex";
  selectedAgent.value = agent;
  editingId.value = model.id;
  assignForm({
    id: model.id,
    modelId: model.modelId || model.id,
    displayName: model.displayName,
    agent,
    isEnabled: model.isEnabled,
    isDefault: model.isDefault,
    configJsonText: stringifyConfigJson(model.configJson),
  });
  error.value = null;
  statusMessage.value = null;
}

function buildPayload(): Omit<ModelConfig, "id"> & { id?: string } {
  const parsed = parseConfigJson(form.configJsonText) ?? {};
  const { allowedAgents: _drop, ...rest } = parsed as Record<string, unknown>;
  const configJson = Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : null;
  return {
    modelId: form.modelId.trim(),
    displayName: form.displayName.trim() || form.modelId.trim(),
    provider: providerForAgent(form.agent),
    isEnabled: form.isEnabled,
    isDefault: form.isDefault,
    configJson,
  };
}

async function saveModel(): Promise<void> {
  saving.value = true;
  error.value = null;
  const wasEditing = Boolean(editingId.value);
  try {
    const payload = buildPayload();
    if (editingId.value) {
      await props.api.patch<ModelConfig>(`/api/model-configs/${encodeURIComponent(editingId.value)}`, {
        ...payload,
      });
    } else {
      await props.api.post<ModelConfig>("/api/model-configs", payload);
    }
    await loadModelConfigs();
    const savedModelId = payload.modelId;
    const saved = modelConfigs.value.find((model) => String(model.modelId ?? model.id).trim() === savedModelId);
    if (saved) {
      editModel(saved);
    }
    statusMessage.value = wasEditing ? "模型已保存" : "模型已添加";
    emit("changed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error.value = message;
  } finally {
    saving.value = false;
  }
}

async function deleteModel(model: ModelConfig): Promise<void> {
  if (model.isDefault) return;
  saving.value = true;
  error.value = null;
  try {
    await props.api.delete<{ success: boolean }>(`/api/model-configs/${encodeURIComponent(model.id)}`);
    if (editingId.value === model.id) closeForm();
    await loadModelConfigs();
    emit("changed");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void loadModelConfigs();
});
</script>

<template>
  <section class="modelManager" data-testid="model-manager">
    <header class="modelHeader" data-drag-handle>
      <div class="modelHeaderTitle">
        <div class="modelTitle">模型管理</div>
        <div class="modelSubtitle">按 Agent 分组管理 Codex / Claude 模型</div>
      </div>
      <div class="modelHeaderActions">
        <button class="modelIconBtn" type="button" title="刷新" :disabled="loading || saving" @click="loadModelConfigs">
          <el-icon :size="16" aria-hidden="true"><Refresh /></el-icon>
        </button>
        <button class="modelIconBtn" type="button" title="关闭" @click="emit('close')">
          <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
        </button>
      </div>
    </header>

    <div class="modelBody">
      <aside class="agentSidebar" aria-label="Agent 列表">
        <div class="agentSidebarHeader">Agents</div>
        <button
          v-for="group in AGENT_GROUPS"
          :key="group.kind"
          type="button"
          class="agentItem"
          :class="[`agent-${group.kind}`, { active: selectedAgent === group.kind }]"
          :data-testid="`model-manager-agent-tab-${group.kind}`"
          @click="selectAgent(group.kind)"
        >
          <span class="agentItemIcon" :class="group.kind" aria-hidden="true">
            {{ group.kind === 'claude' ? 'C' : 'G' }}
          </span>
          <span class="agentItemBody">
            <span class="agentItemName">{{ group.label }}</span>
            <span class="agentItemDesc">{{ group.description }}</span>
          </span>
          <span class="agentItemCount">{{ groupedModels[group.kind].length }}</span>
        </button>
      </aside>

      <section class="agentDetail" :class="`agent-${selectedAgent}`" aria-label="模型列表">
        <header class="agentDetailHeader">
          <div class="agentDetailTitle">
            <span class="agentItemIcon small" :class="selectedAgent" aria-hidden="true">
              {{ selectedAgent === 'claude' ? 'C' : 'G' }}
            </span>
            <span>{{ selectedAgent === 'claude' ? 'Claude' : 'Codex' }} 模型</span>
            <span class="agentDetailCount">{{ groupedModels[selectedAgent].length }} 个</span>
          </div>
          <button
            type="button"
            class="addBtn"
            :disabled="saving"
            :data-testid="`model-manager-add-${selectedAgent}`"
            @click="startCreate(selectedAgent)"
          >
            <el-icon :size="13" aria-hidden="true"><Plus /></el-icon>
            <span>新增模型</span>
          </button>
        </header>

        <div class="agentDetailBody">
          <div v-if="groupedModels[selectedAgent].length === 0" class="agentEmpty">
            还没有挂在 {{ selectedAgent === 'claude' ? 'Claude' : 'Codex' }} 下的模型，点右上角"新增模型"添加。
          </div>
          <div
            v-for="model in groupedModels[selectedAgent]"
            :key="model.id"
            class="modelRow"
            :class="{ active: editingId === model.id, disabled: !model.isEnabled }"
          >
            <button class="modelRowMain" type="button" :title="model.modelId || model.id" @click="editModel(model)">
              <span class="modelRowName">{{ model.displayName || model.id }}</span>
              <span class="modelRowMeta">
                <span v-if="model.isDefault" class="modelPill default">默认</span>
                <span v-if="!model.isEnabled" class="modelPill muted">已停用</span>
                <code>{{ model.modelId || model.id }}</code>
              </span>
            </button>
            <div class="modelRowActions">
              <button
                class="modelIconBtn danger"
                type="button"
                title="删除"
                :disabled="saving || model.isDefault"
                @click="deleteModel(model)"
              >
                <el-icon :size="14" aria-hidden="true"><Delete /></el-icon>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <form
      class="modelForm"
      :class="{ editing: isEditing }"
      @submit.prevent="saveModel"
    >
      <div class="modelFormHeader">
        <div class="modelFormTitle">
          {{ isEditing ? `编辑模型 · ${form.modelId || form.id}` : `新增 ${form.agent === 'claude' ? 'Claude' : 'Codex'} 模型` }}
        </div>
        <button v-if="isEditing" type="button" class="modelIconBtn" title="取消编辑" @click="closeForm">
          <el-icon :size="14" aria-hidden="true"><Close /></el-icon>
        </button>
      </div>

      <div class="modelFormGrid">
        <label class="modelField">
          <span class="modelLabel">Model ID</span>
          <input
            v-model="form.modelId"
            class="modelInput"
            placeholder="gpt-5.2 或 claude-sonnet-4-6"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-testid="model-manager-model-id"
          />
        </label>

        <label class="modelField">
          <span class="modelLabel">显示名（可选）</span>
          <input
            v-model="form.displayName"
            class="modelInput"
            :placeholder="form.modelId || '未填写时使用 Model ID'"
            autocomplete="off"
            data-testid="model-manager-display-name"
          />
        </label>

        <label class="modelField">
          <span class="modelLabel">Agent</span>
          <select v-model="form.agent" class="modelInput" data-testid="model-manager-agent">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>

        <div class="modelChecks">
          <label class="modelCheck">
            <input v-model="form.isEnabled" type="checkbox" />
            <span>启用</span>
          </label>
          <label class="modelCheck">
            <input v-model="form.isDefault" type="checkbox" />
            <span>默认</span>
          </label>
        </div>
      </div>

      <label class="modelField fullRow">
        <span class="modelLabel">Config JSON</span>
        <textarea
          v-model="form.configJsonText"
          class="modelTextarea"
          rows="3"
          spellcheck="false"
          data-testid="model-manager-config-json"
        />
      </label>

      <div v-if="error" class="modelError" data-testid="model-manager-error">{{ error }}</div>
      <div v-else-if="statusMessage" class="modelStatus" data-testid="model-manager-status">{{ statusMessage }}</div>

      <div class="modelActions">
        <button type="button" class="btnSecondary" :disabled="saving" @click="closeForm">
          {{ isEditing ? "取消" : "重置" }}
        </button>
        <button type="submit" class="btnPrimary" :disabled="!canSubmit" data-testid="model-manager-save">
          {{ saving ? "保存中" : "保存" }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.modelManager {
  width: 100%;
  max-height: min(680px, 86vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: white;
  border-radius: 16px;
}

.modelHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: #f8fafc;
  flex: 0 0 auto;
}

.modelHeaderTitle {
  min-width: 0;
}

.modelTitle {
  font-size: 15px;
  font-weight: 900;
  color: #0f172a;
}

.modelSubtitle {
  margin-top: 2px;
  font-size: 11px;
  color: #64748b;
}

.modelHeaderActions {
  display: flex;
  gap: 6px;
}

.modelIconBtn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.modelIconBtn:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.06);
  color: #0f172a;
}

.modelIconBtn.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
}

.modelIconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.modelBody {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  overflow: hidden;
}

.agentSidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 10px;
  border-right: 1px solid var(--border);
  background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
  overflow-y: auto;
}

.agentSidebarHeader {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.5px;
  color: #64748b;
  text-transform: uppercase;
  padding: 4px 8px 6px;
}

.agentItem {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.agentItem:hover {
  background: rgba(15, 23, 42, 0.04);
}

.agentItem.active {
  background: white;
  border-color: rgba(226, 232, 240, 0.95);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}

.agentItem.active.agent-codex {
  box-shadow: inset 3px 0 0 #2563eb, 0 1px 2px rgba(15, 23, 42, 0.05);
}

.agentItem.active.agent-claude {
  box-shadow: inset 3px 0 0 #7c3aed, 0 1px 2px rgba(15, 23, 42, 0.05);
}

.agentItemIcon {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 900;
  color: white;
  letter-spacing: 0.3px;
}

.agentItemIcon.small {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  font-size: 11px;
}

.agentItemIcon.codex {
  background: linear-gradient(135deg, #3b82f6, #1d4ed8);
}

.agentItemIcon.claude {
  background: linear-gradient(135deg, #c084fc, #7c3aed);
}

.agentItemBody {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.agentItemName {
  font-size: 13px;
  font-weight: 900;
  color: #0f172a;
}

.agentItemDesc {
  font-size: 10px;
  color: #94a3b8;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agentItemCount {
  flex: 0 0 auto;
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 900;
  color: #64748b;
  background: rgba(148, 163, 184, 0.18);
  border-radius: 999px;
  padding: 2px 8px;
}

.agentItem.active .agentItemCount {
  background: rgba(37, 99, 235, 0.12);
  color: #1d4ed8;
}

.agentItem.active.agent-claude .agentItemCount {
  background: rgba(124, 58, 237, 0.12);
  color: #6d28d9;
}

.agentDetail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: white;
}

.agentDetailHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: #fafbff;
  flex: 0 0 auto;
}

.agentDetailTitle {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 900;
  color: #0f172a;
}

.agentDetailCount {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  background: rgba(148, 163, 184, 0.16);
  border-radius: 999px;
  padding: 1px 8px;
}

.addBtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(37, 99, 235, 0.35);
  background: white;
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.addBtn:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.08);
  border-color: rgba(37, 99, 235, 0.6);
}

.addBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agentDetailBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agentEmpty {
  border: 1px dashed rgba(148, 163, 184, 0.6);
  border-radius: 10px;
  padding: 14px;
  font-size: 12px;
  color: #94a3b8;
  font-style: italic;
  text-align: center;
  background: #fafafa;
}

.modelRow {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 10px;
  background: white;
  overflow: hidden;
}

.modelRow.active {
  border-color: rgba(37, 99, 235, 0.55);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.modelRow.disabled {
  opacity: 0.7;
}

.modelRowMain {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 9px 0 9px 12px;
  text-align: left;
  cursor: pointer;
}

.modelRowName {
  display: block;
  font-size: 13px;
  font-weight: 800;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelRowMeta {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: #64748b;
  font-size: 11px;
}

.modelRowMeta code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.modelPill {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 900;
}

.modelPill.default {
  background: rgba(16, 185, 129, 0.14);
  color: #047857;
}

.modelPill.muted {
  background: rgba(100, 116, 139, 0.14);
  color: #64748b;
}

.modelRowActions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
}

.modelForm {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  background: #f8fafc;
  min-height: 0;
  max-height: min(480px, 60vh);
  overflow-y: auto;
}



.modelFormHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modelFormTitle {
  font-size: 13px;
  font-weight: 900;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelFormGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.modelField {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modelField.fullRow {
  grid-column: 1 / -1;
}

.modelLabel {
  font-size: 11px;
  font-weight: 800;
  color: #334155;
  letter-spacing: 0.2px;
}

.modelInput,
.modelTextarea {
  width: 100%;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: white;
  color: #0f172a;
  font-size: 13px;
  box-sizing: border-box;
}

.modelInput {
  height: 32px;
  padding: 0 10px;
}

.modelTextarea {
  resize: vertical;
  min-height: 70px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1.45;
}

.modelInput:focus,
.modelTextarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.65);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.modelInput:disabled {
  cursor: not-allowed;
  background: #f1f5f9;
  color: #64748b;
}

.modelChecks {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-top: 18px;
}

.modelCheck {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #334155;
  white-space: nowrap;
  cursor: pointer;
}

.modelError {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 700;
}

.modelStatus {
  border: 1px solid rgba(16, 185, 129, 0.26);
  background: rgba(16, 185, 129, 0.08);
  color: #047857;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 800;
}

.modelActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  position: sticky;
  bottom: -14px;
  padding: 8px 0 0;
  margin-top: -2px;
  background: linear-gradient(to bottom, rgba(248, 250, 252, 0) 0%, #f8fafc 40%);
}

.btnSecondary,
.btnPrimary {
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  border: 1px solid rgba(226, 232, 240, 0.9);
}

.btnSecondary {
  background: white;
  color: #0f172a;
}

.btnPrimary {
  border-color: rgba(37, 99, 235, 0.25);
  background: #2563eb;
  color: white;
}

.btnPrimary:disabled,
.btnSecondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .modelBody {
    grid-template-columns: 1fr;
  }

  .agentSidebar {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 8px;
  }

  .agentSidebarHeader {
    display: none;
  }

  .agentItem {
    flex: 0 0 auto;
  }

  .modelFormGrid {
    grid-template-columns: 1fr;
  }

  .modelChecks {
    padding-top: 0;
  }
}
</style>
