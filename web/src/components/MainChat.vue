<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import MarkdownContent from "./MarkdownContent.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt, RenderMessage } from "./mainChat/types";
import { useMainChatComposer } from "./mainChat/useComposer";
import { useCopyMessage } from "./mainChat/useCopyMessage";

const props = defineProps<{
  messages: ChatMessage[];
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  connected: boolean;
  busy: boolean;
  apiToken?: string;
}>();

const emit = defineEmits<{
  (e: "send", content: string): void;
  (e: "interrupt"): void;
  (e: "clear"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeQueued", id: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const showScrollToBottom = ref(false);

const COMMAND_COLLAPSE_THRESHOLD = 3;
const openCommandTrees = ref<Set<string>>(new Set());

function isCommandTreeOpen(id: string, commandsCount: number): boolean {
  if (commandsCount <= COMMAND_COLLAPSE_THRESHOLD) return true;
  return openCommandTrees.value.has(id);
}

function toggleCommandTree(id: string): void {
  const next = new Set(openCommandTrees.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openCommandTrees.value = next;
}

function caretPath(open: boolean): string {
  return open ? "M6 8l4 4 4-4" : "M8 6l4 4-4 4";
}

const renderMessages = computed<RenderMessage[]>(() => {
  const out: RenderMessage[] = [];
  const stack: ChatMessage[] = [];

  const flush = () => {
    if (stack.length === 0) return;
    if (stack.length === 1) {
      out.push(stack[0]!);
      stack.length = 0;
      return;
    }
    const top = stack[stack.length - 1]!;
    out.push({
      ...top,
      id: `execstack:${top.id}`,
      role: "system",
      kind: "execute",
      stackCount: stack.length,
      stackUnderlays: Math.min(2, Math.max(0, stack.length - 1)),
    });
    stack.length = 0;
  };

  for (const m of props.messages) {
    if (m.kind === "execute") {
      stack.push(m);
      continue;
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
});

const canInterrupt = computed(() => props.busy);

const { copiedMessageId, onCopyMessage, formatMessageTs } = useCopyMessage();

const { input, inputEl, send, onInputKeydown, onPaste, recording, transcribing, voiceStatusKind, voiceStatusMessage, toggleRecording } =
  useMainChatComposer({
    pendingImages: props.pendingImages,
    isBusy: () => props.busy,
    getApiToken: () => String(props.apiToken ?? ""),
    onSend: (content) => emit("send", content),
    onAddImages: (images) => emit("addImages", images),
  });

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

function getCommands(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.match(/^\$\s*/))
    .map((line) => line.replace(/^\$\s*/, ""));
}

</script>

<template>
  <div class="detail">
    <div class="header">
      <div class="header-left">
        <div class="meta">
          <span v-if="busy" class="meta-item">busy</span>
        </div>
      </div>
    </div>

    <div ref="listRef" class="chat" @scroll="handleScroll">
      <div v-if="messages.length === 0" class="chat-empty">
        <span>直接开始对话…</span>
      </div>
      <div v-for="m in renderMessages" :key="m.id" class="msg" :data-role="m.role" :data-kind="m.kind">
        <div v-if="m.kind === 'command'" class="command-block">
          <div class="command-tree-header">
            <button
              v-if="getCommands(m.content).length > COMMAND_COLLAPSE_THRESHOLD"
              class="command-caret"
              type="button"
              aria-label="Toggle command tree"
              :aria-expanded="isCommandTreeOpen(m.id, getCommands(m.content).length)"
              @click="toggleCommandTree(m.id)"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="caretPath(isCommandTreeOpen(m.id, getCommands(m.content).length))" />
              </svg>
            </button>
            <span class="command-tag">EXECUTE</span>
            <span class="command-count">{{ getCommands(m.content).length }} 条命令</span>
          </div>
          <div v-if="isCommandTreeOpen(m.id, getCommands(m.content).length)" class="command-tree">
            <div
              v-for="(cmd, cIdx) in getCommands(m.content)"
              :key="cIdx"
              class="command-tree-item"
            >
              <span class="command-tree-branch">├─</span>
              <span class="command-cmd">{{ cmd }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="m.kind === 'execute'" class="execute-stack" :data-stack="m.stackCount ?? 0">
          <div v-if="(m.stackUnderlays ?? 0) > 0" class="execute-underlays" aria-hidden="true">
            <div v-for="n in m.stackUnderlays" :key="n" class="execute-underlay" :data-layer="n" />
          </div>
          <div class="execute-block">
            <div class="execute-header">
              <span class="command-tag">EXECUTE</span>
              <span class="execute-cmd" :title="m.command || ''">{{ m.command || "" }}</span>
              <span v-if="m.stackCount" class="execute-stack-count">{{ m.stackCount }} 条命令</span>
            </div>
            <pre v-if="m.content.trim()" class="execute-output">{{ m.content }}</pre>
            <div v-if="(m.hiddenLineCount ?? 0) > 0" class="execute-more">… {{ m.hiddenLineCount }} more lines</div>
          </div>
        </div>
        <div
          v-else
          :class="[
            'bubble',
            {
              'bubble--compact':
                m.role === 'assistant' &&
                m.kind === 'text' &&
                m.streaming &&
                m.content.length === 0,
            },
          ]"
        >
          <div v-if="m.role === 'assistant' && m.kind === 'text' && m.streaming && m.content.length === 0" class="typing" aria-label="AI is thinking">
            <span class="thinkingText">thinking</span>
          </div>
          <MarkdownContent v-else :content="m.content" />
          <div v-if="!(m.streaming && m.content.length === 0)" class="msgActions">
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
        </div>
      </div>
      <button
        v-if="showScrollToBottom"
        class="scrollToBottom"
        type="button"
        aria-label="Scroll to bottom"
        title="回到底部"
        @click="scrollToBottom"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </button>
    </div>

    <div class="composer">
      <div v-if="queuedPrompts.length" class="queue" aria-label="排队消息">
        <div v-for="q in queuedPrompts" :key="q.id" class="queue-item">
          <div class="queue-text">
            {{ q.text || `[图片 x${q.imagesCount}]` }}
            <span v-if="q.text && q.imagesCount" class="queue-sub"> · 图片 x{{ q.imagesCount }}</span>
          </div>
          <button class="queue-del" type="button" title="移除" @click="emit('removeQueued', q.id)">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="pendingImages.length" class="attachmentsBar" aria-label="已粘贴图片">
        <div class="attachmentsPill">
          <span class="attachmentsText">图片 x{{ pendingImages.length }}</span>
          <button class="attachmentsClear" type="button" title="清空图片" @click="emit('clearImages')">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="inputWrap">
        <textarea
          v-model="input"
          ref="inputEl"
          rows="3"
          class="composer-input"
          placeholder="输入…（Enter 发送，Alt+Enter 换行，粘贴图片）"
          @keydown="onInputKeydown"
          @paste="onPaste"
        />
        <div class="inputActions">
          <div v-if="recording" class="voiceIndicator recording" aria-hidden="true">
            <div class="voiceBars">
              <span class="bar" />
              <span class="bar" />
              <span class="bar" />
            </div>
          </div>
          <div v-else-if="transcribing" class="voiceIndicator transcribing" aria-hidden="true">
            <span class="voiceSpinner" />
          </div>
          <button
            class="micIcon"
            :class="{ recording, transcribing }"
            :disabled="canInterrupt || transcribing"
            type="button"
            :title="recording ? '停止录音' : '语音输入（追加到输入框）'"
            @click="toggleRecording"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 13.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4.5a3 3 0 0 0 3 3Z" />
              <path
                d="M5.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 1 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V18a.75.75 0 0 1-1.5 0v-1.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75Z"
              />
            </svg>
          </button>
          <button
            v-if="canInterrupt"
            class="stopIcon"
            type="button"
            title="中断"
            @click="emit('interrupt')"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M6 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm0 2h8v8H6V6Z" clip-rule="evenodd" />
            </svg>
          </button>
          <button
            v-else
            class="sendIcon"
            :disabled="(!input.trim() && pendingImages.length === 0) || recording || transcribing"
            type="button"
            title="发送"
            @click="send"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M10 3a.75.75 0 0 1 .53.22l4.5 4.5a.75.75 0 1 1-1.06 1.06l-3.22-3.22V16a.75.75 0 0 1-1.5 0V5.56L6.03 8.78A.75.75 0 1 1 4.97 7.72l4.5-4.5A.75.75 0 0 1 10 3Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
        <div
          v-if="(voiceStatusKind === 'ok' || voiceStatusKind === 'error') && voiceStatusMessage"
          class="voiceToast"
          :class="voiceStatusKind"
          role="status"
          aria-live="polite"
        >
          <svg v-if="voiceStatusKind === 'ok'" class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.53-9.47a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L6.47 11.1a.75.75 0 1 1 1.06-1.06l1.72 1.72 3.22-3.22a.75.75 0 0 1 1.06 0Z"
              clip-rule="evenodd"
            />
          </svg>
          <svg v-else class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5Zm-1.5 7.5a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 0 1.5H10a.75.75 0 0 1-.75-.75Z"
              clip-rule="evenodd"
            />
          </svg>
          <span class="voiceToastText">{{ voiceStatusMessage }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./MainChat.css" scoped></style>
