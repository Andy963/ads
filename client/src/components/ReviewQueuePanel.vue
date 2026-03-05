<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Refresh } from "@element-plus/icons-vue";

import DraggableModal from "./DraggableModal.vue";

import type { ApiClient } from "../api/client";
import type { ReviewQueueItem, ReviewQueueItemStatus, ReviewQueueResponse, ReviewSnapshot } from "../api/types";

const props = defineProps<{
  api: ApiClient;
  workspaceRoot: string | null;
}>();

const expanded = ref(true);
const filterStatus = ref<ReviewQueueItemStatus | "">("");
const items = ref<ReviewQueueItem[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);

const selectedItem = ref<ReviewQueueItem | null>(null);
const snapshot = ref<ReviewSnapshot | null>(null);
const snapshotBusy = ref(false);
const snapshotError = ref<string | null>(null);

const workspaceReady = computed(() => Boolean(String(props.workspaceRoot ?? "").trim()));

const withWorkspaceQuery = (apiPath: string): string => {
  const root = String(props.workspaceRoot ?? "").trim();
  if (!root) return apiPath;
  const joiner = apiPath.includes("?") ? "&" : "?";
  return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
};

function statusLabel(status: ReviewQueueItemStatus): string {
  switch (status) {
    case "pending":
      return "待审";
    case "running":
      return "审核中";
    case "passed":
      return "通过";
    case "rejected":
      return "驳回";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function formatTs(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

const counts = computed(() => {
  const out: Record<ReviewQueueItemStatus, number> = { pending: 0, running: 0, passed: 0, rejected: 0, failed: 0 };
  for (const item of items.value) {
    out[item.status] = (out[item.status] ?? 0) + 1;
  }
  return out;
});

const totalCount = computed(() => items.value.length);

async function loadQueue(): Promise<void> {
  if (!workspaceReady.value) {
    items.value = [];
    error.value = null;
    return;
  }

  busy.value = true;
  error.value = null;
  try {
    const qp = new URLSearchParams();
    qp.set("limit", "80");
    if (filterStatus.value) {
      qp.set("status", filterStatus.value);
    }
    const res = await props.api.get<ReviewQueueResponse>(withWorkspaceQuery(`/api/review-queue?${qp.toString()}`));
    items.value = Array.isArray(res.items) ? res.items : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
  } finally {
    busy.value = false;
  }
}

async function openSnapshot(item: ReviewQueueItem): Promise<void> {
  selectedItem.value = item;
  snapshot.value = null;
  snapshotBusy.value = true;
  snapshotError.value = null;
  try {
    const sid = encodeURIComponent(String(item.snapshotId ?? "").trim());
    snapshot.value = await props.api.get<ReviewSnapshot>(withWorkspaceQuery(`/api/review-snapshots/${sid}`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    snapshotError.value = msg;
  } finally {
    snapshotBusy.value = false;
  }
}

function closeSnapshot(): void {
  selectedItem.value = null;
  snapshot.value = null;
  snapshotError.value = null;
  snapshotBusy.value = false;
}

let pollTimer: number | null = null;

function clearPoll(): void {
  if (pollTimer === null) return;
  try {
    window.clearInterval(pollTimer);
  } catch {
    // ignore
  }
  pollTimer = null;
}

const shouldPoll = computed(() => {
  if (!expanded.value) return false;
  if (!workspaceReady.value) return false;
  return items.value.some((i) => i.status === "pending" || i.status === "running");
});

watch(
  [() => props.workspaceRoot, () => filterStatus.value],
  () => {
    void loadQueue();
  },
  { immediate: true },
);

watch(
  () => expanded.value,
  (isExpanded) => {
    if (!isExpanded) {
      clearPoll();
      return;
    }
    void loadQueue();
  },
);

watch(
  () => shouldPoll.value,
  (enabled) => {
    if (!enabled) {
      clearPoll();
      return;
    }
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => {
      void loadQueue();
    }, 3000);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearPoll();
});
</script>

<template>
  <section class="reviewPanel" data-testid="review-queue-panel">
    <header class="reviewHeader">
      <button
        type="button"
        class="reviewToggle"
        :aria-expanded="expanded"
        data-testid="review-queue-toggle"
        @click="expanded = !expanded"
      >
        <span class="reviewTitle">审核队列</span>
        <span class="reviewCount" :class="{ 'reviewCount--active': totalCount > 0 }">{{ totalCount }}</span>
      </button>

      <div class="reviewHeaderActions">
        <select v-model="filterStatus" class="reviewSelect" data-testid="review-queue-filter" :disabled="busy">
          <option value="">全部</option>
          <option value="pending">待审 ({{ counts.pending }})</option>
          <option value="running">审核中 ({{ counts.running }})</option>
          <option value="passed">通过 ({{ counts.passed }})</option>
          <option value="rejected">驳回 ({{ counts.rejected }})</option>
          <option value="failed">失败 ({{ counts.failed }})</option>
        </select>

        <button
          type="button"
          class="reviewIconButton"
          :disabled="busy"
          data-testid="review-queue-refresh"
          title="刷新"
          @click="loadQueue"
        >
          <Refresh />
        </button>
      </div>
    </header>

    <div v-if="expanded" class="reviewBody">
      <div v-if="!workspaceReady" class="reviewEmpty">未选择工作区</div>
      <div v-else-if="error" class="reviewError" data-testid="review-queue-error">{{ error }}</div>
      <div v-else-if="busy && items.length === 0" class="reviewEmpty">加载中…</div>
      <div v-else-if="items.length === 0" class="reviewEmpty">暂无审核任务</div>
      <div v-else class="reviewList">
        <div
          v-for="item in items"
          :key="item.id"
          class="reviewRow"
          :data-testid="`review-queue-item-${item.id}`"
          @click="openSnapshot(item)"
        >
          <span class="reviewStatus" :class="`reviewStatus--${item.status}`">
            {{ statusLabel(item.status) }}
          </span>

          <div class="reviewRowMain">
            <div class="reviewRowTitle" :title="item.taskTitle || item.taskId">
              {{ item.taskTitle || item.taskId }}
            </div>
            <div class="reviewRowMeta">
              <span class="mono">{{ item.taskId.slice(0, 8) }}</span>
              <span v-if="item.createdAt" class="metaSep">·</span>
              <span v-if="item.createdAt">{{ formatTs(item.createdAt) }}</span>
            </div>
            <div v-if="item.conclusion" class="reviewRowConclusion" :title="item.conclusion">
              {{ item.conclusion }}
            </div>
            <div v-else-if="item.error" class="reviewRowError" :title="item.error">
              {{ item.error }}
            </div>
          </div>

          <button
            type="button"
            class="reviewRowBtn"
            data-testid="review-queue-item-open"
            title="查看快照"
            @click.stop="openSnapshot(item)"
          >
            查看
          </button>
        </div>
      </div>
    </div>
  </section>

  <DraggableModal
    v-if="selectedItem"
    card-variant="large"
    data-testid="review-snapshot-modal"
    @close="closeSnapshot"
  >
    <div class="snapshotHeader" data-drag-handle>
      <div class="snapshotTitle">Review Snapshot</div>
      <button class="snapshotClose" type="button" aria-label="关闭" title="关闭" @click="closeSnapshot">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>

    <div class="snapshotBody">
      <div class="snapshotMeta">
        <div><span class="metaKey">Task</span> <span class="mono">{{ selectedItem.taskId }}</span></div>
        <div><span class="metaKey">Snapshot</span> <span class="mono">{{ selectedItem.snapshotId }}</span></div>
        <div v-if="selectedItem.conclusion"><span class="metaKey">Conclusion</span> {{ selectedItem.conclusion }}</div>
        <div v-if="selectedItem.error" class="snapshotErrorText"><span class="metaKey">Error</span> {{ selectedItem.error }}</div>
      </div>

      <div v-if="snapshotError" class="snapshotError">{{ snapshotError }}</div>
      <div v-else-if="snapshotBusy" class="snapshotEmpty">加载中…</div>
      <div v-else-if="!snapshot" class="snapshotEmpty">未找到快照</div>
      <div v-else class="snapshotContent">
        <div class="snapshotSection">
          <div class="snapshotSectionTitle">Changed Files ({{ snapshot.changedFiles.length }})</div>
          <div v-if="snapshot.changedFiles.length === 0" class="snapshotEmptyInline">(none)</div>
          <ul v-else class="snapshotFiles">
            <li v-for="(p, idx) in snapshot.changedFiles" :key="idx" class="mono">{{ p }}</li>
          </ul>
        </div>

        <div class="snapshotSection">
          <div class="snapshotSectionTitle">Diff</div>
          <div v-if="snapshot.patch?.truncated" class="snapshotHint">⚠️ diff is truncated</div>
          <pre class="snapshotDiff">{{ snapshot.patch?.diff || "" }}</pre>
        </div>

        <div v-if="snapshot.lintSummary || snapshot.testSummary" class="snapshotSection">
          <div class="snapshotSectionTitle">Summaries</div>
          <div v-if="snapshot.lintSummary" class="snapshotSummary"><span class="metaKey">Lint</span> {{ snapshot.lintSummary }}</div>
          <div v-if="snapshot.testSummary" class="snapshotSummary"><span class="metaKey">Test</span> {{ snapshot.testSummary }}</div>
        </div>
      </div>
    </div>
  </DraggableModal>
</template>

<style src="./ReviewQueuePanel.css" scoped></style>

