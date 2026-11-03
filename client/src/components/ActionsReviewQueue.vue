<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

type ReviewJob = {
  id: string;
  job_kind: string;
  issue_title: string;
  status: string;
  pr_number: number | null;
  pr_url: string | null;
  created_at?: number;
};

const props = withDefaults(defineProps<{ projectId: string; active?: boolean }>(), { active: true });

const jobs = ref<ReviewJob[]>([]);
const error = ref("");
let pollTimer: ReturnType<typeof setInterval> | null = null;
let requestSequence = 0;

const activeStatuses = new Set(["queued", "running", "verifying", "reviewing"]);
const reviewJobs = computed(() => jobs.value.filter((job) => job.job_kind === "pull_request_review"));
const activeReviewJobs = computed(() => reviewJobs.value
  .filter((job) => activeStatuses.has(job.status))
  .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0)));
const currentReviewJob = computed(() => activeReviewJobs.value[0] ?? null);
const hasActiveReview = computed(() => activeReviewJobs.value.length > 0);

function statusLabel(job: ReviewJob): string {
  return job.status.replaceAll("_", " ");
}

function syncPolling(): void {
  if (props.active && hasActiveReview.value && pollTimer === null) {
    pollTimer = setInterval(() => void loadJobs(), 3000);
  } else if ((!props.active || !hasActiveReview.value) && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadJobs(): Promise<void> {
  const sequence = ++requestSequence;
  const projectId = String(props.projectId ?? "").trim();
  if (!projectId) {
    jobs.value = [];
    error.value = "";
    return;
  }
  try {
    const response = await fetch(`/api/actions/jobs?projectId=${encodeURIComponent(projectId)}`, {
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Unable to load Actions jobs (HTTP ${response.status}).`);
    const payload = await response.json() as unknown;
    if (sequence !== requestSequence) return;
    if (!Array.isArray(payload)) throw new Error("The Actions job response is invalid.");
    jobs.value = payload.filter((job): job is ReviewJob => Boolean(job) && typeof job === "object");
    error.value = "";
  } catch (reason) {
    if (sequence !== requestSequence) return;
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

watch(() => props.projectId, () => {
  requestSequence += 1;
  jobs.value = [];
  error.value = "";
  if (props.active) void loadJobs();
});

watch(() => props.active, (active) => {
  if (active) void loadJobs();
}, { immediate: true });

watch([() => props.active, hasActiveReview], syncPolling);

onBeforeUnmount(() => {
  requestSequence += 1;
  if (pollTimer !== null) clearInterval(pollTimer);
});
</script>

<template>
  <section v-if="currentReviewJob || error" class="actionsJobBanner actions-review-queue" aria-label="Actions reviewer queue">
    <p v-if="error" class="actions-review-queue__error" role="alert">{{ error }}</p>
    <article v-if="currentReviewJob" class="actionsQueueCard actions-review-queue__card" data-testid="actions-review-card">
      <div class="actions-review-queue__meta">
        <span :class="['actionsJobBadge', `actionsJobBadge--${currentReviewJob.status}`]">{{ statusLabel(currentReviewJob).toUpperCase() }}</span>
        <a v-if="currentReviewJob.pr_url" :href="currentReviewJob.pr_url" target="_blank" rel="noreferrer">PR #{{ currentReviewJob.pr_number }}</a>
        <span v-else>PR #{{ currentReviewJob.pr_number }}</span>
        <span v-if="activeReviewJobs.length > 1" class="actions-review-queue__count">+{{ activeReviewJobs.length - 1 }} queued</span>
      </div>
      <div class="actions-review-queue__issue" :title="currentReviewJob.issue_title">{{ currentReviewJob.issue_title }}</div>
    </article>
  </section>
</template>

<style scoped>
.actions-review-queue {
  margin: 8px 12px 0;
  font-size: 12px;
}

.actions-review-queue__card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 8px 12px;
  min-width: 0;
}

.actions-review-queue__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  line-height: 1.45;
}

.actions-review-queue__meta a {
  font-weight: 650;
}

.actionsJobBadge {
  display: inline-block;
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--muted);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
}

.actionsJobBadge--running,
.actionsJobBadge--verifying,
.actionsJobBadge--reviewing {
  background: var(--accent);
}

.actions-review-queue__count {
  color: var(--text-secondary, #667085);
  margin-left: auto;
}

.actions-review-queue__issue {
  margin-top: 3px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions-review-queue__error {
  color: #b42318;
  margin: 0 0 6px;
}
</style>
