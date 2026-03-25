<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { ApiClient } from "../api/client";
import type { FilePreviewResponse } from "../api/types";
import type { MarkdownFilePreviewLink } from "../lib/markdown";
import DraggableModal from "./DraggableModal.vue";

const props = defineProps<{
  workspaceRoot?: string | null;
  target: MarkdownFilePreviewLink | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const api = new ApiClient({ baseUrl: "" });
const rootEl = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const preview = ref<FilePreviewResponse | null>(null);

let loadToken = 0;

const requestedLine = computed(() => props.target?.line ?? null);
const previewLines = computed(() => {
  const content = String(preview.value?.content ?? "");
  if (!content) return [] as Array<{ number: number; text: string }>;
  return content.split("\n").map((text, idx) => ({
    number: (preview.value?.startLine ?? 1) + idx,
    text,
  }));
});
const highlightedLine = computed(() => {
  const line = requestedLine.value;
  if (!line || !preview.value) return null;
  return line >= preview.value.startLine && line <= preview.value.endLine ? line : null;
});
const outOfRangeLine = computed(() => {
  const line = requestedLine.value;
  if (!line || !preview.value) return false;
  return line > preview.value.totalLines;
});

function normalizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    const normalized = String(parsed?.error ?? "").trim();
    return normalized || message;
  } catch {
    return message;
  }
}

async function scrollToHighlightedLine(): Promise<void> {
  const line = highlightedLine.value;
  if (!line) return;
  await nextTick();
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-line="${line}"]`);
  el?.scrollIntoView?.({ block: "center" });
}

async function loadPreview(): Promise<void> {
  const target = props.target;
  const workspaceRoot = String(props.workspaceRoot ?? "").trim();
  if (!target || !workspaceRoot) {
    preview.value = null;
    error.value = null;
    loading.value = false;
    return;
  }

  const token = ++loadToken;
  loading.value = true;
  error.value = null;
  preview.value = null;

  const qp = new URLSearchParams();
  qp.set("workspace", workspaceRoot);
  qp.set("path", target.path);
  if (target.line != null) {
    qp.set("line", String(target.line));
  }

  try {
    const result = await api.get<FilePreviewResponse>(`/api/files/content?${qp.toString()}`);
    if (token !== loadToken) return;
    preview.value = result;
    await scrollToHighlightedLine();
  } catch (loadError) {
    if (token !== loadToken) return;
    error.value = normalizeErrorMessage(loadError);
  } finally {
    if (token === loadToken) {
      loading.value = false;
    }
  }
}

watch(
  () => [props.target?.path ?? "", props.target?.line ?? null, props.workspaceRoot ?? ""],
  () => {
    void loadPreview();
  },
  { immediate: true },
);

watch(highlightedLine, () => {
  void scrollToHighlightedLine();
});
</script>

<template>
  <DraggableModal v-if="target" card-variant="large" data-testid="chat-file-preview-modal" @close="emit('close')">
    <div ref="rootEl" class="filePreview">
      <div class="filePreviewHeader" data-drag-handle>
        <div class="filePreviewMeta">
          <div class="filePreviewTitle">文件预览</div>
          <div class="filePreviewPath" :title="preview?.path || target.path">{{ preview?.path || target.path }}</div>
          <div v-if="preview" class="filePreviewStats">
            共 {{ preview.totalLines }} 行
            <span v-if="preview.truncated"> · 当前展示 {{ preview.startLine }}-{{ preview.endLine }}</span>
          </div>
        </div>
        <button
          class="filePreviewClose"
          type="button"
          aria-label="关闭文件预览"
          data-testid="chat-file-preview-close"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <div class="filePreviewBody">
        <div v-if="loading" class="filePreviewEmpty">正在加载文件…</div>
        <div v-else-if="error" class="filePreviewError">{{ error }}</div>
        <template v-else-if="preview">
          <div v-if="preview.truncated" class="filePreviewHint">
            当前只展示部分内容；如有行号，会尽量包含目标行。
          </div>
          <div v-if="outOfRangeLine" class="filePreviewHint">
            目标行 {{ requestedLine }} 超出文件范围。
          </div>
          <div class="filePreviewCode" data-testid="chat-file-preview-code">
            <div
              v-for="line in previewLines"
              :key="line.number"
              class="filePreviewLine"
              :class="{ 'filePreviewLine--highlight': highlightedLine === line.number }"
              :data-line="line.number"
            >
              <span class="filePreviewLineNo">{{ line.number }}</span>
              <code class="filePreviewLineText">{{ line.text || " " }}</code>
            </div>
          </div>
        </template>
      </div>
    </div>
  </DraggableModal>
</template>

<style scoped>
.filePreview {
  display: flex;
  flex-direction: column;
  min-height: min(72vh, 720px);
}

.filePreviewHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.95);
}

.filePreviewMeta {
  min-width: 0;
}

.filePreviewTitle {
  font-size: 16px;
  font-weight: 900;
  color: #0f172a;
}

.filePreviewPath {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: #334155;
  word-break: break-all;
}

.filePreviewStats {
  margin-top: 6px;
  font-size: 12px;
  color: #64748b;
}

.filePreviewClose {
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: white;
  color: #334155;
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
}

.filePreviewBody {
  flex: 1;
  min-height: 0;
  padding-top: 14px;
}

.filePreviewEmpty,
.filePreviewError {
  border-radius: 12px;
  padding: 14px;
  font-size: 13px;
}

.filePreviewEmpty {
  background: rgba(248, 250, 252, 0.9);
  color: #64748b;
}

.filePreviewError {
  background: rgba(254, 226, 226, 0.7);
  color: #b91c1c;
}

.filePreviewHint {
  margin-bottom: 10px;
  font-size: 12px;
  color: #92400e;
}

.filePreviewCode {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 12px;
  overflow: auto;
  background: #0f172a;
  max-height: min(58vh, 620px);
}

.filePreviewLine {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 12px;
  padding: 0 14px;
  min-height: 24px;
  align-items: center;
  background: transparent;
}

.filePreviewLine--highlight {
  background: rgba(245, 158, 11, 0.18);
}

.filePreviewLineNo {
  position: sticky;
  left: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: rgba(148, 163, 184, 0.95);
  background: inherit;
  padding: 4px 0;
  user-select: none;
}

.filePreviewLineText {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: rgba(226, 232, 240, 0.96);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 4px 0;
}
</style>
