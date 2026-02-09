<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CircleCheck, Delete, Edit, Refresh } from "@element-plus/icons-vue";

import type { TaskBundle, TaskBundleDraft } from "../api/types";

const props = defineProps<{
  drafts: TaskBundleDraft[];
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "approve", payload: { id: string; runQueue: boolean }): void;
  (e: "delete", id: string): void;
  (e: "update", payload: { id: string; bundle: TaskBundle }): void;
}>();

const expanded = ref(false);
const editingDraftId = ref<string | null>(null);
const editingJson = ref("");
const editingError = ref<string | null>(null);

const draftCount = computed(() => (Array.isArray(props.drafts) ? props.drafts.length : 0));
const hasDrafts = computed(() => draftCount.value > 0);

watch(
  () => draftCount.value,
  (n) => {
    if (n > 0 && !expanded.value) {
      expanded.value = true;
    }
  },
  { immediate: true },
);

function statusLabel(status: string): string {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "approved") return "已批准";
  if (s === "deleted") return "已删除";
  return "草稿";
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function openEditor(draft: TaskBundleDraft): void {
  editingError.value = null;
  editingDraftId.value = draft.id;
  editingJson.value = JSON.stringify(draft.bundle ?? { version: 1, tasks: [] }, null, 2);
  if (!expanded.value) expanded.value = true;
}

function closeEditor(): void {
  editingDraftId.value = null;
  editingJson.value = "";
  editingError.value = null;
}

function parseBundleJson(raw: string): { ok: true; bundle: TaskBundle } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "JSON 不能为空" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "JSON 解析失败" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "JSON 顶层必须是对象" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: "bundle.version 必须是 1" };
  }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return { ok: false, error: "bundle.tasks 不能为空" };
  }
  for (let i = 0; i < obj.tasks.length; i += 1) {
    const rawTask = obj.tasks[i];
    if (!rawTask || typeof rawTask !== "object") {
      return { ok: false, error: `tasks[${i}] 必须是对象` };
    }
    const task = rawTask as Record<string, unknown>;
    const prompt = String(task.prompt ?? "").trim();
    if (!prompt) {
      return { ok: false, error: `tasks[${i}].prompt 不能为空` };
    }
  }
  return { ok: true, bundle: parsed as TaskBundle };
}

function saveEditor(): void {
  const id = String(editingDraftId.value ?? "").trim();
  if (!id) return;
  const parsed = parseBundleJson(editingJson.value);
  if (!parsed.ok) {
    editingError.value = parsed.error;
    return;
  }
  editingError.value = null;
  emit("update", { id, bundle: parsed.bundle });
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

function approve(id: string, runQueue: boolean): void {
  emit("approve", { id, runQueue });
}
</script>

<template>
  <section class="draftPanel" data-testid="task-bundle-drafts">
    <header class="draftHeader">
      <button
        type="button"
        class="draftToggle"
        :aria-expanded="expanded"
        data-testid="task-bundle-drafts-toggle"
        @click="toggleExpanded"
      >
        <span class="draftTitle">任务草稿</span>
        <span class="draftCount" :class="{ 'draftCount--active': hasDrafts }">{{ draftCount }}</span>
      </button>

      <div class="draftHeaderActions">
        <button
          type="button"
          class="draftIconButton"
          :disabled="Boolean(busy)"
          data-testid="task-bundle-drafts-refresh"
          title="刷新"
          @click="emit('refresh')"
        >
          <Refresh />
        </button>
      </div>
    </header>

    <div v-if="expanded" class="draftBody">
      <div v-if="error" class="draftError" data-testid="task-bundle-drafts-error">{{ error }}</div>
      <div v-else-if="!hasDrafts" class="draftEmpty">
        <div>暂无草稿</div>
        <div style="margin-top: 6px; font-size: 11px; line-height: 1.4; color: #64748b">
          要生成草稿，请让 Planner 在最终回复中输出一个 fenced code block（language:
          <code>ads-task-bundle</code> 或 <code>ads-tasks</code>），内容为 TaskBundle JSON。
        </div>
      </div>

      <div v-else class="draftList">
        <article
          v-for="draft in drafts"
          :key="draft.id"
          class="draftCard"
          :data-testid="`task-bundle-draft-${draft.id}`"
        >
          <div class="draftCardHeader">
            <div class="draftMeta">
              <div class="draftStatus">{{ statusLabel(draft.status) }}</div>
              <div class="draftTime">{{ formatTime(draft.updatedAt) }}</div>
            </div>
            <div class="draftCardActions">
              <button
                type="button"
                class="draftAction"
                :disabled="Boolean(busy) || draft.status !== 'draft' || !draft.bundle"
                data-testid="task-bundle-draft-approve"
                @click="approve(draft.id, false)"
              >
                <CircleCheck />
                批准
              </button>
              <button
                type="button"
                class="draftAction"
                :disabled="Boolean(busy) || draft.status !== 'draft' || !draft.bundle"
                data-testid="task-bundle-draft-approve-run"
                @click="approve(draft.id, true)"
              >
                <CircleCheck />
                批准并运行
              </button>
              <button
                type="button"
                class="draftAction draftAction--ghost"
                :disabled="Boolean(busy)"
                data-testid="task-bundle-draft-edit"
                @click="openEditor(draft)"
              >
                <Edit />
                编辑
              </button>
              <button
                type="button"
                class="draftAction draftAction--danger"
                :disabled="Boolean(busy)"
                data-testid="task-bundle-draft-delete"
                @click="emit('delete', draft.id)"
              >
                <Delete />
                删除
              </button>
            </div>
          </div>

          <div v-if="draft.lastError" class="draftLastError" data-testid="task-bundle-draft-last-error">
            {{ draft.lastError }}
          </div>

          <details class="draftPreview" :open="editingDraftId !== draft.id">
            <summary class="draftPreviewSummary">预览（{{ draft.bundle?.tasks?.length ?? 0 }}）</summary>
            <ol class="draftTasks">
              <li v-for="(t, idx) in draft.bundle?.tasks ?? []" :key="t.externalId ?? `${draft.id}:${idx}`" class="draftTask">
                <div class="draftTaskTitle">{{ t.title || `Task ${idx + 1}` }}</div>
                <pre class="draftTaskPrompt">{{ t.prompt }}</pre>
              </li>
            </ol>
          </details>

          <div v-if="editingDraftId === draft.id" class="draftEditor" data-testid="task-bundle-draft-editor">
            <div class="draftEditorHeader">编辑 TaskBundle JSON</div>
            <textarea
              v-model="editingJson"
              class="draftEditorTextarea"
              rows="10"
              spellcheck="false"
              data-testid="task-bundle-draft-editor-textarea"
            />
            <div v-if="editingError" class="draftEditorError" data-testid="task-bundle-draft-editor-error">
              {{ editingError }}
            </div>
            <div class="draftEditorActions">
              <button
                type="button"
                class="draftAction"
                :disabled="Boolean(busy)"
                data-testid="task-bundle-draft-editor-save"
                @click="saveEditor"
              >
                保存
              </button>
              <button
                type="button"
                class="draftAction draftAction--ghost"
                :disabled="Boolean(busy)"
                data-testid="task-bundle-draft-editor-cancel"
                @click="closeEditor"
              >
                取消
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style src="./TaskBundleDraftPanel.css" scoped></style>
