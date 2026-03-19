<script setup lang="ts">
import type { ReviewSnapshot } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

const props = defineProps<{
  taskId?: string | null;
  snapshotId?: string | null;
  snapshot: ReviewSnapshot | null;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <DraggableModal card-variant="large" data-testid="task-review-notes-modal" @close="emit('close')">
    <div class="snapshotHeader" data-drag-handle>
      <div class="snapshotTitle">审核备注</div>
      <button
        class="iconBtn"
        type="button"
        aria-label="关闭"
        title="关闭"
        data-testid="task-review-notes-close"
        @click="emit('close')"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>

    <div class="snapshotBody">
      <div class="snapshotMeta">
        <div v-if="props.taskId"><span class="metaKey">任务</span> <span class="detailMono">{{ props.taskId }}</span></div>
        <div v-if="props.snapshotId"><span class="metaKey">快照</span> <span class="detailMono">{{ props.snapshotId }}</span></div>
      </div>

      <div v-if="props.error" class="snapshotError">{{ props.error }}</div>
      <div v-else-if="props.busy" class="snapshotEmpty">加载中…</div>
      <div v-else-if="!props.snapshot" class="snapshotEmpty">未找到快照</div>
      <div v-else class="snapshotContent">
        <div class="snapshotSection">
          <div class="snapshotSectionTitle">变更文件 ({{ props.snapshot.changedFiles.length }})</div>
          <div v-if="props.snapshot.changedFiles.length === 0" class="snapshotEmptyInline">(none)</div>
          <ul v-else class="snapshotFiles">
            <li v-for="(p, idx) in props.snapshot.changedFiles" :key="idx" class="detailMono">{{ p }}</li>
          </ul>
        </div>

        <div class="snapshotSection">
          <div class="snapshotSectionTitle">Diff</div>
          <div v-if="props.snapshot.patch?.truncated" class="snapshotHint">⚠️ diff is truncated</div>
          <pre class="snapshotDiff detailMono">{{ props.snapshot.patch?.diff || "" }}</pre>
        </div>

        <div v-if="props.snapshot.lintSummary || props.snapshot.testSummary" class="snapshotSection">
          <div class="snapshotSectionTitle">摘要</div>
          <div v-if="props.snapshot.lintSummary" class="snapshotSummary"><span class="metaKey">Lint</span> {{ props.snapshot.lintSummary }}</div>
          <div v-if="props.snapshot.testSummary" class="snapshotSummary"><span class="metaKey">Test</span> {{ props.snapshot.testSummary }}</div>
        </div>
      </div>
    </div>
  </DraggableModal>
</template>

<style scoped>
.iconBtn {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: transparent;
  color: #64748b;
  box-shadow: none;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.iconBtn:hover:not(:disabled) {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.04);
}

.iconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.detailMono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.snapshotHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(248, 250, 252, 0.95);
}

.snapshotTitle {
  font-size: 16px;
  font-weight: 900;
  color: #0f172a;
}

.snapshotBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  min-height: 0;
}

.snapshotMeta {
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(248, 250, 252, 0.9);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12px;
  color: #334155;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metaKey {
  font-weight: 900;
  color: #0f172a;
  margin-right: 6px;
}

.snapshotError {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  color: #dc2626;
}

.snapshotEmpty {
  padding: 12px;
  font-size: 12px;
  color: #64748b;
  text-align: center;
}

.snapshotContent {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.snapshotSectionTitle {
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
  margin-bottom: 6px;
}

.snapshotFiles {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #334155;
}

.snapshotHint {
  font-size: 12px;
  color: #b45309;
  margin-bottom: 6px;
}

.snapshotDiff {
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.96);
  color: rgba(226, 232, 240, 0.95);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
  max-height: 48vh;
  white-space: pre;
}

.snapshotEmptyInline {
  font-size: 12px;
  color: #64748b;
}

.snapshotSummary {
  font-size: 12px;
  color: #334155;
  line-height: 1.5;
}
</style>
