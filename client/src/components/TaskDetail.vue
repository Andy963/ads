<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { TaskDetail } from "../api/types";
import MarkdownContent from "./MarkdownContent.vue";
import AttachmentThumb from "./AttachmentThumb.vue";
import TaskDetailHeader from "./TaskDetailHeader.vue";
import { autosizeTextarea } from "../lib/textarea_autosize";
import { isPatchMessageMarkdown } from "../lib/patch_message";
import { copyTextToClipboard } from "../lib/clipboard";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
  ts?: number;
  streaming?: boolean;
};

const props = defineProps<{ task: TaskDetail | null; messages: ChatMessage[]; apiToken?: string }>();
const emit = defineEmits<{
  (e: "cancel", id: string): void;
  (e: "retry", id: string): void;
  (e: "refresh", id: string): void;
  (e: "delete", id: string): void;
  (e: "send", content: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const showScrollToBottom = ref(false);
const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);

const copiedMessageId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const isRunning = computed(() => {
  const t = props.task;
  if (!t) return false;
  return t.status === "pending" || t.status === "planning" || t.status === "running";
});

const showPendingReply = computed(() => {
  if (!props.task || !isRunning.value) return false;
  const lastAssistant = [...props.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.kind === "text");
  if (!lastAssistant) return true;
  return !String(lastAssistant.content ?? "").trim();
});

const resizeComposer = (): void => {
  const el = inputEl.value;
  if (!el) return;
  autosizeTextarea(el, { minRows: 3, maxRows: 8 });
};

watch([input, inputEl], resizeComposer, { flush: "post" });

function withTokenQuery(url: string): string {
  const token = String(props.apiToken ?? "").trim();
  if (!token) return url;
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}token=${encodeURIComponent(token)}`;
}

function handleScroll() {
  if (!listRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  const distance = scrollHeight - scrollTop - clientHeight;
  autoScroll.value = distance < 80;
  showScrollToBottom.value = distance >= 80;
}

async function scrollToBottom(): Promise<void> {
  if (!listRef.value) return;
  await nextTick();
  listRef.value.scrollTop = listRef.value.scrollHeight;
  autoScroll.value = true;
  showScrollToBottom.value = false;
}

watch(
  () => props.messages.length,
  async () => {
    if (autoScroll.value && listRef.value) {
      await nextTick();
      listRef.value.scrollTop = listRef.value.scrollHeight;
      showScrollToBottom.value = false;
      return;
    }
    showScrollToBottom.value = true;
  },
);

function send(): void {
  const text = input.value.trim();
  if (!text) return;
  emit("send", text);
  input.value = "";
}

function clearCopiedToast(): void {
  if (copiedTimer) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  copiedMessageId.value = null;
}

function shouldShowMsgActions(m: ChatMessage): boolean {
  if (m.streaming && m.content.length === 0) return false;
  // Patch diffs are machine-generated; hide copy/timestamp chrome to keep them compact.
  if (m.kind === "text" && m.role === "system" && isPatchMessageMarkdown(m.content)) return false;
  return m.kind !== "command";
}

async function onCopyMessage(message: ChatMessage): Promise<void> {
  const ok = await copyTextToClipboard(message.content);
  if (!ok) return;
  clearCopiedToast();
  copiedMessageId.value = message.id;
  copiedTimer = setTimeout(() => {
    copiedMessageId.value = null;
    copiedTimer = null;
  }, 1400);
}

function formatMessageTs(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const pad2 = (num: number) => String(num).padStart(2, "0");
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay) return time;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function onInputKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Enter") return;
  if ((ev as { isComposing?: boolean }).isComposing) return;
  if (ev.altKey) return; // Alt+Enter: newline
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  send();
}

onBeforeUnmount(() => {
  // noop; keep hook for symmetry (some browsers keep composition state)
  clearCopiedToast();
});
</script>

<template>
  <div v-if="!task" class="empty">
    <span class="empty-text">选择一个任务开始对话</span>
  </div>
  <div v-else class="detail">
    <TaskDetailHeader
      :task="task"
      @refresh="emit('refresh', $event)"
      @cancel="emit('cancel', $event)"
      @retry="emit('retry', $event)"
      @delete="emit('delete', $event)"
    />

    <div v-if="task.attachments && task.attachments.length" class="attachmentsStrip" aria-label="任务附件">
      <AttachmentThumb
        v-for="a in task.attachments"
        :key="a.id"
        :src="withTokenQuery(a.url)"
        :href="withTokenQuery(a.url)"
        :width="10"
        :height="10"
        :title="`${a.contentType} ${a.width}x${a.height}`"
      />
    </div>

    <div ref="listRef" class="chat" @scroll="handleScroll">
      <div v-if="messages.length === 0" class="chat-empty">
        <span v-if="task.status === 'queued'">排队中...</span>
        <span v-else-if="task.status === 'pending'">等待开始...</span>
        <span v-else-if="task.status === 'planning'">准备中...</span>
        <span v-else-if="task.status === 'running'">执行中...</span>
        <span v-else-if="task.status === 'paused'">已暂停</span>
        <span v-else>暂无消息</span>
      </div>
      <div v-for="m in messages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div class="bubble" :class="{ hasActions: shouldShowMsgActions(m) }">
          <pre v-if="m.kind === 'command'" class="mono">{{ m.content }}</pre>
          <MarkdownContent v-else :content="m.content" :tone="m.role === 'user' ? 'inverted' : 'default'" />
          <div v-if="shouldShowMsgActions(m)" class="msgActions">
            <button class="msgCopyBtn" type="button" aria-label="复制消息" @click="onCopyMessage(m)">
              <svg v-if="copiedMessageId === m.id" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            <span v-if="m.ts" class="msgTime">{{ formatMessageTs(m.ts) }}</span>
          </div>
          <span v-if="m.streaming" class="cursor">▍</span>
        </div>
      </div>
      <div v-if="messages.length > 0 && showPendingReply" class="chat-placeholder">
        <span v-if="task.status === 'queued'">排队中...</span>
        <span v-else-if="task.status === 'pending'">等待开始...</span>
        <span v-else-if="task.status === 'planning'">准备中...</span>
        <span v-else-if="task.status === 'paused'">已暂停</span>
        <span v-else>执行中...</span>
      </div>
      <button
        v-if="showScrollToBottom"
        class="scrollToBottom"
        type="button"
        aria-label="滚动到底部"
        title="返回底部"
        @click="scrollToBottom"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </button>
    </div>

    <div class="composer">
      <textarea
        v-model="input"
        ref="inputEl"
        rows="3"
        class="composer-input"
        aria-label="输入指令"
        :placeholder="isRunning ? '继续输入指令…（Enter 发送，Alt+Enter 换行）' : '输入指令…（Enter 发送，Alt+Enter 换行）'"
        @keydown="onInputKeydown"
      />
      <button class="send" :disabled="!input.trim()" type="button" aria-label="发送指令" @click="send">发送</button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 400px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  color: #64748b;
}

.empty-text {
  font-size: 14px;
}

.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}

.attachmentsStrip {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: 10px;
  gap: 6px;
  padding: 0 16px;
  overflow-x: auto;
  overflow-y: hidden;
  background: rgba(248, 250, 252, 0.9);
  background-image: linear-gradient(#e2e8f0, #e2e8f0);
  background-size: 100% 1px;
  background-position: 0 100%;
  background-repeat: no-repeat;
}

.chat {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 14px 10px 14px;
  background: #f8fafc;
  min-height: 0;
  position: relative;
}

.chat-empty {
  padding: 18px;
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
}

.chat-placeholder {
  margin: 10px 12px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px dashed rgba(148, 163, 184, 0.45);
  background: rgba(248, 250, 252, 0.9);
  color: #64748b;
  font-size: 12px;
  text-align: center;
}

.scrollToBottom {
  position: sticky;
  float: right;
  bottom: 12px;
  right: 12px;
  margin-top: 8px;
  border: none;
  background: transparent;
  color: #475569;
  cursor: pointer;
  padding: 2px;
  z-index: 2;
}

.scrollToBottom:hover {
  color: #0f172a;
}

.msg {
  display: flex;
  margin-bottom: 10px;
}

.msg[data-role="user"] {
  justify-content: flex-end;
}

.msg[data-role="assistant"] {
  justify-content: flex-start;
}

.msg[data-role="system"] {
  justify-content: center;
}

.bubble {
  max-width: min(900px, 100%);
  border-radius: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: white;
  position: relative;
}

.bubble.hasActions {
  padding-bottom: 34px;
}

.msgActions {
  position: absolute;
  left: 12px;
  bottom: 10px;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  opacity: 0.55;
  transition: opacity 120ms ease;
}

.msg:hover .msgActions {
  opacity: 1;
}

.msgCopyBtn {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgba(226, 232, 240, 0.95);
  background: rgba(255, 255, 255, 0.92);
  color: #64748b;
  border-radius: 999px;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.msgCopyBtn:hover {
  color: #0f172a;
  background: #ffffff;
}

.msgTime {
  font-size: 11px;
  line-height: 1;
  padding: 2px;
  color: #94a3b8;
  white-space: nowrap;
  user-select: none;
}

.msg[data-role="user"] .bubble {
  background: #2563eb;
  border-color: rgba(37, 99, 235, 0.35);
}

.msg[data-role="user"] .text,
.msg[data-role="user"] .mono {
  color: white;
}

.msg[data-role="user"] .msgCopyBtn {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.95);
}

.msg[data-role="user"] .msgTime {
  color: rgba(255, 255, 255, 0.85);
}

.msg[data-role="user"] .msgCopyBtn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.98);
}

.msg[data-role="assistant"] .bubble {
  background: white;
}

.msg[data-role="system"] .bubble {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(148, 163, 184, 0.35);
}

.mono {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  color: #0f172a;
  white-space: pre;
  overflow-x: auto;
}

.cursor {
  position: absolute;
  right: 10px;
  bottom: 6px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.composer {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid #e2e8f0;
  background: white;
}

.composer-input {
  flex: 1;
  resize: none;
  overflow-y: hidden;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  padding: 10px 12px;
  font-size: 14px;
  background: #f8fafc;
  color: #0f172a;
  box-sizing: border-box;
}

.composer-input:focus {
  outline: none;
  border-color: #2563eb;
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.send {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: 10px;
  border: none;
  background: #2563eb;
  color: white;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.send:hover:not(:disabled) {
  background: #1d4ed8;
}

@media (max-width: 600px) {
  .composer {
    flex-direction: column;
  }

  .send {
    width: 100%;
  }
}
</style>
