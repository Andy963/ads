<script setup lang="ts">
import type { Task } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

type ReviewBadge = {
  label: string;
  title: string;
  status: "none" | "pending" | "running" | "passed" | "rejected" | "failed";
};

const props = defineProps<{
  task: Task;
  statusLabel: string;
  reviewedAtText: string;
  reviewBadge: ReviewBadge | null;
  canMarkReviewDone: boolean;
  canViewReviewNotes: boolean;
  showTaskPrompt: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "markDone", id: string): void;
  (e: "viewReviewNotes"): void;
}>();
</script>

<template>
  <DraggableModal card-variant="large" data-testid="task-detail-modal" @close="emit('close')">
    <div class="detailModalHeader" data-drag-handle>
      <div class="detailModalTitle">{{ props.task.title || "(未命名任务)" }}</div>
      <div class="detailModalHeaderActions">
        <button
          v-if="props.canMarkReviewDone"
          class="btnPrimary btnCompact"
          type="button"
          data-testid="task-review-mark-done"
          @click="emit('markDone', props.task.id)"
        >
          标记完成
        </button>
        <button
          class="iconBtn"
          type="button"
          aria-label="关闭"
          title="关闭"
          data-testid="task-detail-close"
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
    </div>

    <div class="detailModalBody">
      <div class="detailMetaGrid">
        <div class="detailMetaRow">
          <span class="detailMetaKey">状态</span>
          <span class="detailMetaValue">{{ props.statusLabel }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">模型</span>
          <span class="detailMetaValue detailMono">{{ props.task.model }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">ID</span>
          <span class="detailMetaValue detailMono">{{ props.task.id }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">隔离执行</span>
          <span class="detailMetaValue">{{ props.task.executionIsolation === "required" ? "required" : "default" }}</span>
        </div>
        <div v-if="props.task.latestRun" class="detailMetaRow">
          <span class="detailMetaKey">最近 Run</span>
          <span class="detailMetaValue detailMono">{{ props.task.latestRun.id }}</span>
        </div>
        <div v-if="props.task.latestRun" class="detailMetaRow">
          <span class="detailMetaKey">Apply</span>
          <span class="detailMetaValue">{{ props.task.latestRun.applyStatus }}</span>
        </div>
        <div v-if="props.task.latestRun?.worktreeDir" class="detailMetaRow">
          <span class="detailMetaKey">Worktree</span>
          <span class="detailMetaValue detailMono">{{ props.task.latestRun.worktreeDir }}</span>
        </div>
      </div>

      <div v-if="props.task.reviewRequired" class="detailSection" data-testid="task-review-detail">
        <div class="detailSectionTitle">审核</div>
        <div class="detailMetaGrid">
          <div class="detailMetaRow">
            <span class="detailMetaKey">状态</span>
            <span
              v-if="props.reviewBadge"
              class="badge"
              :data-review="props.reviewBadge.status"
              :title="props.reviewBadge.title"
            >
              {{ props.reviewBadge.label }}
            </span>
            <span v-else class="detailMetaValue">-</span>
          </div>
          <div class="detailMetaRow">
            <span class="detailMetaKey">时间</span>
            <span class="detailMetaValue">{{ props.reviewedAtText || "-" }}</span>
          </div>
          <div class="detailMetaRow">
            <span class="detailMetaKey">快照</span>
            <span class="detailMetaValue detailMono">{{ props.task.reviewSnapshotId ? props.task.reviewSnapshotId.slice(0, 8) : "-" }}</span>
            <button
              class="btnSecondary btnCompact"
              type="button"
              data-testid="task-review-view-notes"
              :disabled="!props.canViewReviewNotes"
              @click="emit('viewReviewNotes')"
            >
              查看审核备注
            </button>
          </div>
        </div>

        <div class="detailConclusion">
          <div class="detailSectionTitle sub">结论</div>
          <pre
            v-if="props.task.reviewConclusion"
            class="detailMono preWrap"
            data-testid="task-review-conclusion"
          >{{ props.task.reviewConclusion }}</pre>
          <div v-else class="detailEmpty" data-testid="task-review-conclusion-empty">暂无审核结论</div>
        </div>
      </div>

      <div v-if="props.showTaskPrompt" class="detailSection">
        <div class="detailSectionTitle">任务描述</div>
        <pre class="detailMono preWrap" data-testid="task-detail-prompt">{{ props.task.prompt }}</pre>
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

.btnPrimary {
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: none;
  background: linear-gradient(90deg, #4f8ef7 0%, #7aa9ff 100%);
  color: white;
  box-shadow: 0 10px 20px rgba(79, 142, 247, 0.35);
  transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.btnPrimary:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btnPrimary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
}

.btnSecondary {
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(79, 142, 247, 0.35);
  background: rgba(79, 142, 247, 0.12);
  color: #2563eb;
  transition: border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.btnSecondary:hover:not(:disabled) {
  border-color: rgba(79, 142, 247, 0.6);
  background: rgba(79, 142, 247, 0.18);
  transform: translateY(-1px);
}

.btnSecondary:active:not(:disabled) {
  background: rgba(79, 142, 247, 0.22);
}

.btnCompact {
  min-height: 28px;
  padding: 4px 10px;
  font-size: 13px;
  border-radius: 999px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
}

.badge[data-review="none"] {
  color: #475569;
  background: rgba(148, 163, 184, 0.18);
}

.badge[data-review="pending"] {
  color: #9a3412;
  background: rgba(251, 146, 60, 0.2);
}

.badge[data-review="running"] {
  color: #1d4ed8;
  background: rgba(96, 165, 250, 0.18);
}

.badge[data-review="passed"] {
  color: #166534;
  background: rgba(134, 239, 172, 0.24);
}

.badge[data-review="rejected"] {
  color: #b91c1c;
  background: rgba(252, 165, 165, 0.24);
}

.badge[data-review="failed"] {
  color: #7c2d12;
  background: rgba(253, 186, 116, 0.28);
}

.detailModalHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(248, 250, 252, 0.95);
}

.detailModalHeaderActions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detailModalTitle {
  font-size: 16px;
  font-weight: 900;
  color: #0f172a;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detailModalBody {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--surface);
  min-height: 0;
  max-height: calc(88vh - 60px);
  overflow-y: auto;
}

.detailMetaGrid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(248, 250, 252, 0.9);
  border-radius: 14px;
  padding: 12px 14px;
}

.detailMetaRow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detailMetaKey {
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
}

.detailMetaValue {
  font-size: 12px;
  color: #334155;
  min-width: 0;
  word-break: break-word;
}

.detailMono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.detailSection {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detailSectionTitle {
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
}

.detailSectionTitle.sub {
  margin-top: 2px;
}

.detailEmpty {
  font-size: 12px;
  color: #64748b;
}

.preWrap {
  white-space: pre-wrap;
  word-break: break-word;
}

.detailConclusion {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
