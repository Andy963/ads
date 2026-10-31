<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

type ReviewVerdict = {
  status: "PASS" | "REJECT";
  summary: string;
  defects: Array<{ file: string; line?: number; severity: string; description: string }>;
};

type VerificationReport = {
  command?: string;
  exitCode?: number;
  summary?: string;
  output?: string;
};

type ReviewJob = {
  id: string;
  job_kind: string;
  issue_title: string;
  status: string;
  current_step: string | null;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  error_message: string | null;
  verification_report_json: string;
  review_verdicts_json: string;
};

const props = withDefaults(defineProps<{ projectId: string; active?: boolean }>(), { active: true });

const jobs = ref<ReviewJob[]>([]);
const error = ref("");
let pollTimer: ReturnType<typeof setInterval> | null = null;
let requestSequence = 0;

const reviewJobs = computed(() => jobs.value.filter((job) => job.job_kind === "pull_request_review").slice(0, 8));
const hasActiveReview = computed(() => reviewJobs.value.some((job) =>
  ["queued", "running", "verifying", "reviewing"].includes(job.status),
));

function verdictFor(job: ReviewJob): ReviewVerdict | null {
  try {
    const parsed = JSON.parse(job.review_verdicts_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const verdict = parsed.at(-1) as Partial<ReviewVerdict> | undefined;
    if (!verdict || (verdict.status !== "PASS" && verdict.status !== "REJECT")) return null;
    return {
      status: verdict.status,
      summary: String(verdict.summary ?? ""),
      defects: Array.isArray(verdict.defects) ? verdict.defects : [],
    };
  } catch {
    return null;
  }
}

function verificationFor(job: ReviewJob): VerificationReport | null {
  try {
    const parsed = JSON.parse(job.verification_report_json) as unknown;
    return parsed && typeof parsed === "object" ? parsed as VerificationReport : null;
  } catch {
    return null;
  }
}

function statusLabel(job: ReviewJob): string {
  const verdict = verdictFor(job);
  if (verdict) return verdict.status;
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
  <section v-if="reviewJobs.length || error" class="actions-review-queue" aria-label="Actions reviewer queue">
    <header class="actions-review-queue__header">
      <strong>Actions reviewer queue</strong>
      <span>{{ reviewJobs.length }} review{{ reviewJobs.length === 1 ? "" : "s" }}</span>
    </header>
    <p v-if="error" class="actions-review-queue__error" role="alert">{{ error }}</p>
    <article v-for="job in reviewJobs" :key="job.id" class="actions-review-queue__job">
      <div class="actions-review-queue__title">
        <a v-if="job.pr_url" :href="job.pr_url" target="_blank" rel="noreferrer">PR #{{ job.pr_number }}</a>
        <span v-else>PR #{{ job.pr_number }}</span>
        <span :class="['actions-review-queue__status', `is-${statusLabel(job).toLowerCase()}`]">{{ statusLabel(job) }}</span>
      </div>
      <div class="actions-review-queue__issue">{{ job.issue_title }}</div>
      <div class="actions-review-queue__commits">
        Base {{ job.base_sha?.slice(0, 12) || "unknown" }} · Head {{ job.head_sha?.slice(0, 12) || "unknown" }}
      </div>
      <p v-if="job.current_step" class="actions-review-queue__detail">{{ job.current_step }}</p>
      <p v-if="verdictFor(job)" class="actions-review-queue__detail">{{ verdictFor(job)?.summary }}</p>
      <ul v-if="verdictFor(job)?.defects.length" class="actions-review-queue__findings">
        <li v-for="(defect, index) in verdictFor(job)?.defects" :key="`${defect.file}-${index}`">
          <strong>{{ defect.file }}<template v-if="defect.line">:{{ defect.line }}</template></strong>
          <span> ({{ defect.severity }}): {{ defect.description }}</span>
        </li>
      </ul>
      <p v-if="job.error_message" class="actions-review-queue__error">{{ job.error_message }}</p>
      <details v-if="verificationFor(job)" class="actions-review-queue__verification">
        <summary>Verification: {{ verificationFor(job)?.command }} (exit {{ verificationFor(job)?.exitCode }})</summary>
        <p>{{ verificationFor(job)?.summary }}</p>
        <pre v-if="verificationFor(job)?.output">{{ verificationFor(job)?.output }}</pre>
      </details>
    </article>
  </section>
</template>

<style scoped>
.actions-review-queue {
  flex: 0 0 auto;
  max-height: 220px;
  overflow: auto;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #d7dce2);
  background: var(--surface, #fff);
  color: var(--text-primary, #1f2937);
  font-size: 12px;
}

.actions-review-queue__header,
.actions-review-queue__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.actions-review-queue__header {
  margin-bottom: 6px;
}

.actions-review-queue__header > span,
.actions-review-queue__commits {
  color: var(--text-secondary, #667085);
}

.actions-review-queue__job + .actions-review-queue__job {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #d7dce2);
}

.actions-review-queue__title a {
  font-weight: 650;
}

.actions-review-queue__issue {
  margin-top: 3px;
  font-weight: 600;
}

.actions-review-queue__commits,
.actions-review-queue__detail {
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.actions-review-queue__status {
  color: var(--text-secondary, #667085);
  text-transform: capitalize;
}

.actions-review-queue__status.is-pass {
  color: #18794e;
}

.actions-review-queue__status.is-reject,
.actions-review-queue__error {
  color: #b42318;
}

.actions-review-queue__findings {
  margin: 5px 0 0;
  padding-left: 18px;
}

.actions-review-queue__verification {
  margin-top: 5px;
}

.actions-review-queue__verification pre {
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
