<script setup lang="ts">
import { ChatDotRound, Refresh } from "@element-plus/icons-vue";

type HeaderAction = { title: string; ariaLabel?: string; testId?: string };
type HeaderResumeAction = { title: string; ariaLabel?: string; testId?: string; disabled?: boolean };

const props = defineProps<{
  title: string;
  busy: boolean;
  headerAction?: HeaderAction;
  headerResumeAction?: HeaderResumeAction;
}>();

const emit = defineEmits<{
  (e: "newSession"): void;
  (e: "resumeThread"): void;
}>();
</script>

<template>
  <div class="paneHeader">
    <div class="paneTitle">{{ props.title }}</div>
    <div class="paneHeaderActions">
      <button
        v-if="props.headerResumeAction"
        class="paneHeaderIconBtn"
        type="button"
        :title="props.headerResumeAction.title"
        :aria-label="props.headerResumeAction.ariaLabel || props.headerResumeAction.title"
        :disabled="props.busy || Boolean(props.headerResumeAction.disabled)"
        :data-testid="props.headerResumeAction.testId"
        @click.stop="emit('resumeThread')"
      >
        <el-icon :size="16" aria-hidden="true">
          <Refresh />
        </el-icon>
      </button>
      <button
        v-if="props.headerAction"
        class="paneHeaderIconBtn"
        type="button"
        :title="props.headerAction.title"
        :aria-label="props.headerAction.ariaLabel || props.headerAction.title"
        :disabled="props.busy"
        :data-testid="props.headerAction.testId"
        @click.stop="emit('newSession')"
      >
        <el-icon :size="16" aria-hidden="true">
          <ChatDotRound />
        </el-icon>
      </button>
    </div>
  </div>
</template>

<style scoped>
.paneHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.paneTitle {
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
  letter-spacing: 0.02em;
}

.paneHeaderActions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.paneHeaderIconBtn {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.paneHeaderIconBtn:hover:not(:disabled) {
  color: var(--text);
  background: rgba(15, 23, 42, 0.04);
}

.paneHeaderIconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
