<script setup lang="ts">
import { computed, ref } from "vue";
import type { Task, TaskGoalStatus } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

const props = defineProps<{
  task: Task;
  statusLabel: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "goal-pause", taskId: string): void;
  (e: "goal-resume", taskId: string): void;
  (e: "goal-clear", taskId: string): void;
}>();

const goalEnabled = computed(() => Boolean(props.task.goalMode));
const goalStatus = computed<TaskGoalStatus | null>(() => props.task.goalStatus ?? null);
const goalStatusLabel = computed(() => {
  const s = goalStatus.value;
  if (!s) return "未启动";
  return {
    active: "运行中",
    paused: "已暂停",
    blocked: "受阻",
    usageLimited: "限速",
    budgetLimited: "已达预算",
    complete: "已完成",
  }[s] ?? s;
});
const goalTokenBudget = computed(() => props.task.goalTokenBudget ?? null);
const goalTokensUsed = computed(() => props.task.goalTokensUsed ?? 0);
const goalProgressPct = computed(() => {
  const budget = goalTokenBudget.value;
  if (!budget || budget <= 0) return null;
  const used = goalTokensUsed.value ?? 0;
  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
});
const goalTimeLabel = computed(() => {
  const t = Math.max(0, Math.floor(Number(props.task.goalTimeUsedSeconds ?? 0)));
  if (!t) return "0s";
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
});

const confirmingClear = ref(false);
function requestClear(): void {
  confirmingClear.value = true;
}
function cancelClear(): void {
  confirmingClear.value = false;
}
function confirmClear(): void {
  confirmingClear.value = false;
  emit("goal-clear", props.task.id);
}
</script>

<template>
  <DraggableModal card-variant="large" data-testid="task-detail-modal" @close="emit('close')">
    <div class="detailModalHeader" data-drag-handle>
      <div class="detailModalTitle">{{ props.task.title || "(未命名任务)" }}</div>
      <div class="detailModalHeaderActions">
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
        <div v-if="props.task.latestRun" class="detailMetaRow">
          <span class="detailMetaKey">最近 Run</span>
          <span class="detailMetaValue detailMono">{{ props.task.latestRun.id }}</span>
        </div>
      </div>

      <div v-if="goalEnabled" class="goalPanel" data-testid="task-detail-goal-panel">
        <div class="goalPanelHeader">
          <span class="goalPanelTitle">目标模式 (Goal Mode)</span>
          <span class="goalStatusBadge" :data-goal-status="goalStatus ?? 'none'">{{ goalStatusLabel }}</span>
        </div>
        <div v-if="props.task.goalObjective" class="goalObjective">
          <span class="detailMetaKey">目标</span>
          <span class="detailMetaValue preWrap">{{ props.task.goalObjective }}</span>
        </div>
        <div class="goalMetricsGrid">
          <div class="detailMetaRow">
            <span class="detailMetaKey">Tokens</span>
            <span class="detailMetaValue detailMono">
              {{ goalTokensUsed }}<span v-if="goalTokenBudget"> / {{ goalTokenBudget }}</span>
            </span>
          </div>
          <div class="detailMetaRow">
            <span class="detailMetaKey">用时</span>
            <span class="detailMetaValue detailMono">{{ goalTimeLabel }}</span>
          </div>
        </div>
        <div v-if="goalProgressPct != null" class="goalProgress" :aria-valuenow="goalProgressPct ?? undefined" aria-valuemin="0" aria-valuemax="100">
          <div class="goalProgressBar"><div class="goalProgressFill" :style="{ width: `${goalProgressPct}%` }" /></div>
          <span class="goalProgressLabel">{{ goalProgressPct }}%</span>
        </div>
        <div class="goalActions">
          <button
            type="button"
            class="btnSecondary btnCompact"
            :disabled="goalStatus !== 'active'"
            data-testid="task-detail-goal-pause"
            @click="emit('goal-pause', props.task.id)"
          >暂停</button>
          <button
            type="button"
            class="btnSecondary btnCompact"
            :disabled="goalStatus !== 'paused'"
            data-testid="task-detail-goal-resume"
            @click="emit('goal-resume', props.task.id)"
          >继续</button>
          <button
            v-if="!confirmingClear"
            type="button"
            class="btnSecondary btnCompact danger"
            data-testid="task-detail-goal-clear"
            @click="requestClear"
          >清除目标</button>
          <span v-else class="goalConfirmRow">
            <span class="goalConfirmText">确定要清除吗？</span>
            <button type="button" class="btnSecondary btnCompact" @click="cancelClear">取消</button>
            <button type="button" class="btnSecondary btnCompact danger" data-testid="task-detail-goal-clear-confirm" @click="confirmClear">确定</button>
          </span>
        </div>
      </div>

      <div class="detailSection">
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

.goalPanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid rgba(99, 102, 241, 0.22);
  background: rgba(238, 242, 255, 0.55);
  border-radius: 14px;
  padding: 12px 14px;
}

.goalPanelHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.goalPanelTitle {
  font-size: 13px;
  font-weight: 900;
  color: #0f172a;
}

.goalStatusBadge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  background: rgba(148, 163, 184, 0.18);
  color: #475569;
}
.goalStatusBadge[data-goal-status="active"] { color: #166534; background: rgba(134, 239, 172, 0.28); }
.goalStatusBadge[data-goal-status="paused"] { color: #92400e; background: rgba(251, 191, 36, 0.28); }
.goalStatusBadge[data-goal-status="blocked"] { color: #9a3412; background: rgba(251, 146, 60, 0.28); }
.goalStatusBadge[data-goal-status="usageLimited"],
.goalStatusBadge[data-goal-status="budgetLimited"] { color: #b91c1c; background: rgba(252, 165, 165, 0.32); }
.goalStatusBadge[data-goal-status="complete"] { color: #1e3a8a; background: rgba(147, 197, 253, 0.32); }

.goalObjective {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.goalMetricsGrid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
}

.goalProgress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.goalProgressBar {
  flex: 1;
  height: 6px;
  background: rgba(148, 163, 184, 0.25);
  border-radius: 999px;
  overflow: hidden;
}

.goalProgressFill {
  height: 100%;
  background: linear-gradient(90deg, #4f8ef7 0%, #22c55e 100%);
  transition: width 0.3s ease;
}

.goalProgressLabel {
  font-size: 12px;
  font-weight: 800;
  color: #475569;
  min-width: 40px;
  text-align: right;
}

.goalActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.btnSecondary.danger {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
}
.btnSecondary.danger:hover:not(:disabled) {
  border-color: rgba(239, 68, 68, 0.6);
  background: rgba(239, 68, 68, 0.14);
}

.goalConfirmRow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.goalConfirmText {
  font-size: 12px;
  color: #475569;
  font-weight: 700;
}
</style>
