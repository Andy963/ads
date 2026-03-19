<script setup lang="ts">
import { computed } from "vue";

import type { TaskDetail } from "../api/types";

const props = defineProps<{
  task: TaskDetail;
}>();

const emit = defineEmits<{
  (e: "refresh", id: string): void;
  (e: "cancel", id: string): void;
  (e: "retry", id: string): void;
  (e: "delete", id: string): void;
}>();

const canCancel = computed(() => props.task.status === "pending" || props.task.status === "planning" || props.task.status === "running");
const canRetry = computed(() => props.task.status === "failed" || props.task.status === "cancelled");
</script>

<template>
  <div class="header">
    <div class="header-left">
      <h2 class="title">{{ task.title }}</h2>
      <div class="meta">
        <span class="status" :data-status="task.status" :title="task.status" :aria-label="`状态: ${task.status}`" role="img">
          <svg v-if="task.status === 'pending'" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-1.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z" clip-rule="evenodd" />
          </svg>
          <svg v-else-if="task.status === 'planning'" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M4 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
          </svg>
          <svg v-else-if="task.status === 'running'" class="spin" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 3a7 7 0 1 0 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
          <svg v-else-if="task.status === 'completed'" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z" clip-rule="evenodd" />
          </svg>
          <svg v-else-if="task.status === 'failed'" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4.5a1 1 0 0 1 1 1v3.75a1 1 0 1 1-2 0V7.5a1 1 0 0 1 1-1Zm0 8.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" clip-rule="evenodd" />
          </svg>
          <svg v-else-if="task.status === 'cancelled'" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-2.75-10a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1-.75-.75v-4Z" clip-rule="evenodd" />
          </svg>
        </span>
        <span class="meta-item">{{ task.model }}</span>
      </div>
    </div>
    <div class="actions">
      <button class="iconBtn" type="button" title="刷新" aria-label="刷新任务" @click="emit('refresh', task.id)">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M15.31 4.69a.75.75 0 0 1 0 1.06l-1.1 1.1A6.5 6.5 0 1 1 10 3.5a.75.75 0 0 1 0 1.5A5 5 0 1 0 14 8.25h-1.75a.75.75 0 0 1 0-1.5H15a.75.75 0 0 1 .75.75V10a.75.75 0 0 1-1.5 0V7.56l-.85.85a.75.75 0 0 1-1.06-1.06l2.97-2.66Z" clip-rule="evenodd" />
        </svg>
      </button>
      <button class="iconBtn danger" type="button" title="终止" aria-label="终止任务" :disabled="!canCancel" @click="emit('cancel', task.id)">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M6 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm0 2h8v8H6V6Z" clip-rule="evenodd" />
        </svg>
      </button>
      <button class="iconBtn primary" type="button" title="重试" aria-label="重试任务" :disabled="!canRetry" @click="emit('retry', task.id)">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M10 3.5a6.5 6.5 0 0 0-6.46 5.75.75.75 0 0 0 1.49.18A5 5 0 1 1 10 15a.75.75 0 0 0 0 1.5A6.5 6.5 0 1 0 10 3.5Z" clip-rule="evenodd" />
          <path d="M4.5 6.25a.75.75 0 0 1 .75-.75H7.5a.75.75 0 0 1 0 1.5H6v1.5a.75.75 0 0 1-1.5 0V6.25Z" />
        </svg>
      </button>
      <button class="iconBtn danger" type="button" title="删除任务" aria-label="删除任务" :disabled="task.status === 'running' || task.status === 'planning'" @click="emit('delete', task.id)">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M7 3a1 1 0 0 0-1 1v1H4.75a.75.75 0 0 0 0 1.5h.7l.62 9.1A2 2 0 0 0 8.06 18h3.88a2 2 0 0 0 2-1.9l.62-9.1h.69a.75.75 0 0 0 0-1.5H14V4a1 1 0 0 0-1-1H7Zm1.5 2V4.5h3V5H8.5Zm-1.55 2.5.56 8.25c.03.43.39.75.82.75h3.34c.43 0 .79-.32.82-.75l.56-8.25H6.95Z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 14px 16px;
  background: white;
  border-bottom: 1px solid #e2e8f0;
  flex-wrap: wrap;
  gap: 10px;
}

.header-left {
  flex: 1;
  min-width: 0;
}

.title {
  margin: 0 0 6px 0;
  font-size: 16px;
  font-weight: 700;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.meta-item {
  font-size: 12px;
  color: #64748b;
}

.status {
  width: 26px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 999px;
}

.status[data-status="pending"] {
  background: #f1f5f9;
  color: #64748b;
}

.status[data-status="planning"] {
  background: #fef3c7;
  color: #d97706;
}

.status[data-status="running"] {
  background: #d1fae5;
  color: #059669;
}

.status[data-status="completed"] {
  background: #dbeafe;
  color: #2563eb;
}

.status[data-status="failed"] {
  background: #fee2e2;
  color: #dc2626;
}

.status[data-status="cancelled"] {
  background: #f1f5f9;
  color: #64748b;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.actions {
  display: flex;
  gap: 8px;
}

.iconBtn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: #f1f5f9;
  color: #475569;
}

.iconBtn:hover:not(:disabled) {
  background: #e2e8f0;
}

.iconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.iconBtn.primary {
  background: #2563eb;
  color: white;
}

.iconBtn.primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.iconBtn.danger {
  background: #fee2e2;
  color: #dc2626;
}

.iconBtn.danger:hover:not(:disabled) {
  background: #fecaca;
}

@media (max-width: 600px) {
  .header {
    flex-direction: column;
  }

  .actions {
    width: 100%;
  }

  .iconBtn {
    flex: 1;
    width: auto;
  }
}
</style>
