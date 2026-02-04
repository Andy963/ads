<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { TaskDetail } from "../api/types";
import MarkdownContent from "./MarkdownContent.vue";
import AttachmentThumb from "./AttachmentThumb.vue";
import { autosizeTextarea } from "../lib/textarea_autosize";
import { isPatchMessageMarkdown } from "../lib/patch_message";

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
        <span v-else-if="task.status === 'planning'">Preparing...</span>
        <span v-else-if="task.status === 'running'">Running...</span>
        <span v-else>No messages yet</span>
      </div>
      <div v-for="m in messages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div class="bubble" :class="{ hasActions: shouldShowMsgActions(m) }">
          <pre v-if="m.kind === 'command'" class="mono">{{ m.content }}</pre>
          <MarkdownContent v-else :content="m.content" :tone="m.role === 'user' ? 'inverted' : 'default'" />
          <div v-if="shouldShowMsgActions(m)" class="msgActions">
            <button class="msgCopyBtn" type="button" aria-label="Copy message" @click="onCopyMessage(m)">
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
        <span v-if="task.status === 'pending'">Waiting to start...</span>
        <span v-else-if="task.status === 'planning'">Preparing...</span>
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
        ref="inputEl"
        rows="3"
        class="composer-input"
        :placeholder="isRunning ? 'Continue with instruction... (Enter to send, Alt+Enter for newline)' : 'Enter instruction... (Enter to send, Alt+Enter for newline)'"
        @keydown="onInputKeydown"
      />
      <button class="send" :disabled="!input.trim()" type="button" @click="send">Send</button>
    </div>
  </div>
</template>

<style src="./TaskDetail.css" scoped></style>
