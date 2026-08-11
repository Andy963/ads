<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Close, Refresh, Search } from "@element-plus/icons-vue";

import type { ResumableSession, ResumableSessionsHidden } from "../app/controllerTypes";

const props = defineProps<{
  sessions: ResumableSession[];
  busy: boolean;
  error: string | null;
  agentId: string;
  hidden?: ResumableSessionsHidden | null;
  disabled?: boolean;
  disabledReason?: string;
  /** Continuation token from the last page; presence is what enables "load more". */
  nextCursor?: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "refresh", options: { search?: string; includeAllCwds: boolean; includeNoise: boolean }): void;
  (e: "load-more"): void;
  (e: "resume", sessionId: string | undefined): void;
}>();

const SOURCE_LABELS: Record<ResumableSession["source"], string> = {
  app_server: "Codex",
  rollout_file: "本地文件",
  ads_link: "ADS 记录",
  claude_transcript: "本地文件",
};

const search = ref("");
const includeAllCwds = ref(false);
const includeNoise = ref(false);

function requestRefresh(): void {
  emit("refresh", {
    search: search.value.trim() || undefined,
    includeAllCwds: includeAllCwds.value,
    includeNoise: includeNoise.value,
  });
}

onMounted(requestRefresh);
watch([includeAllCwds, includeNoise], requestRefresh);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(requestRefresh, 250);
});

const hasSessions = computed(() => props.sessions.length > 0);
const hasMore = computed(() => Boolean(props.nextCursor));

/**
 * One-shot sessions and repeated titles come from auto-continue bursts, which can
 * outnumber real conversations. They are hidden rather than dropped so the list
 * never silently misrepresents what exists on disk.
 */
const hiddenSummary = computed(() => {
  if (includeNoise.value) return "";
  const oneShot = props.hidden?.singleTurn ?? 0;
  const duplicates = props.hidden?.duplicates ?? 0;
  if (oneShot + duplicates === 0) return "";
  const parts: string[] = [];
  if (oneShot > 0) parts.push(`${oneShot} 个一次性会话`);
  if (duplicates > 0) parts.push(`${duplicates} 个重名会话`);
  return `已隐藏 ${parts.join("、")}`;
});

/**
 * Fork chains are reported separately from the noise counters: "显示全部" cannot
 * bring them back, because an older fork is a strictly worse resume target.
 */
const forkSummary = computed(() => {
  const forks = props.hidden?.forks ?? 0;
  if (forks === 0) return "";
  return `已合并 ${forks} 个同对话的历史分支，每个对话只保留最新的一个`;
});

function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function displayTitle(session: ResumableSession): string {
  return session.title?.trim() || session.preview?.trim() || `会话 ${session.sessionId.slice(0, 8)}`;
}

function onResume(session: ResumableSession): void {
  if (props.disabled) return;
  emit("resume", session.sessionId);
}
</script>

<template>
  <div class="sessionPicker" data-testid="session-resume-picker">
    <div class="pickerHeader">
      <div>
        <div class="pickerTitle">恢复会话</div>
        <div class="pickerSubtitle">
          选择一个此前的 {{ agentId || "代理" }} 会话，直接续接原生上下文
        </div>
      </div>
      <button class="pickerIconBtn" type="button" title="关闭" data-testid="session-picker-close" @click="emit('close')">
        <el-icon :size="16"><Close /></el-icon>
      </button>
    </div>

    <div class="pickerToolbar">
      <div class="pickerSearch">
        <el-icon :size="14" class="pickerSearchIcon"><Search /></el-icon>
        <input
          v-model="search"
          class="pickerSearchInput"
          type="text"
          placeholder="搜索标题或会话 ID"
          data-testid="session-picker-search"
        />
      </div>
      <label class="pickerToggle">
        <input v-model="includeAllCwds" type="checkbox" data-testid="session-picker-all-cwds" />
        <span>显示全部目录</span>
      </label>
      <button
        class="pickerIconBtn"
        type="button"
        title="刷新"
        :disabled="busy"
        data-testid="session-picker-refresh"
        @click="requestRefresh"
      >
        <el-icon :size="15"><Refresh /></el-icon>
      </button>
    </div>

    <div v-if="error" class="pickerNotice" data-testid="session-picker-error">{{ error }}</div>
    <div v-if="disabled && disabledReason" class="pickerNotice" data-testid="session-picker-disabled">
      {{ disabledReason }}
    </div>
    <div v-if="hiddenSummary" class="pickerHint" data-testid="session-picker-hidden">
      <span>{{ hiddenSummary }}</span>
      <button type="button" class="pickerLinkBtn" data-testid="session-picker-show-all" @click="includeNoise = true">
        显示全部
      </button>
    </div>
    <div v-if="forkSummary" class="pickerHint" data-testid="session-picker-forks">
      <span>{{ forkSummary }}</span>
    </div>

    <div class="pickerBody">
      <button
        class="sessionRow sessionRowLatest"
        type="button"
        :disabled="disabled"
        data-testid="session-picker-latest"
        @click="emit('resume', undefined)"
      >
        <div class="sessionMain">
          <div class="sessionTitle">恢复最近一次会话</div>
          <div class="sessionMeta">由 ADS 自动挑选，等同于旧的恢复按钮</div>
        </div>
      </button>

      <div v-if="busy && !hasSessions" class="pickerEmpty">正在加载会话列表…</div>
      <div v-else-if="!hasSessions" class="pickerEmpty" data-testid="session-picker-empty">
        当前目录下没有找到可恢复的会话
      </div>

      <button
        v-for="session in sessions"
        :key="session.sessionId"
        class="sessionRow"
        type="button"
        :disabled="disabled"
        :data-testid="`session-picker-item-${session.sessionId}`"
        @click="onResume(session)"
      >
        <div class="sessionMain">
          <div class="sessionTitle">
            {{ displayTitle(session) }}
            <span v-if="session.isCurrent" class="sessionBadge sessionBadgeCurrent">当前</span>
            <span v-if="(session.duplicateCount ?? 1) > 1" class="sessionBadge">×{{ session.duplicateCount }}</span>
            <span
              v-if="(session.forkCount ?? 1) > 1"
              class="sessionBadge"
              title="该对话产生过多个 provider 会话，这里是最新的一个"
              :data-testid="`session-picker-forks-${session.sessionId}`"
            >分支 {{ session.forkCount }}</span>
          </div>
          <div class="sessionMeta">
            <span class="sessionBadge">{{ SOURCE_LABELS[session.source] }}</span>
            <span>{{ formatRelativeTime(session.updatedAt) }}</span>
            <span v-if="session.messageCount">· {{ session.messageCount }} 条</span>
            <span v-else-if="session.userTurns">· {{ session.userTurns }} 轮</span>
            <span class="sessionCwd" :title="session.cwd">{{ session.cwd }}</span>
          </div>
        </div>
      </button>

      <button
        v-if="hasMore"
        class="pickerMoreBtn"
        type="button"
        :disabled="busy"
        data-testid="session-picker-load-more"
        @click="emit('load-more')"
      >
        {{ busy ? "加载中…" : "加载更多" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.sessionPicker {
  position: relative;
  width: 100%;
  height: min(620px, 86vh);
  max-height: min(620px, 86vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border-radius: 16px;
}

.pickerHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
}

.pickerTitle {
  font-size: 15px;
  font-weight: 800;
  color: var(--text);
}

.pickerSubtitle {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
}

.pickerToolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.pickerSearch {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}

.pickerSearchIcon {
  color: var(--muted);
  flex: 0 0 auto;
}

.pickerSearchInput {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  padding: 7px 0;
}

.pickerToggle {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.pickerIconBtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}

.pickerIconBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pickerNotice {
  flex: 0 0 auto;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--warning, #b45309);
  background: var(--surface-2, transparent);
}

.pickerHint {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  background: var(--surface-2, transparent);
}

.pickerLinkBtn {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: var(--primary, #2563eb);
  cursor: pointer;
  text-decoration: underline;
}

.pickerBody {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pickerEmpty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
}

.pickerMoreBtn {
  width: 100%;
  padding: 8px 12px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}

.pickerMoreBtn:disabled {
  cursor: default;
  opacity: 0.6;
}

.sessionRow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  text-align: left;
  cursor: pointer;
}

.sessionRow:hover:not(:disabled) {
  border-color: var(--accent, #4f46e5);
}

.sessionRow:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sessionRowLatest {
  border-style: dashed;
}

.sessionMain {
  min-width: 0;
  flex: 1 1 auto;
}

.sessionTitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessionMeta {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
}

.sessionCwd {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sessionBadge {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--muted);
}

.sessionBadgeCurrent {
  margin-left: 6px;
  color: var(--accent, #4f46e5);
  border-color: currentColor;
}
</style>
