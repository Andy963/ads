<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MainChatComposerPanel from "./MainChatComposerPanel.vue";
import MainChatMessageList from "./MainChatMessageList.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt } from "./mainChat/types";
import { useCopyMessage } from "./mainChat/useCopyMessage";
import { analyzeMarkdownOutline } from "../lib/markdown";
import { createTapActivation } from "../lib/tapActivation";
import type { TranscriptViewport } from "../app/transcriptCache";

const props = defineProps<{
  messages: ChatMessage[];
  viewport?: TranscriptViewport | null;
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  draft?: string;
  latestPromptKey?: string;
  connected: boolean;
  busy: boolean;
  inputLocked?: boolean;
  readOnly?: boolean;
  apiToken?: string;
  runningTaskCount?: number;
  workspaceRoot?: string | null;
  threadWarning?: string | null;
  connectionStatusKind?: "info" | "progress" | "disconnected" | "error" | null;
  connectionStatusMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:draft", value: string): void;
  (e: "update:viewport", value: TranscriptViewport): void;
  (e: "send", content: string): void;
  (e: "retryMessage", message: ChatMessage): void;
  (e: "interrupt"): void;
  (e: "clear"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeQueued", id: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const initialViewport = props.viewport;
const autoScroll = ref(initialViewport?.following ?? true);
const showScrollToBottom = ref(false);
let viewportFrame: number | null = null;

function saveViewport(): void {
  const host = listRef.value;
  if (!host || host.clientHeight === 0) return;
  const rows = [...host.querySelectorAll<HTMLElement>(".messageList > .msg")];
  const top = host.getBoundingClientRect().top;
  const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top);
  emit("update:viewport", {
    following: autoScroll.value,
    firstLoadedId: rows[0]?.dataset.id ?? "",
    anchorId: anchor?.dataset.id ?? "",
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    scrollTop: Math.max(0, host.scrollTop),
  });
}

function scheduleViewportSave(): void {
  if (viewportFrame !== null) return;
  viewportFrame = scheduleFrame(() => { viewportFrame = null; saveViewport(); });
}

function saveBeforeBackground(): void {
  if (document.visibilityState === "hidden") saveViewport();
}

const LIVE_STEP_MESSAGE_ID = "live-step";
const LIVE_STEP_STICKY_THRESHOLD_PX = 16;
const LIVE_ACTIVITY_MESSAGE_ID = "live-activity";
const CHAT_STICKY_THRESHOLD_PX = 80;

const liveStepPinnedToBottom = ref(true);
let liveStepScrollEl: HTMLElement | null = null;
let liveStepScrollFrame: number | null = null;

const liveStepExpanded = ref(false);
const liveStepHasOverflow = ref(false);

let chatResizeObserver: ResizeObserver | null = null;
let chatScrollQueued = false;
let bottomSettleFrame: number | null = null;
let settlingBottom = false;

function scheduleFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(cb);
  return window.setTimeout(cb, 0);
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else window.clearTimeout(id);
}

function detachLiveStepScrollEl(): void {
  if (!liveStepScrollEl) return;
  liveStepScrollEl.removeEventListener("scroll", onLiveStepScroll);
  liveStepScrollEl = null;
}

function isNearBottom(el: HTMLElement, thresholdPx: number): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= thresholdPx;
}

function onLiveStepScroll(): void {
  const el = liveStepScrollEl;
  if (!el) return;
  liveStepPinnedToBottom.value = isNearBottom(el, LIVE_STEP_STICKY_THRESHOLD_PX);
}

function cancelBottomSettlement(): void {
  settlingBottom = false;
  if (bottomSettleFrame !== null) cancelFrame(bottomSettleFrame);
  bottomSettleFrame = null;
}

function settleBottomLayout(): void {
  if (!settlingBottom || bottomSettleFrame !== null) return;
  let frames = 0;
  let stableFrames = 0;
  let previousHeight = -1;
  const settle = (): void => {
    bottomSettleFrame = null;
    const host = listRef.value;
    if (!host || !autoScroll.value || !settlingBottom) return;
    const height = host.scrollHeight;
    const distance = height - host.scrollTop - host.clientHeight;
    stableFrames = height === previousHeight && distance <= 2 ? stableFrames + 1 : 0;
    previousHeight = height;
    if (distance > 2) host.scrollTop = height;
    if (++frames >= 8 || stableFrames >= 2) {
      settlingBottom = false;
      handleScroll();
      return;
    }
    bottomSettleFrame = scheduleFrame(settle);
  };
  bottomSettleFrame = scheduleFrame(settle);
}

function scrollChatToBottom(explicit = false): void {
  cancelBottomSettlement();
  settlingBottom = explicit;
  autoScroll.value = true;
  showScrollToBottom.value = false;
  scheduleChatScrollToBottom();
}

function pauseChatAutoScroll(): void {
  cancelBottomSettlement();
  autoScroll.value = false;
  showScrollToBottom.value = true;
}

function onChatScrollIntent(event: Event): void {
  if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  if (settlingBottom) pauseChatAutoScroll();
}

async function refreshAfterVisibility(): Promise<void> {
  await nextTick();
  if (!listRef.value || !autoScroll.value) return;
  listRef.value.scrollTop = listRef.value.scrollHeight;
  showScrollToBottom.value = false;
}

defineExpose({ refreshAfterVisibility });

const bottomActivation = createTapActivation<boolean>(() => scrollChatToBottom(true), { name: "scroll-to-bottom" });

function scheduleChatScrollToBottom(): void {
  if (!autoScroll.value) return;
  if (chatScrollQueued) return;
  chatScrollQueued = true;
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit DOM updates before measuring scrollHeight.
      await nextTick();
      await nextTick();
      if (!autoScroll.value) return;
      const host = listRef.value;
      if (!host) return;
      host.scrollTop = host.scrollHeight;
      showScrollToBottom.value = false;
      settleBottomLayout();
      scheduleViewportSave();
    } finally {
      chatScrollQueued = false;
    }
  })();
}

function ensureLiveStepScrollEl(): HTMLElement | null {
  const host = listRef.value;
  if (!host) return null;

  const selector = `.msg[data-id="${LIVE_STEP_MESSAGE_ID}"] .bubble .md`;
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) {
    detachLiveStepScrollEl();
    return null;
  }

  if (el === liveStepScrollEl) return el;

  detachLiveStepScrollEl();
  liveStepScrollEl = el;
  // When the live-step element is (re)mounted, follow the newest content by default.
  liveStepPinnedToBottom.value = true;
  el.addEventListener("scroll", onLiveStepScroll, { passive: true });
  return el;
}

function scheduleLiveStepScrollToBottom(): void {
  if (liveStepExpanded.value) return;
  if (!liveStepPinnedToBottom.value) return;

  const el = ensureLiveStepScrollEl();
  if (!el) return;

  if (liveStepScrollFrame !== null) cancelFrame(liveStepScrollFrame);
  liveStepScrollFrame = scheduleFrame(() => {
    liveStepScrollFrame = null;
    if (!liveStepPinnedToBottom.value) return;
    const target = liveStepScrollEl;
    if (!target) return;
    target.scrollTop = target.scrollHeight;
  });
}

function clampLiveStepHeightPx(el: HTMLElement): number {
  const style = window.getComputedStyle(el);
  const lineHeightStr = style.lineHeight || "";
  const fontSizeStr = style.fontSize || "";

  const lineHeight = Number.parseFloat(lineHeightStr);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight * 3;

  const fontSize = Number.parseFloat(fontSizeStr);
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.6 * 3;

  return 0;
}

async function updateLiveStepOverflow(): Promise<void> {
  if (typeof window === "undefined") return;
  await nextTick();
  const el = ensureLiveStepScrollEl();
  if (!el) {
    liveStepHasOverflow.value = false;
    return;
  }

  const clampPx = clampLiveStepHeightPx(el);
  if (clampPx <= 0) {
    liveStepHasOverflow.value = el.scrollHeight > el.clientHeight + 1;
    return;
  }

  // Compare the full content height against the 3-line clamp height so this
  // stays accurate even while expanded.
  liveStepHasOverflow.value = el.scrollHeight > clampPx + 1;
}

function toggleLiveStepExpanded(): void {
  liveStepExpanded.value = !liveStepExpanded.value;
  if (!liveStepExpanded.value) scheduleLiveStepScrollToBottom();
  void updateLiveStepOverflow();
}

const liveStepMessage = computed(
  () =>
    props.messages.find((m) => m.id === LIVE_STEP_MESSAGE_ID && m.role === "assistant" && m.kind === "text") ?? null,
);

const liveStepOutlineAnalysis = computed(() => analyzeMarkdownOutline(liveStepMessage.value?.content ?? ""));
const liveStepOutlineTitles = computed(() => liveStepOutlineAnalysis.value.titles);
const liveStepHasMeaningfulBody = computed(() => liveStepOutlineAnalysis.value.hasMeaningfulBody);
const liveStepOutlineItems = computed(() => {
  const titles = liveStepOutlineTitles.value;
  if (titles.length <= 3) return titles;
  // Follow the newest incoming tail rather than locking to the top 2 titles
  return titles.slice(-2);
});
const liveStepOutlineHiddenCount = computed(() => Math.max(0, liveStepOutlineTitles.value.length - liveStepOutlineItems.value.length));
const liveStepCollapsedTrivialOutline = computed(
  () => !liveStepExpanded.value && liveStepOutlineTitles.value.length === 1 && !liveStepHasMeaningfulBody.value && liveStepOutlineHiddenCount.value === 0,
);
const liveStepCanToggleExpanded = computed(() => {
  if (liveStepExpanded.value) return true;
  if (!liveStepMessage.value) return false;
  if (liveStepCollapsedTrivialOutline.value) return false;
  return liveStepHasMeaningfulBody.value || liveStepOutlineHiddenCount.value > 0 || liveStepHasOverflow.value;
});
const { copiedMessageId, onCopyMessage, formatMessageTs } = useCopyMessage();

function handleScroll() {
  if (!listRef.value) return;
  // Layout-induced scroll events during an explicit jump are not a request
  // to stop following. Actual wheel/touch/key input cancels the bounded loop.
  if (settlingBottom) {
    scheduleViewportSave();
    return;
  }
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  const distance = scrollHeight - scrollTop - clientHeight;
  autoScroll.value = distance < CHAT_STICKY_THRESHOLD_PX;
  showScrollToBottom.value = distance >= CHAT_STICKY_THRESHOLD_PX;
  scheduleViewportSave();
}

onMounted(() => {
  const host = listRef.value;
  if (host && initialViewport && !initialViewport.following) {
    const anchor = [...host.querySelectorAll<HTMLElement>(".msg")]
      .find((row) => row.dataset.id === initialViewport.anchorId);
    // This is initial restoration only. History prepends continue to use
    // native scroll anchoring and never receive a scrollTop correction.
    host.scrollTop = anchor
      ? Math.max(0, host.scrollTop + anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - initialViewport.anchorOffset)
      : initialViewport.scrollTop;
    showScrollToBottom.value = true;
  } else {
    scrollChatToBottom();
  }
  window.addEventListener("pagehide", saveViewport);
  document.addEventListener("visibilitychange", saveBeforeBackground);
  if (host && typeof ResizeObserver !== "undefined") {
    chatResizeObserver = new ResizeObserver(() => {
      // If the chat pane is initially hidden (e.g. mobile tab), scrollHeight can be 0.
      // Once the pane becomes visible, ensure we still land at the bottom.
      scheduleChatScrollToBottom();
    });
    chatResizeObserver.observe(host);
    const content = host.querySelector(".messageList");
    if (content) chatResizeObserver.observe(content);
  }
});

watch(
  () => props.messages.length,
  () => {
    if (autoScroll.value) scheduleChatScrollToBottom();
    else showScrollToBottom.value = true;
  },
);

const lastMessage = computed(() => props.messages[props.messages.length - 1] ?? null);
const liveActivityMessage = computed(
  () => props.messages.find((m) => m.id === LIVE_ACTIVITY_MESSAGE_ID) ?? null,
);

watch(
  [
    () => lastMessage.value?.id ?? "",
    () => String(lastMessage.value?.content ?? "").length,
    () => Boolean(lastMessage.value?.streaming),
  ],
  () => {
    scheduleChatScrollToBottom();
  },
  { flush: "post" },
);

watch(
  [
    () => Boolean(liveActivityMessage.value),
    () => String(liveActivityMessage.value?.content ?? "").length,
  ],
  () => {
    scheduleChatScrollToBottom();
  },
  { flush: "post" },
);

watch(
  // Watch the entire content string instead of `content.length` because the live-step
  // stream is trimmed (max chars/lines). Once it reaches the cap, length can stay
  // constant even as new content arrives, which would otherwise stall auto-scroll.
  [() => Boolean(liveStepMessage.value?.streaming), () => liveStepMessage.value?.content ?? ""],
  ([streaming], [prevStreaming]) => {
    if (!liveStepMessage.value) {
      detachLiveStepScrollEl();
      return;
    }

    if (streaming && !prevStreaming) {
      // New streaming session: follow the newest content until the user scrolls away.
      liveStepPinnedToBottom.value = true;
      liveStepExpanded.value = false;
    }

    scheduleLiveStepScrollToBottom();
    void updateLiveStepOverflow();
  },
  { flush: "post", immediate: true },
);

onBeforeUnmount(() => {
  cancelBottomSettlement();
  window.removeEventListener("pagehide", saveViewport);
  document.removeEventListener("visibilitychange", saveBeforeBackground);
  if (viewportFrame !== null) cancelFrame(viewportFrame);
  detachLiveStepScrollEl();
  if (liveStepScrollFrame !== null) {
    cancelFrame(liveStepScrollFrame);
    liveStepScrollFrame = null;
  }
  if (chatResizeObserver) {
    try {
      chatResizeObserver.disconnect();
    } catch {
      // ignore
    }
    chatResizeObserver = null;
  }
});

</script>

<template>
  <div class="detail">
    <div
      v-if="props.threadWarning"
      class="threadWarningBanner"
      data-testid="main-chat-thread-warning"
    >
      {{ props.threadWarning }}
    </div>
    <div class="chatViewport">
      <div
        ref="listRef"
        class="chat"
        @scroll="handleScroll"
        @wheel.passive="onChatScrollIntent"
        @touchstart.passive="onChatScrollIntent"
        @keydown="onChatScrollIntent"
      >
        <MainChatMessageList
          :messages="messages"
          :initial-first-loaded-id="initialViewport?.following === false ? initialViewport.firstLoadedId : undefined"
          :initial-anchor-id="initialViewport?.following === false ? initialViewport.anchorId : undefined"
          :copied-message-id="copiedMessageId"
          :format-message-ts="formatMessageTs"
          :live-step-expanded="liveStepExpanded"
          :live-step-has-overflow="liveStepHasOverflow"
          :live-step-can-toggle-expanded="liveStepCanToggleExpanded"
          :live-step-outline-items="liveStepOutlineItems"
          :live-step-outline-hidden-count="liveStepOutlineHiddenCount"
          :live-step-collapsed-trivial-outline="liveStepCollapsedTrivialOutline"
          :workspace-root="workspaceRoot"
          @copy-message="onCopyMessage($event)"
          @retry-message="emit('retryMessage', $event)"
          @toggle-live-step-expanded="toggleLiveStepExpanded"
          @before-history-prepend="pauseChatAutoScroll"
        />
      </div>
      <button v-if="showScrollToBottom" class="scrollToBottom" type="button" aria-label="Scroll to bottom" title="Scroll to bottom"
        @pointerdown.stop="bottomActivation.onPointerDown($event, true)"
        @pointermove.stop="bottomActivation.onPointerMove"
        @pointercancel.stop="bottomActivation.onPointerCancel"
        @pointerup.stop="bottomActivation.onPointerUp"
        @click.stop="bottomActivation.onClick($event, true)">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </button>
    </div>

    <MainChatComposerPanel
      v-if="!readOnly"
      :draft="draft"
      :latest-prompt-key="latestPromptKey"
      :queued-prompts="queuedPrompts"
      :pending-images="pendingImages"
      :connected="connected"
      :busy="busy"
      :input-locked="inputLocked"
      :api-token="apiToken"
      :running-task-count="runningTaskCount"
      :connection-status-kind="connectionStatusKind"
      :connection-status-message="connectionStatusMessage"
      @update:draft="emit('update:draft', $event)"
      @send="emit('send', $event)"
      @interrupt="emit('interrupt')"
      @add-images="emit('addImages', $event)"
      @clear-images="emit('clearImages')"
      @remove-queued="emit('removeQueued', $event)"
    />
  </div>
</template>

<style src="./MainChat.css" scoped></style>
