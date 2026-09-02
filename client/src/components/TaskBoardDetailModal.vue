<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Task, TaskGoalStatus } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

const props = defineProps<{
  task: Task;
  statusLabel: string;
  categoryLabel: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "goal-pause", taskId: string): void;
  (e: "goal-resume", taskId: string): void;
  (e: "goal-clear", taskId: string): void;
  (e: "review-action", payload: { taskId: string; action: "force_approve" | "edit_rework" | "skip_review" | "abort"; feedback?: string; reason?: string }): void;
  (e: "review-navigate", taskId: string): void;
}>();

const review = computed(() => props.task.review ?? null);
const reviewStatusLabel = computed(() => {
  switch (review.value?.status) {
    case "pending_review": return "Pending Review";
    case "in_review": return "In Review";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "needs_human_intervention": return "Needs Human Intervention";
    case "skipped": return "Skipped";
    case "error": return "Review Error";
    default: return "Not Required";
  }
});
function chainCategoryLabel(category: string | undefined): string {
  if (category === "review") return "Review";
  if (category === "rework") return "Rework";
  return "Development";
}
function chainStatusLabel(status: string): string {
  if (status === "completed") return "Completed";
  if (status === "running") return "Running";
  if (status === "pending") return "Pending";
  if (status === "cancelled") return "Cancelled";
  if (status === "failed") return "Failed";
  return status;
}
const reviewFeedback = ref("");
const reviewActionPending = ref(false);
const confirmingAbort = ref(false);
const canReviewAction = computed(() => Boolean(review.value?.required)
  && ["rejected", "needs_human_intervention", "error", "pending_review", "in_review"].includes(review.value?.status ?? ""));
watch(review, (next) => {
  reviewFeedback.value = next?.feedback ?? "";
}, { immediate: true });
function submitReviewAction(action: "force_approve" | "edit_rework" | "skip_review" | "abort"): void {
  if (!canReviewAction.value || reviewActionPending.value) return;
  if (action === "abort" && !confirmingAbort.value) {
    confirmingAbort.value = true;
    return;
  }
  if (action === "abort") confirmingAbort.value = false;
  reviewActionPending.value = true;
  emit("review-action", {
    taskId: props.task.id,
    action,
    feedback: action === "edit_rework" ? reviewFeedback.value : undefined,
    reason: action === "edit_rework" ? reviewFeedback.value : undefined,
  });
  window.setTimeout(() => { reviewActionPending.value = false; }, 500);
}

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
          <span class="detailMetaKey">类型</span>
          <span class="detailMetaValue">{{ props.categoryLabel }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">优先级</span>
          <span class="detailMetaValue detailMono">P{{ props.task.priority }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">模型</span>
          <span class="detailMetaValue detailMono">{{ props.task.model }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">执行隔离</span>
          <span class="detailMetaValue detailMono">{{ props.task.executionIsolation === "required" ? "独立 worktree" : "共享 workspace" }}</span>
        </div>
        <div class="detailMetaRow">
          <span class="detailMetaKey">ID</span>
          <span class="detailMetaValue detailMono">{{ props.task.id }}</span>
        </div>
        <div v-if="props.task.latestRun" class="detailMetaRow">
          <span class="detailMetaKey">最近 Run</span>
          <span class="detailMetaValue detailMono">{{ props.task.latestRun.id }}</span>
        </div>
        <template v-if="props.task.latestRun">
          <div class="detailMetaRow">
            <span class="detailMetaKey">隔离状态</span>
            <span class="detailMetaValue detailMono">{{ props.task.latestRun.status }} · {{ props.task.latestRun.cleanupStatus }}</span>
          </div>
          <div v-if="props.task.latestRun.branchName" class="detailMetaRow">
            <span class="detailMetaKey">任务分支</span>
            <span class="detailMetaValue detailMono">{{ props.task.latestRun.branchName }}</span>
          </div>
          <div v-if="props.task.latestRun.worktreeDir" class="detailMetaRow">
            <span class="detailMetaKey">Worktree</span>
            <span class="detailMetaValue detailMono">{{ props.task.latestRun.worktreeDir }}</span>
          </div>
        </template>
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

      <div v-if="review?.required" class="reviewPanel" data-testid="task-detail-review-panel">
        <div class="reviewPanelHeader">
          <span class="reviewPanelTitle">Code Review</span>
          <span class="reviewStatusBadge" :data-review-status="review.status">{{ reviewStatusLabel }}</span>
        </div>
        <div class="detailMetaGrid reviewMetaGrid">
          <div class="detailMetaRow"><span class="detailMetaKey">State reason</span><span class="detailMetaValue preWrap">{{ review.stateReason || "—" }}</span></div>
          <div v-if="review.pullRequestNumber" class="detailMetaRow"><span class="detailMetaKey">Pull request</span><a class="reviewPrLink" :href="review.pullRequestUrl ?? undefined" target="_blank" rel="noreferrer">PR #{{ review.pullRequestNumber }}</a></div>
          <div class="detailMetaRow"><span class="detailMetaKey">Reviewer</span><span class="detailMetaValue">{{ review.reviewerModelDisplayName || review.reviewerModelId || "—" }} ({{ review.reviewerAgentId || "—" }})</span></div>
          <div class="detailMetaRow"><span class="detailMetaKey">Started</span><span class="detailMetaValue detailMono">{{ review.reviewStartedAt ? new Date(review.reviewStartedAt).toLocaleString() : "—" }}</span></div>
          <div class="detailMetaRow"><span class="detailMetaKey">Reviewed</span><span class="detailMetaValue detailMono">{{ review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : "—" }}</span></div>
          <div class="detailMetaRow"><span class="detailMetaKey">Round</span><span class="detailMetaValue detailMono">{{ review.reworkRound }}/{{ review.maxReworkRounds }}</span></div>
          <div class="detailMetaRow"><span class="detailMetaKey">Root task</span><button type="button" class="reviewTaskLink detailMono" @click="emit('review-navigate', review.rootTaskId || props.task.id)">{{ review.rootTaskId || props.task.id }}</button></div>
          <div v-if="review.reviewTaskId" class="detailMetaRow"><span class="detailMetaKey">Review task</span><button type="button" class="reviewTaskLink detailMono" @click="emit('review-navigate', review.reviewTaskId)">{{ review.reviewTaskId }}</button></div>
          <div v-if="review.reworkTaskIds.length" class="detailMetaRow"><span class="detailMetaKey">Rework tasks</span><span class="detailMetaValue detailMono">{{ review.reworkTaskIds.join(", ") }}</span></div>
        </div>
        <div v-if="props.task.reviewChain?.length" class="reviewChain" data-testid="task-detail-review-chain">
          <div class="detailMetaKey">Related tasks</div>
          <div class="reviewChainList">
            <button
              v-for="entry in props.task.reviewChain"
              :key="entry.id"
              type="button"
              class="reviewTaskLink reviewChainItem"
              @click="emit('review-navigate', entry.id)"
            >{{ chainCategoryLabel(entry.category) }} · {{ entry.id }} · {{ chainStatusLabel(entry.status) }}</button>
          </div>
        </div>
        <div v-if="review.conclusion" class="reviewTextBlock"><div class="detailMetaKey">Conclusion</div><div class="preWrap">{{ review.conclusion }}</div></div>
        <div v-if="review.feedback" class="reviewTextBlock"><div class="detailMetaKey">Feedback</div><pre class="preWrap">{{ review.feedback }}</pre></div>
        <div v-if="review.output" class="reviewTextBlock"><div class="detailMetaKey">Reviewer output</div><pre class="preWrap">{{ review.output }}</pre></div>
        <div v-if="canReviewAction" class="reviewControls">
          <button type="button" class="btnSecondary btnCompact" :disabled="reviewActionPending" data-testid="review-detail-force-approve" @click="submitReviewAction('force_approve')">Force Approve</button>
          <textarea v-model="reviewFeedback" class="reviewFeedbackInput" rows="4" aria-label="Rework feedback" placeholder="Edit the rework instructions" />
          <button type="button" class="btnSecondary btnCompact" :disabled="reviewActionPending || !reviewFeedback.trim()" data-testid="review-detail-edit-rework" @click="submitReviewAction('edit_rework')">Edit &amp; Rework</button>
          <button type="button" class="btnSecondary btnCompact" :disabled="reviewActionPending" data-testid="review-detail-skip" @click="submitReviewAction('skip_review')">Skip Review</button>
          <span v-if="!confirmingAbort"><button type="button" class="btnSecondary btnCompact danger" :disabled="reviewActionPending" data-testid="review-detail-abort" @click="submitReviewAction('abort')">Abort</button></span>
          <span v-else class="reviewConfirm"><span>Abort chain?</span><button type="button" class="btnSecondary btnCompact" @click="confirmingAbort = false">Cancel</button><button type="button" class="btnSecondary btnCompact danger" @click="submitReviewAction('abort')">Confirm</button></span>
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

.reviewPanel {
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 14px;
  padding: 12px 14px;
  background: rgba(239, 246, 255, 0.72);
}

.reviewPanelHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.reviewPanelTitle { font-size: 15px; font-weight: 900; color: #0f172a; }
.reviewStatusBadge { border-radius: 999px; padding: 4px 9px; font-size: 11px; font-weight: 900; }
.reviewStatusBadge[data-review-status="approved"] { background: #bbf7d0; color: #166534; }
.reviewStatusBadge[data-review-status="rejected"], .reviewStatusBadge[data-review-status="error"] { background: #fecaca; color: #991b1b; }
.reviewStatusBadge[data-review-status="needs_human_intervention"] { background: #fed7aa; color: #9a3412; }
.reviewStatusBadge[data-review-status="in_review"] { background: #bfdbfe; color: #1d4ed8; }
.reviewStatusBadge[data-review-status="pending_review"] { background: #e0e7ff; color: #4338ca; }
.reviewStatusBadge[data-review-status="skipped"] { background: #e2e8f0; color: #475569; }
.reviewMetaGrid { background: rgba(255, 255, 255, 0.6); }
.reviewTextBlock { margin-top: 10px; color: #334155; font-size: 12px; }
.reviewTextBlock pre { margin: 5px 0 0; font: inherit; }
.reviewTaskLink {
  border: 0;
  padding: 0;
  color: #2563eb;
  background: transparent;
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
}
.reviewTaskLink:hover { color: #1d4ed8; }
.reviewChain {
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.55);
}
.reviewChainList { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.reviewChainItem {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.reviewControls { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 12px; }
.reviewFeedbackInput { flex: 1 1 100%; min-width: 0; border: 1px solid rgba(100, 116, 139, 0.35); border-radius: 10px; padding: 8px; resize: vertical; font: inherit; color: #0f172a; background: #fff; }
.reviewConfirm { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 800; }

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
