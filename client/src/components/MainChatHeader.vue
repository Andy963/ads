<script setup lang="ts">
import { computed } from "vue";
import { ChatDotRound, Delete, Refresh } from "@element-plus/icons-vue";

import type { ModelConfig } from "../api/types";
import MainChatModelPopover from "./MainChatModelPopover.vue";

type HeaderAction = { title: string; ariaLabel?: string; testId?: string };
type HeaderResumeAction = { title: string; ariaLabel?: string; testId?: string; disabled?: boolean };
type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const props = defineProps<{
  title: string;
  busy: boolean;
  connected: boolean;
  inputLocked?: boolean;
  agents?: AgentOption[];
  activeAgentId?: string;
  models?: ModelConfig[];
  modelId?: string;
  modelReasoningEffort?: string;
  headerAction?: HeaderAction;
  headerClearAction?: HeaderAction;
  headerResumeAction?: HeaderResumeAction;
  threadWarning?: string | null;
}>();

const emit = defineEmits<{
  (e: "newSession"): void;
  (e: "clear"): void;
  (e: "resumeThread"): void;
  (e: "switchAgent", agentId: string): void;
  (e: "setModel", modelId: string): void;
  (e: "setReasoningEffort", effort: string): void;
}>();

const hasModelSettings = computed(() => props.agents !== undefined || props.models !== undefined);
</script>

<template>
  <div class="paneHeader" :class="{ 'paneHeader--withWarning': Boolean(props.threadWarning) }">
    <div class="paneHeaderMain">
      <div class="paneTitle">{{ props.title }}</div>
      <div v-if="props.threadWarning" class="paneHeaderWarning" data-testid="main-chat-thread-warning">
        {{ props.threadWarning }}
      </div>
    </div>
    <div class="paneHeaderActions">
      <MainChatModelPopover
        v-if="hasModelSettings"
        :connected="props.connected"
        :busy="props.busy"
        :input-locked="props.inputLocked"
        :agents="props.agents"
        :active-agent-id="props.activeAgentId"
        :models="props.models"
        :model-id="props.modelId"
        :model-reasoning-effort="props.modelReasoningEffort"
        @switch-agent="emit('switchAgent', $event)"
        @set-model="emit('setModel', $event)"
        @set-reasoning-effort="emit('setReasoningEffort', $event)"
      />
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
      <button
        v-if="props.headerClearAction"
        class="paneHeaderIconBtn"
        type="button"
        :title="props.headerClearAction.title || '清空会话'"
        :aria-label="props.headerClearAction.ariaLabel || props.headerClearAction.title || '清空会话'"
        :disabled="props.busy"
        :data-testid="props.headerClearAction.testId || 'main-chat-header-clear'"
        @click.stop="emit('clear')"
      >
        <el-icon :size="15" aria-hidden="true">
          <Delete />
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
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.paneHeader--withWarning {
  align-items: flex-start;
}

.paneHeaderMain {
  min-width: 0;
  flex: 1 1 auto;
}

.paneTitle {
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
  letter-spacing: 0.02em;
}

.paneHeaderWarning {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.35;
  color: #c2410c;
  word-break: break-word;
}

.paneHeaderActions {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  flex: 0 0 auto;
}

.paneHeader--withWarning .paneHeaderActions {
  padding-top: 1px;
  align-self: flex-start;
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
