<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { fetchPullRequestDetail, fetchPullRequests } from "../api/pullRequests";
import {
  getPullRequestFirstPageCache,
  type PullRequestCacheFilters,
} from "../lib/pullRequestCache";
import type {
  PullRequestChecks,
  PullRequestDetail,
  PullRequestInvolvement,
  PullRequestListQuery,
  PullRequestState,
  PullRequestSummary,
} from "../../../ts-server/shared/pullRequests.js";

const props = defineProps<{ projectId: string; active?: boolean }>();

const state = ref<PullRequestState>("open");
const involvement = ref<PullRequestInvolvement>("all");
const checks = ref<PullRequestChecks>("all");
const labelDraft = ref("");
const labels = ref<string[]>([]);
const authorDraft = ref("");
const author = ref("");
const items = ref<PullRequestSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const cacheRestored = ref(false);
const selectedNumber = ref<number | null>(null);
const detail = ref<PullRequestDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const sentinel = ref<HTMLElement | null>(null);
let listController: AbortController | null = null;
let loadMoreController: AbortController | null = null;
let detailController: AbortController | null = null;
let requestGeneration = 0;
let intersectionObserver: IntersectionObserver | null = null;

const stateChoices: Array<{ id: PullRequestState; label: string }> = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "merged", label: "Merged" },
  { id: "all", label: "All" },
];
const involvementChoices: Array<{ id: PullRequestInvolvement; label: string }> = [
  { id: "all", label: "Everyone" },
  { id: "author", label: "Authored" },
  { id: "assignee", label: "Assigned" },
  { id: "mentions", label: "Mentions" },
  { id: "review-requested", label: "Review requested" },
];
const checkChoices: Array<{ id: PullRequestChecks; label: string }> = [
  { id: "all", label: "Any checks" },
  { id: "passing", label: "Passing" },
  { id: "failing", label: "Failing" },
  { id: "pending", label: "Pending" },
];

const filters = computed<PullRequestCacheFilters>(() => ({
  state: state.value,
  involvement: involvement.value,
  labels: labels.value,
  author: author.value,
  checks: checks.value,
}));

function query(cursor?: string, refresh = false): PullRequestListQuery {
  return {
    projectId: props.projectId,
    state: state.value,
    involvement: involvement.value,
    labels: labels.value,
    author: author.value,
    checks: checks.value,
    ...(cursor ? { cursor } : {}),
    limit: 20,
    ...(refresh ? { refresh: true } : {}),
  };
}

function dedupe(next: PullRequestSummary[]): PullRequestSummary[] {
  const seen = new Set(items.value.map((item) => item.number));
  return next.filter((item) => {
    if (seen.has(item.number)) return false;
    seen.add(item.number);
    return true;
  });
}

async function persistFirstPage(responseItems: PullRequestSummary[], fetchedAt: number): Promise<void> {
  const cache = getPullRequestFirstPageCache();
  if (!cache) return;
  try {
    await cache.save(props.projectId, filters.value, responseItems, fetchedAt);
  } catch {
    // IndexedDB is best-effort and may be unavailable in private contexts.
  }
}

async function loadScope(forceRefresh = false): Promise<void> {
  const generation = ++requestGeneration;
  listController?.abort();
  loadMoreController?.abort();
  listController = new AbortController();
  loading.value = true;
  loadingMore.value = false;
  error.value = "";
  items.value = [];
  nextCursor.value = null;
  cacheRestored.value = false;
  selectedNumber.value = null;
  detail.value = null;
  detailError.value = "";
  const cache = getPullRequestFirstPageCache();
  if (cache) {
    try {
      if (forceRefresh) {
        await cache.clearProject(props.projectId);
      } else {
        const record = await cache.load(props.projectId, filters.value);
        if (generation !== requestGeneration) return;
        if (record) {
          items.value = record.items;
          cacheRestored.value = true;
        }
      }
    } catch {
      // Cache failures must not prevent a live refresh.
    }
  }
  try {
    const response = await fetchPullRequests(query(undefined, forceRefresh), listController.signal);
    if (generation !== requestGeneration) return;
    error.value = response.error ?? "";
    if (response.error && response.items.length === 0 && items.value.length > 0) {
      return;
    }
    items.value = response.items;
    nextCursor.value = response.nextCursor;
    cacheRestored.value = false;
    await persistFirstPage(response.items, response.fetchedAt);
  } catch (cause) {
    if (generation !== requestGeneration || (cause instanceof DOMException && cause.name === "AbortError")) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (loading.value || loadingMore.value || !nextCursor.value) return;
  const generation = requestGeneration;
  loadMoreController?.abort();
  loadMoreController = new AbortController();
  loadingMore.value = true;
  error.value = "";
  try {
    const response = await fetchPullRequests(query(nextCursor.value), loadMoreController.signal);
    if (generation !== requestGeneration) return;
    items.value = [...items.value, ...dedupe(response.items)];
    nextCursor.value = response.nextCursor;
    error.value = response.error ?? "";
  } catch (cause) {
    if (generation !== requestGeneration || (cause instanceof DOMException && cause.name === "AbortError")) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === requestGeneration) loadingMore.value = false;
  }
}

async function openDetail(item: PullRequestSummary): Promise<void> {
  selectedNumber.value = item.number;
  detail.value = null;
  detailError.value = "";
  detailController?.abort();
  detailController = new AbortController();
  detailLoading.value = true;
  try {
    const response = await fetchPullRequestDetail(props.projectId, item.number, detailController.signal);
    if (selectedNumber.value !== item.number) return;
    detail.value = response.item ?? null;
    detailError.value = response.error ?? "";
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    detailError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (selectedNumber.value === item.number) detailLoading.value = false;
  }
}

function applyLabels(): void {
  labels.value = [...new Set(labelDraft.value.split(",").map((value) => value.trim()).filter(Boolean))];
}

function applyAuthor(): void {
  author.value = authorDraft.value.trim();
}

function clearFilters(): void {
  state.value = "open";
  involvement.value = "all";
  checks.value = "all";
  labelDraft.value = "";
  labels.value = [];
  authorDraft.value = "";
  author.value = "";
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || "-";
  return new Date(timestamp).toLocaleString();
}

function checkLabel(value: PullRequestSummary["checks"]): string {
  if (value === "passing") return "Checks passing";
  if (value === "failing") return "Checks failing";
  if (value === "pending") return "Checks pending";
  return "Checks unknown";
}

watch(filters, () => {
  void loadScope();
});

onMounted(async () => {
  await loadScope();
  await nextTick();
  if (sentinel.value && typeof IntersectionObserver !== "undefined") {
    intersectionObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "240px 0px" });
    intersectionObserver.observe(sentinel.value);
  }
});

onBeforeUnmount(() => {
  listController?.abort();
  loadMoreController?.abort();
  detailController?.abort();
  intersectionObserver?.disconnect();
});
</script>

<template>
  <section class="prWorkspace" :data-active="active !== false" data-testid="pull-requests-workspace">
    <div class="prFilterScroller" role="group" aria-label="Pull request filters">
      <div v-for="choice in stateChoices" :key="choice.id" class="prFilterGroup">
        <button
          type="button"
          class="prFilterChip"
          :class="{ active: state === choice.id }"
          :aria-pressed="state === choice.id"
          :data-testid="`pr-filter-state-${choice.id}`"
          @click="state = choice.id"
        >{{ choice.label }}</button>
      </div>
      <span class="prFilterDivider" aria-hidden="true" />
      <button
        v-for="choice in involvementChoices"
        :key="choice.id"
        type="button"
        class="prFilterChip"
        :class="{ active: involvement === choice.id }"
        :aria-pressed="involvement === choice.id"
        @click="involvement = choice.id"
      >{{ choice.label }}</button>
      <span class="prFilterDivider" aria-hidden="true" />
      <button
        v-for="choice in checkChoices"
        :key="choice.id"
        type="button"
        class="prFilterChip"
        :class="{ active: checks === choice.id }"
        :aria-pressed="checks === choice.id"
        @click="checks = choice.id"
      >{{ choice.label }}</button>
      <label class="prFilterInputWrap">
        <span>Labels</span>
        <input v-model="labelDraft" class="prFilterInput" placeholder="bug, enhancement" @change="applyLabels" @keydown.enter.prevent="applyLabels" />
      </label>
      <label class="prFilterInputWrap">
        <span>Author</span>
        <input v-model="authorDraft" class="prFilterInput" placeholder="login" @change="applyAuthor" @keydown.enter.prevent="applyAuthor" />
      </label>
      <button type="button" class="prClearFilters" @click="clearFilters">Clear</button>
      <button type="button" class="prRefresh" :disabled="loading" data-testid="pr-refresh" @click="loadScope(true)">Refresh</button>
    </div>

    <div v-if="error" class="prNotice prNotice--error" role="status" data-testid="pr-list-error">
      {{ error }}{{ items.length ? " · showing cached or partial rows" : "" }}
    </div>
    <div v-else-if="cacheRestored" class="prNotice" role="status" data-testid="pr-cache-status">Cached first page loaded; refreshing…</div>

    <div class="prContent">
      <div class="prListPane" :aria-busy="loading">
        <div v-if="loading && !items.length" class="prState" role="status">Loading pull requests…</div>
        <div v-else-if="!items.length" class="prState">
          <strong>No pull requests found</strong>
          <span>Adjust the filters or confirm this project has a GitHub remote.</span>
        </div>
        <ul v-else class="prList" aria-label="Pull requests">
          <li v-for="item in items" :key="item.number">
            <button
              type="button"
              class="prRow"
              :class="{ active: selectedNumber === item.number }"
              :data-testid="`pull-request-row-${item.number}`"
              @click="openDetail(item)"
            >
              <span class="prStateMark" :class="`prStateMark--${item.state.toLowerCase()}`" aria-hidden="true" />
              <span class="prRowMain">
                <span class="prRowTitleLine">
                  <span class="prRepoNumber">{{ item.repository }} #{{ item.number }}</span>
                  <span v-if="item.isDraft" class="prDraft">Draft</span>
                  <span class="prTitle">{{ item.title }}</span>
                </span>
                <span class="prMeta">
                  <span>{{ item.author || "unknown" }}</span>
                  <span>updated {{ formatUpdatedAt(item.updatedAt) }}</span>
                  <span class="prChecks" :class="`prChecks--${item.checks}`">{{ checkLabel(item.checks) }}</span>
                  <span class="prDiff prDiff--add">+{{ item.additions }}</span>
                  <span class="prDiff prDiff--del">-{{ item.deletions }}</span>
                </span>
                <span v-if="item.labels.length" class="prLabels">
                  <span v-for="label in item.labels" :key="label.name" class="prLabel">{{ label.name }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <div ref="sentinel" class="prSentinel" aria-hidden="true" />
        <button v-if="nextCursor" type="button" class="prLoadMore" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? "Loading…" : "Load more" }}
        </button>
      </div>

      <section v-if="selectedNumber !== null" class="prDetail" aria-label="Pull request detail" data-testid="pull-request-detail">
        <div v-if="detailLoading" class="prState" role="status">Loading PR detail…</div>
        <div v-else-if="detailError && !detail" class="prNotice prNotice--error" role="status">{{ detailError }}</div>
        <template v-else-if="detail">
          <header class="prDetailHeader">
            <div>
              <span class="prRepoNumber">{{ detail.repository }} #{{ detail.number }}</span>
              <h2>{{ detail.title }}</h2>
            </div>
            <a :href="detail.url" target="_blank" rel="noopener noreferrer" class="prOpenLink">Open on host</a>
          </header>
          <div v-if="detailError" class="prNotice prNotice--error" role="status">{{ detailError }}</div>
          <div class="prDetailFacts">
            <span>{{ detail.state }}</span>
            <span>{{ detail.reviewDecision || "No review decision" }}</span>
            <span>{{ detail.mergeable || "Mergeability unknown" }}</span>
            <span>{{ detail.headRefName }} → {{ detail.baseRefName }}</span>
          </div>
          <pre v-if="detail.body" class="prDetailBody">{{ detail.body }}</pre>
          <section v-if="detail.checksDetail.length" class="prDetailSection">
            <h3>Checks</h3>
            <ul>
              <li v-for="check in detail.checksDetail" :key="check.name">
                <span>{{ check.name }}</span>
                <span>{{ check.conclusion || check.status }}</span>
              </li>
            </ul>
          </section>
          <section v-if="detail.files.length" class="prDetailSection">
            <h3>Files</h3>
            <ul>
              <li v-for="file in detail.files" :key="file.path">
                <span>{{ file.path }}</span>
                <span>+{{ file.additions }} -{{ file.deletions }}</span>
              </li>
            </ul>
          </section>
          <section v-if="detail.reviews.length" class="prDetailSection">
            <h3>Reviews</h3>
            <ul>
              <li v-for="review in detail.reviews" :key="`${review.author}:${review.submittedAt}`">
                <span>{{ review.author }}</span>
                <span>{{ review.state }} · {{ formatUpdatedAt(review.submittedAt) }}</span>
              </li>
            </ul>
          </section>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.prWorkspace { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--app-bg); }
.prFilterScroller { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; overflow-x: auto; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.prFilterGroup { display: contents; }
.prFilterChip, .prClearFilters, .prRefresh { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--muted); padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.prFilterChip.active { background: var(--selection-bg); border-color: var(--accent); color: var(--accent); font-weight: 700; }
.prClearFilters { color: var(--danger); }
.prRefresh { color: var(--accent); }
.prFilterDivider { flex: 0 0 1px; height: 20px; background: var(--border); }
.prFilterInputWrap { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
.prFilterInput { width: 110px; border: 1px solid var(--border); border-radius: 8px; padding: 4px 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.prNotice { margin: 8px 12px 0; padding: 7px 10px; border-radius: 9px; background: var(--surface-2); color: var(--muted); font-size: 12px; }
.prNotice--error { background: #fef2f2; color: #b91c1c; }
.prContent { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); overflow: hidden; }
.prListPane { min-height: 0; overflow-y: auto; padding: 8px 12px 16px; }
.prList { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.prRow { width: 100%; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); padding: 10px; display: flex; gap: 9px; text-align: left; cursor: pointer; }
.prRow:hover, .prRow.active { border-color: var(--accent); background: var(--selection-bg); }
.prStateMark { width: 9px; height: 9px; border-radius: 999px; margin-top: 5px; flex: 0 0 auto; background: #16a34a; }
.prStateMark--closed { background: #dc2626; }
.prStateMark--merged { background: #7c3aed; }
.prRowMain { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
.prRowTitleLine { display: flex; gap: 7px; align-items: baseline; min-width: 0; flex-wrap: wrap; }
.prRepoNumber { color: var(--muted); font-size: 11px; font-family: var(--font-mono, monospace); }
.prTitle { font-size: 13px; font-weight: 650; }
.prDraft { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
.prMeta { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
.prChecks--passing { color: #15803d; }
.prChecks--failing { color: #b91c1c; }
.prChecks--pending { color: #b45309; }
.prDiff--add { color: #15803d; }
.prDiff--del { color: #b91c1c; }
.prLabels { display: flex; gap: 4px; flex-wrap: wrap; }
.prLabel { padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 10px; color: var(--muted); }
.prState { margin: 28px auto; max-width: 420px; display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--muted); text-align: center; }
.prSentinel { height: 1px; }
.prLoadMore { display: block; margin: 12px auto 0; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); color: var(--accent); padding: 6px 12px; cursor: pointer; }
.prDetail { min-height: 0; overflow-y: auto; padding: 12px; border-left: 1px solid var(--border); background: var(--surface); }
.prDetailHeader { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.prDetailHeader h2 { margin: 4px 0 0; font-size: 17px; }
.prOpenLink { flex: 0 0 auto; color: var(--accent); font-size: 12px; }
.prDetailFacts { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.prDetailFacts span { padding: 2px 7px; border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 11px; }
.prDetailBody { margin-top: 12px; padding: 10px; border-radius: 10px; background: var(--surface-2); white-space: pre-wrap; font: inherit; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.prDetailSection { margin-top: 14px; }
.prDetailSection h3 { margin: 0 0 6px; font-size: 13px; }
.prDetailSection ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.prDetailSection li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--border); font-size: 11px; }
@media (min-width: 980px) { .prContent { grid-template-columns: minmax(0, 1.35fr) minmax(320px, .9fr); } }
@media (max-width: 979px) { .prContent { display: flex; flex-direction: column; } .prListPane { flex: 1 1 auto; } .prDetail { flex: 0 0 min(52%, 440px); border-left: 0; border-top: 1px solid var(--border); } }
@media (max-width: 640px) { .prFilterInput { width: 92px; } .prRow { padding: 9px; } }
</style>
