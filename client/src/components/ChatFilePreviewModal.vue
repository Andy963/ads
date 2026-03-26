<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { ApiClient } from "../api/client";
import type { FilePreviewResponse } from "../api/types";
import { hljs } from "../lib/markdown";
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
  if (!content) return [] as Array<{ number: number; text: string; html: string | null }>;
  const rawLang = preview.value?.language ?? null;
  const lang = rawLang === "html" || rawLang === "vue" ? "xml" : rawLang;
  let highlightedLines: string[] | null = null;
  if (lang && hljs.getLanguage(lang)) {
    try {
      const result = hljs.highlight(content, { language: lang });
      highlightedLines = result.value.split("\n");
    } catch {
      // fall back to plain text
    }
  }
  return content.split("\n").map((text, idx) => ({
    number: (preview.value?.startLine ?? 1) + idx,
    text,
    html: highlightedLines?.[idx] ?? null,
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
          <div class="filePreviewPath" :title="preview?.path || target.path">{{ preview?.path || target.path }}</div>
          <span v-if="preview" class="filePreviewStats">
            {{ preview.totalLines }} 行<template v-if="preview.truncated"> · {{ preview.startLine }}-{{ preview.endLine }}</template>
          </span>
        </div>
        <button
          class="filePreviewClose"
          type="button"
          aria-label="关闭文件预览"
          data-testid="chat-file-preview-close"
          @click="emit('close')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1.5 1.5L12.5 12.5M12.5 1.5L1.5 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="filePreviewBody">
        <div v-if="loading" class="filePreviewEmpty">正在加载文件…</div>
        <div v-else-if="error" class="filePreviewError">{{ error }}</div>
        <template v-else-if="preview">
          <div v-if="outOfRangeLine" class="filePreviewHint">
            目标行 {{ requestedLine }} 超出文件范围
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
              <code v-if="line.html != null" class="filePreviewLineText" v-html="line.html || '&nbsp;'"></code>
              <code v-else class="filePreviewLineText">{{ line.text || " " }}</code>
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
  height: 88vh;
  max-height: 88vh;
  overflow: hidden;
}

.filePreviewHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--github-border);
  background: var(--github-code-bg);
  border-radius: 20px 20px 0 0;
}

.filePreviewMeta {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
  overflow: hidden;
}

.filePreviewPath {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--github-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.filePreviewStats {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--github-muted);
  white-space: nowrap;
}

.filePreviewClose {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--github-muted);
  border-radius: 6px;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}

.filePreviewClose:hover {
  color: var(--github-text);
  background: rgba(0, 0, 0, 0.06);
}

.filePreviewBody {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.filePreviewEmpty,
.filePreviewError {
  padding: 14px 18px;
  font-size: 13px;
}

.filePreviewEmpty {
  color: var(--github-muted);
}

.filePreviewError {
  background: rgba(254, 226, 226, 0.5);
  color: #b91c1c;
}

.filePreviewHint {
  padding: 8px 18px 0;
  font-size: 12px;
  color: #92400e;
}

.filePreviewCode {
  overflow: auto;
  background: var(--github-code-bg);
  flex: 1;
  min-height: 0;
}

.filePreviewLine {
  display: flex;
  padding: 0 16px;
  min-height: 22px;
  line-height: 22px;
  background: transparent;
}

.filePreviewLine--highlight {
  background: rgba(251, 191, 36, 0.15);
}

.filePreviewLineNo {
  position: sticky;
  left: 0;
  flex-shrink: 0;
  width: 48px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: rgba(27, 31, 36, 0.3);
  background: inherit;
  text-align: right;
  padding-right: 16px;
  user-select: none;
  box-sizing: border-box;
}

.filePreviewLineText {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 22px;
  color: var(--github-text);
  white-space: pre;
  tab-size: 4;
}

/* highlight.js token colors – GitHub light theme */
.filePreviewLineText :deep(.hljs-keyword),
.filePreviewLineText :deep(.hljs-selector-tag),
.filePreviewLineText :deep(.hljs-literal),
.filePreviewLineText :deep(.hljs-subst) {
  color: #cf222e;
}

.filePreviewLineText :deep(.hljs-string),
.filePreviewLineText :deep(.hljs-title),
.filePreviewLineText :deep(.hljs-section),
.filePreviewLineText :deep(.hljs-doctag),
.filePreviewLineText :deep(.hljs-regexp) {
  color: #0a3069;
}

.filePreviewLineText :deep(.hljs-comment),
.filePreviewLineText :deep(.hljs-quote) {
  color: #6e7781;
  font-style: italic;
}

.filePreviewLineText :deep(.hljs-number) {
  color: #0550ae;
}

.filePreviewLineText :deep(.hljs-attr),
.filePreviewLineText :deep(.hljs-attribute),
.filePreviewLineText :deep(.hljs-property),
.filePreviewLineText :deep(.hljs-variable),
.filePreviewLineText :deep(.hljs-template-variable),
.filePreviewLineText :deep(.hljs-link),
.filePreviewLineText :deep(.hljs-symbol) {
  color: #0550ae;
}

.filePreviewLineText :deep(.hljs-built_in),
.filePreviewLineText :deep(.hljs-type),
.filePreviewLineText :deep(.hljs-class .hljs-title),
.filePreviewLineText :deep(.hljs-function .hljs-title),
.filePreviewLineText :deep(.hljs-selector-id),
.filePreviewLineText :deep(.hljs-selector-class) {
  color: #8250df;
}

.filePreviewLineText :deep(.hljs-addition) {
  color: #116329;
  background: rgba(46, 160, 67, 0.14);
}

.filePreviewLineText :deep(.hljs-deletion) {
  color: #cf222e;
  background: rgba(248, 81, 73, 0.14);
}

.filePreviewLineText :deep(.hljs-meta) {
  color: #953800;
}
</style>
