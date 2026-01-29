<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { TaskDetail } from "../api/types";
import MarkdownContent from "./MarkdownContent.vue";
import AttachmentThumb from "./AttachmentThumb.vue";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
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

const copiedMessageId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const canCancel = computed(() => {
  const t = props.task;
  if (!t) return false;
  return t.status === "pending" || t.status === "planning" || t.status === "running";
});

const canRetry = computed(() => {
  const t = props.task;
  if (!t) return false;
  return t.status === "failed" || t.status === "cancelled";
});

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

async function copyToClipboard(text: string): Promise<boolean> {
  const normalized = String(text ?? "");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized);
      return true;
    } catch {
      // fallback below
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = normalized;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

async function onCopyMessage(message: ChatMessage): Promise<void> {
  const ok = await copyToClipboard(message.content);
  if (!ok) return;
  clearCopiedToast();
  copiedMessageId.value = message.id;
  copiedTimer = setTimeout(() => {
    copiedMessageId.value = null;
    copiedTimer = null;
  }, 1400);
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
    <span class="empty-text">Select a task to start chatting</span>
  </div>
  <div v-else class="detail">
    <div class="header">
      <div class="header-left">
        <h2 class="title">{{ task.title }}</h2>
        <div class="meta">
          <span class="status" :data-status="task.status" :title="task.status">
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
        <button class="iconBtn" type="button" title="刷新" @click="emit('refresh', task.id)">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M15.31 4.69a.75.75 0 0 1 0 1.06l-1.1 1.1A6.5 6.5 0 1 1 10 3.5a.75.75 0 0 1 0 1.5A5 5 0 1 0 14 8.25h-1.75a.75.75 0 0 1 0-1.5H15a.75.75 0 0 1 .75.75V10a.75.75 0 0 1-1.5 0V7.56l-.85.85a.75.75 0 0 1-1.06-1.06l2.97-2.66Z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="iconBtn danger" type="button" title="终止" :disabled="!canCancel" @click="emit('cancel', task.id)">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M6 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm0 2h8v8H6V6Z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="iconBtn primary" type="button" title="重试" :disabled="!canRetry" @click="emit('retry', task.id)">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 3.5a6.5 6.5 0 0 0-6.46 5.75.75.75 0 0 0 1.49.18A5 5 0 1 1 10 15a.75.75 0 0 0 0 1.5A6.5 6.5 0 1 0 10 3.5Z" clip-rule="evenodd" />
            <path d="M4.5 6.25a.75.75 0 0 1 .75-.75H7.5a.75.75 0 0 1 0 1.5H6v1.5a.75.75 0 0 1-1.5 0V6.25Z" />
          </svg>
        </button>
        <button class="iconBtn danger" type="button" title="删除任务" :disabled="task.status === 'running' || task.status === 'planning'" @click="emit('delete', task.id)">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M7 3a1 1 0 0 0-1 1v1H4.75a.75.75 0 0 0 0 1.5h.7l.62 9.1A2 2 0 0 0 8.06 18h3.88a2 2 0 0 0 2-1.9l.62-9.1h.69a.75.75 0 0 0 0-1.5H14V4a1 1 0 0 0-1-1H7Zm1.5 2V4.5h3V5H8.5Zm-1.55 2.5.56 8.25c.03.43.39.75.82.75h3.34c.43 0 .79-.32.82-.75l.56-8.25H6.95Z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
    </div>

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
        <span v-if="task.status === 'pending'">Waiting to start...</span>
        <span v-else-if="task.status === 'planning'">Generating plan...</span>
        <span v-else-if="task.status === 'running'">Running...</span>
        <span v-else>No messages yet</span>
      </div>
      <div v-for="m in messages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div class="bubble" :class="{ hasActions: m.kind !== 'command' }">
          <pre v-if="m.kind === 'command'" class="mono">{{ m.content }}</pre>
          <MarkdownContent v-else :content="m.content" :tone="m.role === 'user' ? 'inverted' : 'default'" />
          <div v-if="m.kind !== 'command'" class="msgActions">
            <button class="msgCopyBtn" type="button" aria-label="Copy message" @click="onCopyMessage(m)">
              <svg v-if="copiedMessageId === m.id" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
          <span v-if="m.streaming" class="cursor">▍</span>
        </div>
      </div>
      <div v-if="messages.length > 0 && showPendingReply" class="chat-placeholder">
        <span v-if="task.status === 'pending'">Waiting to start...</span>
        <span v-else-if="task.status === 'planning'">Generating plan...</span>
        <span v-else>Running...</span>
      </div>
      <button
        v-if="showScrollToBottom"
        class="scrollToBottom"
        type="button"
        aria-label="Scroll to bottom"
        title="Back to bottom"
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
        rows="2"
        class="composer-input"
        :placeholder="isRunning ? 'Continue with instruction... (Enter to send, Alt+Enter for newline)' : 'Enter instruction... (Enter to send, Alt+Enter for newline)'"
        @keydown="onInputKeydown"
      />
      <button class="send" :disabled="!input.trim()" type="button" @click="send">Send</button>
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
.status[data-status="pending"] { background: #f1f5f9; color: #64748b; }
.status[data-status="planning"] { background: #fef3c7; color: #d97706; }
.status[data-status="running"] { background: #d1fae5; color: #059669; }
.status[data-status="completed"] { background: #dbeafe; color: #2563eb; }
.status[data-status="failed"] { background: #fee2e2; color: #dc2626; }
.status[data-status="cancelled"] { background: #f1f5f9; color: #64748b; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
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
.iconBtn:hover:not(:disabled) { background: #e2e8f0; }
.iconBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.iconBtn.primary { background: #2563eb; color: white; }
.iconBtn.primary:hover:not(:disabled) { background: #1d4ed8; }
.iconBtn.danger { background: #fee2e2; color: #dc2626; }
.iconBtn.danger:hover:not(:disabled) { background: #fecaca; }

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
.msg[data-role="user"] { justify-content: flex-end; }
.msg[data-role="assistant"] { justify-content: flex-start; }
.msg[data-role="system"] { justify-content: center; }
.bubble {
  max-width: min(900px, 100%);
  border-radius: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: white;
  position: relative;
}
.bubble.hasActions {
  padding-bottom: 32px;
}
.msgActions {
  position: absolute;
  left: 10px;
  bottom: 8px;
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
  width: 28px;
  height: 28px;
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
.msg[data-role="user"] .bubble {
  background: #2563eb;
  border-color: rgba(37, 99, 235, 0.35);
}
.msg[data-role="user"] .text,
.msg[data-role="user"] .mono { color: white; }
.msg[data-role="user"] .msgCopyBtn {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.95);
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
  .header { flex-direction: column; }
  .actions { width: 100%; }
  .iconBtn { flex: 1; width: auto; }
  .composer { flex-direction: column; }
  .send { width: 100%; }
}
</style>
