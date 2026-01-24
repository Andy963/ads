<script setup lang="ts">
import { computed } from "vue";
import type { Task } from "../api/types";

const props = defineProps<{ tasks: Task[]; selectedId?: string | null }>();
const emit = defineEmits<{ (e: "select", id: string): void }>();

const sorted = computed(() => {
  return [...props.tasks].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status.localeCompare(b.status);
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return b.createdAt - a.createdAt;
  });
});

function badge(status: string): string {
  switch (status) {
    case "pending":
      return "PENDING";
    case "planning":
      return "PLANNING";
    case "running":
      return "RUNNING";
    case "completed":
      return "DONE";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    default:
      return status;
  }
}
</script>

<template>
  <div class="list">
    <div class="header">
      <h3 class="list-title">任务列表</h3>
      <span class="count">{{ tasks.length }}</span>
    </div>

    <div v-if="tasks.length === 0" class="empty">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>暂无任务</span>
      <span class="empty-hint">创建一个新任务开始</span>
    </div>

    <button
      v-for="t in sorted"
      :key="t.id"
      class="row"
      :class="{ active: t.id === selectedId }"
      type="button"
      @click="emit('select', t.id)"
    >
      <div class="top">
        <span class="title">{{ t.title }}</span>
        <span class="status" :data-status="t.status">{{ badge(t.status) }}</span>
      </div>
      <div class="sub">
        <span class="meta">#{{ t.id.slice(0, 8) }}</span>
        <span class="meta">{{ t.model }}</span>
        <span class="meta">p={{ t.priority }}</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.list {
  display: grid;
  gap: 8px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.list-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1e293b;
}
.count {
  background: #e2e8f0;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  color: #64748b;
  text-align: center;
}
.empty-icon {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  color: #cbd5e1;
}
.empty-hint {
  font-size: 13px;
  color: #94a3b8;
  margin-top: 4px;
}
.row {
  text-align: left;
  width: 100%;
  border: none;
  border-radius: 12px;
  padding: 12px 16px;
  background: white;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.1s;
}
.row:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.row.active {
  background: #eff6ff;
  box-shadow: 0 0 0 2px #2563eb;
}
.top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.title {
  font-weight: 600;
  font-size: 14px;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  text-transform: uppercase;
  letter-spacing: 0.025em;
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
.sub {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.meta {
  color: #64748b;
  font-size: 12px;
}
</style>
