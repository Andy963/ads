<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Close, EditPen, Plus, Refresh, StarFilled } from "@element-plus/icons-vue";

import type { ApiClient } from "../api/client";
import type { ModelConfig } from "../api/types";

type ModelForm = {
  id: string;
  modelId: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJsonText: string;
};

const props = withDefaults(
  defineProps<{
    api: ApiClient;
    agent?: string | null;
    showHeader?: boolean;
  }>(),
  {
    showHeader: true,
  },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "changed"): void;
}>();

const modelConfigs = ref<ModelConfig[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyRowId = ref<string | null>(null);
const error = ref<string | null>(null);
const statusMessage = ref<string | null>(null);
const editingId = ref<string | null>(null);
const dialogOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const selectedModelId = ref<string | null>(null);

const emptyForm = (): ModelForm => ({
  id: "",
  modelId: "",
  displayName: "",
  provider: "openai",
  isEnabled: true,
  isDefault: false,
  configJsonText: "{}",
});

const form = reactive<ModelForm>(emptyForm());

function assignForm(next: ModelForm): void {
  form.id = next.id;
  form.modelId = next.modelId;
  form.displayName = next.displayName;
  form.provider = next.provider;
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

function modelLabel(model: ModelConfig): string {
  return String(model.displayName ?? "").trim() || String(model.modelId ?? model.id ?? "").trim();
}

const sortedModels = computed(() => {
  return [...modelConfigs.value].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
    return modelLabel(a).localeCompare(modelLabel(b));
  });
});

const enabledCount = computed(() => modelConfigs.value.filter((m) => m.isEnabled).length);
const busy = computed(() => saving.value || loading.value || busyRowId.value !== null);
const isEditing = computed(() => Boolean(editingId.value));
const managerTitle = computed(() => (props.agent ? "模型" : "模型管理"));
const editingCurrentDefault = computed(
  () => Boolean(editingId.value) && modelConfigs.value.some((model) => model.id === editingId.value && model.isDefault),
);
const configJsonError = computed(() => {
  try {
    parseConfigJson(form.configJsonText);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});
const canSubmit = computed(() => {
  if (saving.value) return false;
  if (!form.modelId.trim()) return false;
  return configJsonError.value === null;
});

async function loadModelConfigs(): Promise<void> {
  loading.value = true;
  error.value = null;
  pendingDeleteId.value = null;
  selectedModelId.value = null;
  try {
    modelConfigs.value = await props.api.get<ModelConfig[]>("/api/model-configs");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function closeDialog(): void {
  editingId.value = null;
  dialogOpen.value = false;
  assignForm(emptyForm());
  error.value = null;
  selectedModelId.value = null;
}

function startCreate(): void {
  editingId.value = null;
  dialogOpen.value = true;
  pendingDeleteId.value = null;
  selectedModelId.value = null;
  assignForm(emptyForm());
  error.value = null;
  statusMessage.value = null;
}

function editModel(model: ModelConfig): void {
  editingId.value = model.id;
  selectedModelId.value = model.id;
  dialogOpen.value = true;
  pendingDeleteId.value = null;
  assignForm({
    id: model.id,
    modelId: model.modelId || model.id,
    displayName: model.displayName,
    provider: model.provider || "openai",
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
  const configJson: Record<string, unknown> = {
    ...rest,
    allowedAgents: ["codex"],
  };
  return {
    modelId: form.modelId.trim(),
    displayName: form.displayName.trim() || form.modelId.trim(),
    provider: form.provider.trim() || "openai",
    isEnabled: form.isEnabled,
    isDefault: form.isDefault,
    configJson,
  };
}

async function saveModel(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = null;
  const wasEditing = Boolean(editingId.value);
  try {
    const payload = buildPayload();
    if (editingId.value) {
      await props.api.patch<ModelConfig>(`/api/model-configs/` + encodeURIComponent(editingId.value), {
        ...payload,
      });
    } else {
      await props.api.post<ModelConfig>("/api/model-configs", payload);
    }
    await loadModelConfigs();
    editingId.value = null;
    dialogOpen.value = false;
    assignForm(emptyForm());
    statusMessage.value = wasEditing ? "模型已保存" : "模型已添加";
    emit("changed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error.value = message;
  } finally {
    saving.value = false;
  }
}

async function patchModel(
  model: ModelConfig,
  patch: Partial<Pick<ModelConfig, "isEnabled" | "isDefault">>,
  successMessage: string,
): Promise<void> {
  if (busy.value) return;
  busyRowId.value = model.id;
  error.value = null;
  statusMessage.value = null;
  try {
    await props.api.patch<ModelConfig>(`/api/model-configs/${encodeURIComponent(model.id)}`, patch);
    await loadModelConfigs();
    statusMessage.value = successMessage;
    emit("changed");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busyRowId.value = null;
  }
}

function setDefaultModel(model: ModelConfig): void {
  if (model.isDefault) return;
  void patchModel(model, { isDefault: true }, `已将 ${modelLabel(model)} 设为默认模型`);
}

function toggleEnabled(model: ModelConfig): void {
  const next = !model.isEnabled;
  if (!next && model.isDefault) {
    error.value = "默认模型不能停用，请先把默认设到其他模型上。";
    return;
  }
  void patchModel(model, { isEnabled: next }, next ? `已启用 ${modelLabel(model)}` : `已停用 ${modelLabel(model)}`);
}

function selectModel(model: ModelConfig): void {
  selectedModelId.value = selectedModelId.value === model.id ? null : model.id;
}

function requestDelete(model: ModelConfig): void {
  if (model.isDefault || busy.value) return;
  pendingDeleteId.value = model.id;
  selectedModelId.value = model.id;
  statusMessage.value = null;
  error.value = null;
}

function cancelDelete(): void {
  pendingDeleteId.value = null;
}

async function deleteModel(model: ModelConfig): Promise<void> {
  if (model.isDefault || saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await props.api.delete<{ success: boolean }>(`/api/model-configs/${encodeURIComponent(model.id)}`);
    if (editingId.value === model.id) closeDialog();
    await loadModelConfigs();
    pendingDeleteId.value = null;
    selectedModelId.value = null;
    statusMessage.value = "模型已删除";
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

defineExpose({
  refresh: loadModelConfigs,
  create: () => startCreate(),
});
</script>

<template>
  <section class="modelManager" data-testid="model-manager">
    <header v-if="showHeader" class="modelHeader" data-drag-handle>
      <div class="modelHeaderTitle">
        <div class="modelTitle">{{ managerTitle }}</div>
        <div class="modelSubtitle">统一 Codex 引擎；保存后输入框下拉会立即刷新。</div>
      </div>
      <div class="modelHeaderActions">
        <button
          type="button"
          class="addBtn"
          :disabled="busy"
          data-testid="model-manager-add"
          @click="startCreate"
        >
          <el-icon :size="13" aria-hidden="true"><Plus /></el-icon>
          <span>新增模型</span>
        </button>
        <button class="modelIconBtn" type="button" title="刷新" :disabled="busy" @click="loadModelConfigs">
          <el-icon :size="16" aria-hidden="true"><Refresh /></el-icon>
        </button>
        <button class="modelIconBtn" type="button" title="关闭" @click="emit('close')">
          <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
        </button>
      </div>
    </header>

    <div v-if="error && !dialogOpen" class="modelBanner error" data-testid="model-manager-error">{{ error }}</div>
    <div v-else-if="statusMessage && !dialogOpen" class="modelBanner success" data-testid="model-manager-status">
      {{ statusMessage }}
    </div>

    <div class="cliList">
      <div class="modelListHeader">
        <span class="modelListCount">共 {{ sortedModels.length }} 个模型 · {{ enabledCount }} 已启用</span>
        <button
          v-if="!showHeader"
          type="button"
          class="addBtn"
          :disabled="busy"
          data-testid="model-manager-add"
          @click="startCreate"
        >
          <el-icon :size="13" aria-hidden="true"><Plus /></el-icon>
          <span>新增模型</span>
        </button>
      </div>

      <div class="cliModels">
        <p v-if="sortedModels.length === 0" class="cliEmpty">
          还没有模型，点击右上角新增模型。
        </p>

          <article
            v-for="model in sortedModels"
            :key="model.id"
            class="modelRow"
            :class="{ selected: selectedModelId === model.id, off: !model.isEnabled, busy: busyRowId === model.id }"
            :data-testid="`model-manager-row-${model.id}`"
            @click="selectModel(model)"
          >
            <div class="modelRowMain">
              <div class="modelRowHeader">
                <span class="modelRowText">{{ modelLabel(model) || model.id }}</span>
                <span v-if="model.isDefault" class="modelPill default">默认</span>
              </div>
              <code class="modelRowId">{{ model.modelId || model.id }}</code>
            </div>

            <div class="modelRowActions" @click.stop>
              <template v-if="pendingDeleteId === model.id">
                <span class="confirmText">确定删除？</span>
                <button
                  type="button"
                  class="rowAction danger solid"
                  :disabled="busy"
                  :data-testid="`model-manager-delete-confirm-${model.id}`"
                  @click="deleteModel(model)"
                >
                  确认删除
                </button>
                <button type="button" class="rowAction" :disabled="busy" @click="cancelDelete">取消</button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="rowSwitch"
                  :class="{ on: model.isEnabled }"
                  role="switch"
                  :aria-checked="model.isEnabled"
                  :title="
                    model.isDefault
                      ? '默认模型不能停用'
                      : model.isEnabled
                        ? '点击停用（从输入框下拉中移除）'
                        : '点击启用（加入输入框下拉）'
                  "
                  :disabled="busy || model.isDefault"
                  :data-testid="`model-manager-toggle-${model.id}`"
                  @click="toggleEnabled(model)"
                >
                  <span class="rowSwitchTrack" aria-hidden="true"><span class="rowSwitchThumb" /></span>
                  <span class="rowSwitchText">{{ model.isEnabled ? "已启用" : "已停用" }}</span>
                </button>

                <button
                  type="button"
                  class="rowAction icon star"
                  :class="{ active: model.isDefault }"
                  :title="model.isDefault ? '当前默认模型' : '设为默认模型'"
                  :disabled="busy || model.isDefault"
                  :data-testid="`model-manager-default-${model.id}`"
                  @click="setDefaultModel(model)"
                >
                  <el-icon :size="14" aria-hidden="true"><StarFilled /></el-icon>
                </button>

                <button
                  type="button"
                  class="rowAction icon"
                  title="编辑"
                  :disabled="busy"
                  :data-testid="`model-manager-edit-${model.id}`"
                  @click="editModel(model)"
                >
                  <el-icon :size="14" aria-hidden="true"><EditPen /></el-icon>
                </button>

                <button
                  v-if="selectedModelId === model.id"
                  type="button"
                  class="rowAction icon danger"
                  :title="model.isDefault ? '默认模型不能删除' : '删除'"
                  :disabled="busy || model.isDefault"
                  :data-testid="`model-manager-delete-${model.id}`"
                  @click="requestDelete(model)"
                >
                  <el-icon :size="14" aria-hidden="true"><Close /></el-icon>
                </button>
              </template>
            </div>
          </article>
        </div>

      <p class="listFoot">未设置默认模型时优先使用列表中的第一个已启用模型。</p>
    </div>

    <div v-if="dialogOpen" class="dialogMask" @click.self="closeDialog">
      <form class="dialogCard" role="dialog" aria-modal="true" data-testid="model-manager-dialog" @submit.prevent="saveModel">
        <header class="dialogHeader">
          <div class="dialogHeading">
            <div class="dialogTitle">{{ isEditing ? "编辑模型" : "新增模型" }}</div>
            <div class="dialogSubtitle">
              <span class="dialogHint">保存后立即出现在输入框下拉里</span>
            </div>
          </div>
          <button class="modelIconBtn" type="button" title="关闭" @click="closeDialog">
            <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
          </button>
        </header>

        <div class="dialogBody">
          <div v-if="error" class="modelBanner error dialogError" data-testid="model-manager-dialog-error">
            {{ error }}
          </div>

          <label class="modelField">
            <span class="modelLabel">Model ID<span class="required">必填</span></span>
            <input
              v-model="form.modelId"
              class="modelInput"
              placeholder="gpt-5.2"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              data-testid="model-manager-model-id"
            />
            <span class="modelHelp">必须与 Codex multi-provider 配置实际接受的 model 参数完全一致。</span>
          </label>

          <label class="modelField">
            <span class="modelLabel">显示名</span>
            <input
              v-model="form.displayName"
              class="modelInput"
              :placeholder="form.modelId || '留空时使用 Model ID'"
              autocomplete="off"
              data-testid="model-manager-display-name"
            />
            <span class="modelHelp">只影响下拉列表里的显示文字。</span>
          </label>

          <div class="modelToggleGrid">
            <label class="modelToggle" :class="{ locked: editingCurrentDefault }">
              <input
                v-model="form.isEnabled"
                type="checkbox"
                :disabled="editingCurrentDefault"
                data-testid="model-manager-enabled"
              />
              <span>
                <strong>启用模型</strong>
                <small v-if="editingCurrentDefault">默认模型不能停用。</small>
                <small v-else>停用后不会出现在输入框下拉列表。</small>
              </span>
            </label>
            <label class="modelToggle" :class="{ locked: editingCurrentDefault }">
              <input
                v-model="form.isDefault"
                type="checkbox"
                :disabled="editingCurrentDefault"
                data-testid="model-manager-default"
              />
              <span>
                <strong>设为默认</strong>
                <small v-if="editingCurrentDefault">已是默认模型；要更换请在别的模型上设为默认。</small>
                <small v-else>默认模型；未选择模型时优先使用它。</small>
              </span>
            </label>
          </div>

          <label class="modelField">
            <span class="modelLabel">Config JSON</span>
            <textarea
              v-model="form.configJsonText"
              class="modelTextarea"
              :class="{ invalid: configJsonError !== null }"
              rows="6"
              spellcheck="false"
              data-testid="model-manager-config-json"
            />
            <span v-if="configJsonError" class="modelHelp invalid">JSON 格式有误：{{ configJsonError }}</span>
            <span v-else class="modelHelp">传给 Codex 引擎的额外参数，例如 {{ "{" }}"reasoningEffort":"high"{{ "}" }}。</span>
          </label>
        </div>

        <footer class="dialogActions">
          <button type="button" class="btnSecondary" :disabled="saving" @click="closeDialog">取消</button>
          <button type="submit" class="btnPrimary" :disabled="!canSubmit" data-testid="model-manager-save">
            {{ saving ? "保存中" : "保存模型" }}
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<style scoped>
.modelManager {
  position: relative;
  width: 100%;
  height: min(660px, 86vh);
  max-height: min(660px, 86vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border-radius: 16px;
}

/* ---------- header ---------- */
.modelHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.modelHeaderTitle {
  min-width: 0;
}

.modelTitle {
  font-size: 15px;
  font-weight: 800;
  color: var(--text);
  letter-spacing: 0.2px;
}

.modelSubtitle {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
}

.modelHeaderActions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modelIconBtn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.modelIconBtn:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text);
}

.modelIconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------- banners ---------- */
.modelBanner {
  flex: 0 0 auto;
  margin: 12px 16px 0;
  border-radius: 9px;
  padding: 8px 11px;
  font-size: 12px;
  font-weight: 600;
}

.modelBanner.error {
  border: 1px solid rgba(239, 68, 68, 0.28);
  background: rgba(239, 68, 68, 0.07);
  color: var(--danger-2);
}

.modelBanner.success {
  border: 1px solid rgba(16, 185, 129, 0.26);
  background: rgba(16, 185, 129, 0.07);
  color: #047857;
}

/* ---------- list ---------- */
.cliList {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 18px;
}

.modelListHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px;
}

.modelListCount {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.addBtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.3);
  transition: background 0.14s ease, transform 0.14s ease;
}

.addBtn:hover:not(:disabled) {
  background: var(--accent-2);
}

.addBtn:active:not(:disabled) {
  transform: translateY(1px);
}

.addBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cliModels {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface);
  overflow: hidden;
}

.cliEmpty {
  margin: 0;
  padding: 24px 14px;
  color: var(--muted-2);
  font-size: 12px;
  text-align: center;
}

/* ---------- model rows ---------- */
.modelRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.14s ease, opacity 0.14s ease;
}

.modelRow:first-child {
  border-top: none;
}

.modelRow:hover {
  background: rgba(37, 99, 235, 0.03);
}

.modelRow.selected {
  background: rgba(37, 99, 235, 0.08);
  box-shadow: inset 3px 0 0 var(--accent);
}

.modelRow.selected:hover {
  background: rgba(37, 99, 235, 0.12);
}

.modelRow.off .modelRowText {
  color: var(--muted);
}

.modelRow.busy {
  opacity: 0.6;
}

.modelRowMain {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.modelRowHeader {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.modelRowText {
  color: var(--text);
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.35;
  word-break: break-word;
}

.modelPill {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 800;
}

.modelPill.default {
  background: rgba(245, 158, 11, 0.16);
  color: #b45309;
}

.modelRowId {
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.05);
  color: #475569;
  font-family: var(--font-mono);
  font-size: 11.5px;
  word-break: break-all;
  line-height: 1.3;
}

.modelRowActions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.confirmText {
  color: var(--danger-2);
  font-size: 11.5px;
  font-weight: 700;
}

.rowSwitch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease;
}

.rowSwitch:hover:not(:disabled) {
  border-color: rgba(100, 116, 139, 0.5);
}

.rowSwitch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rowSwitchTrack {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.16s ease;
}

.rowSwitchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transition: transform 0.16s ease;
}

.rowSwitch.on {
  border-color: rgba(16, 185, 129, 0.4);
  color: #047857;
}

.rowSwitch.on .rowSwitchTrack {
  background: #10b981;
}

.rowSwitch.on .rowSwitchThumb {
  transform: translateX(11px);
}

.rowAction {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: #475569;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.rowAction.icon {
  width: 28px;
  padding: 0;
}

.rowAction:hover:not(:disabled) {
  border-color: rgba(100, 116, 139, 0.45);
  background: var(--surface-2);
  color: var(--text);
}

.rowAction.star {
  color: var(--muted-2);
}

.rowAction.star:hover:not(:disabled) {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.08);
  color: #d97706;
}

.rowAction.star.active,
.rowAction.star.active:disabled {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
  opacity: 1;
  cursor: default;
}

.rowAction.danger {
  color: var(--danger-2);
}

.rowAction.danger:hover:not(:disabled) {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.07);
  color: var(--danger-2);
}

.rowAction.danger.solid {
  border-color: var(--danger-2);
  background: var(--danger-2);
  color: #fff;
}

.rowAction.danger.solid:hover:not(:disabled) {
  background: #b91c1c;
  color: #fff;
}

.rowAction:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.listFoot {
  margin: 2px 2px 0;
  color: var(--muted-2);
  font-size: 10.5px;
  line-height: 1.6;
}

/* ---------- edit dialog ---------- */
.dialogMask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.34);
  backdrop-filter: blur(2px);
}

.dialogCard {
  width: min(520px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
}

.dialogHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.dialogHeading {
  min-width: 0;
}

.dialogTitle {
  color: var(--text);
  font-size: 14.5px;
  font-weight: 800;
}

.dialogSubtitle {
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dialogHint {
  overflow: hidden;
  color: var(--muted-2);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialogBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding: 16px;
}

/* Save failures must surface inside the dialog — the page-level banner sits under the mask. */
.dialogError {
  margin: 0;
}

.modelField {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.modelLabel {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #334155;
  font-size: 11.5px;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.required {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(37, 99, 235, 0.1);
  color: var(--accent-2);
  font-size: 9.5px;
  font-weight: 800;
}

.modelInput,
.modelTextarea {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.42);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  box-sizing: border-box;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}

.modelInput {
  height: 36px;
  padding: 0 11px;
}

.modelTextarea {
  min-height: 96px;
  padding: 9px 11px;
  font-family: var(--font-mono);
  line-height: 1.5;
  resize: vertical;
}

.modelInput:focus,
.modelTextarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.6);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.modelTextarea.invalid {
  border-color: rgba(239, 68, 68, 0.55);
}

.modelTextarea.invalid:focus {
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
}

.modelHelp {
  color: var(--muted-2);
  font-size: 10.5px;
  line-height: 1.5;
}

.modelHelp.invalid {
  color: var(--danger-2);
  font-weight: 700;
}

.modelToggleGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.modelToggle {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-2);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}

.modelToggle:hover {
  border-color: rgba(100, 116, 139, 0.35);
  background: var(--surface);
}

.modelToggle.locked {
  cursor: default;
  opacity: 0.72;
}

.modelToggle.locked:hover {
  border-color: var(--border);
  background: var(--surface-2);
}

.modelToggle input {
  margin-top: 2px;
  accent-color: var(--accent);
}

.modelToggle span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modelToggle strong {
  color: #334155;
  font-size: 12px;
}

.modelToggle small {
  color: var(--muted-2);
  font-size: 10px;
  line-height: 1.45;
}

.dialogActions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.btnSecondary,
.btnPrimary {
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.14s ease;
}

.btnSecondary {
  background: var(--surface);
  color: var(--text);
}

.btnSecondary:hover:not(:disabled) {
  background: var(--surface-2);
}

.btnPrimary {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.btnPrimary:hover:not(:disabled) {
  background: var(--accent-2);
}

.btnPrimary:disabled,
.btnSecondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .modelManager {
    height: min(720px, 90vh);
    max-height: min(720px, 90vh);
  }

  .cliRow {
    flex-wrap: wrap;
  }

  .cliCount {
    display: none;
  }

  .modelRow {
    grid-template-columns: minmax(0, 1fr);
  }

  .modelRowMain {
    flex-wrap: wrap;
    gap: 6px;
  }

  .modelRowActions {
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .modelToggleGrid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
