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
const initialTailMessage = props.messages.at(-1);
const initialTailMessageId = initialTailMessage?.id ?? "";
const initialTailContent = String(initialTailMessage?.content ?? "");
const initialTailStreaming = Boolean(initialTailMessage?.streaming);
const restorableViewport = initialViewport?.following === false &&
  initialViewport.tailMessageId === initialTailMessageId &&
  Boolean(initialViewport.tailMessageId)
  ? initialViewport
  : null;
const autoScroll = ref(!restorableViewport);
let initialViewportActive = Boolean(restorableViewport);
let initialViewportRestored = false;
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
    tailMessageId: props.messages.at(-1)?.id ?? "",
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
const TURN_ANCHOR_TOP_OFFSET_PX = 8;
const TOUCH_SCROLL_INTENT_THRESHOLD_PX = 2;

const liveStepPinnedToBottom = ref(true);
let liveStepScrollEl: HTMLElement | null = null;
let liveStepScrollFrame: number | null = null;

const liveStepExpanded = ref(false);
const liveStepHasOverflow = ref(false);

let chatResizeObserver: ResizeObserver | null = null;
let chatScrollQueued = false;
let bottomSettleFrame: number | null = null;
let settlingBottom = false;
let chatTouchStart: { x: number; y: number } | null = null;

// Top-anchored reading viewport: while a turn streams, the current assistant
// message is held near the viewport top instead of pinning the tail to the
// bottom. Any explicit follow request (scroll-to-bottom click) or user scroll
// takeover clears the anchor and resumes the previous bottom-following behavior.
let turnAnchorEl: HTMLElement | null = null;
let turnAnchorPending = false;
let turnAnchorRequested = false;
let turnAnchorSeq = 0;
let followEpoch = 0;
let observedMessageCount = props.messages.length;
let turnAnchorOverflowAnchorHost: HTMLElement | null = null;
let turnAnchorOverflowAnchorPreviousValue = "";

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

function clearTurnAnchor(): void {
  if (turnAnchorOverflowAnchorHost) {
    if (turnAnchorOverflowAnchorPreviousValue) {
      turnAnchorOverflowAnchorHost.style.setProperty("overflow-anchor", turnAnchorOverflowAnchorPreviousValue);
    } else {
      // WebKit keeps native scroll anchoring disabled after an inline `none`
      // declaration is removed, even when the computed stylesheet value is
      // `auto`. Re-declare the default explicitly when releasing the turn
      // anchor so history prepends can anchor the reading viewport again.
      turnAnchorOverflowAnchorHost.style.setProperty("overflow-anchor", "auto");
    }
    turnAnchorOverflowAnchorHost = null;
    turnAnchorOverflowAnchorPreviousValue = "";
  }
  turnAnchorEl = null;
}

function disableNativeScrollAnchoring(host: HTMLElement): void {
  if (turnAnchorOverflowAnchorHost === host) return;
  clearTurnAnchor();
  turnAnchorOverflowAnchorHost = host;
  turnAnchorOverflowAnchorPreviousValue = host.style.getPropertyValue("overflow-anchor");
  host.style.setProperty("overflow-anchor", "none");
}

function alignTurnAnchorToViewportTop(): void {
  const host = listRef.value;
  const anchor = turnAnchorEl;
  if (!host || !anchor || !anchor.isConnected) return;
  const delta =
    anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - TURN_ANCHOR_TOP_OFFSET_PX;
  if (Math.abs(delta) >= 1) host.scrollTop += delta;
  scheduleViewportSave();
}

function maintainTurnAnchor(): void {
  const host = listRef.value;
  const anchor = turnAnchorEl;
  if (!host || !anchor) return;
  if (!anchor.isConnected) {
    clearTurnAnchor();
    return;
  }
  // User input explicitly releases the anchor. All other movement is treated
  // as layout drift and corrected so burst streaming and Markdown reflow do
  // not accidentally hand control back to bottom-following.
  alignTurnAnchorToViewportTop();
}

function scrollChatToBottom(explicit = false): void {
  followEpoch += 1;
  clearTurnAnchor();
  turnAnchorPending = false;
  turnAnchorRequested = false;
  cancelBottomSettlement();
  settlingBottom = explicit;
  autoScroll.value = true;
  showScrollToBottom.value = false;
  scheduleChatScrollToBottom();
}

function pauseChatAutoScroll(): void {
  followEpoch += 1;
  clearTurnAnchor();
  turnAnchorPending = false;
  turnAnchorRequested = false;
  cancelBottomSettlement();
  autoScroll.value = false;
  showScrollToBottom.value = true;
}

function onChatScrollIntent(): void {
  initialViewportActive = false;
  followEpoch += 1;
  clearTurnAnchor();
  turnAnchorPending = false;
  turnAnchorRequested = false;
  if (settlingBottom) pauseChatAutoScroll();
}

function onChatWheel(event: WheelEvent): void {
  if (event.deltaX === 0 && event.deltaY === 0 && event.deltaZ === 0) return;
  onChatScrollIntent();
}

function onChatKeydown(event: KeyboardEvent): void {
  if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  onChatScrollIntent();
}

function readTouchPoint(event: TouchEvent): { x: number; y: number } | null {
  const touch = event.touches?.[0] ?? event.changedTouches?.[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function onChatTouchStart(event: TouchEvent): void {
  chatTouchStart = readTouchPoint(event);
}

function onChatTouchMove(event: TouchEvent): void {
  const start = chatTouchStart;
  const current = readTouchPoint(event);
  if (!start || !current) return;
  const displacement = Math.hypot(current.x - start.x, current.y - start.y);
  if (displacement <= TOUCH_SCROLL_INTENT_THRESHOLD_PX) return;
  chatTouchStart = null;
  onChatScrollIntent();
}

function clearChatTouchStart(): void {
  chatTouchStart = null;
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
  if (turnAnchorPending || turnAnchorRequested) return;
  if (!turnAnchorEl && !autoScroll.value) return;
  if (chatScrollQueued) return;
  chatScrollQueued = true;
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit DOM updates before measuring scrollHeight.
      await nextTick();
      await nextTick();
      if (turnAnchorPending || turnAnchorRequested) return;
      if (turnAnchorEl) {
        maintainTurnAnchor();
        return;
      }
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
  if (turnAnchorEl) {
    // Reading-viewport mode: keep the assistant response visible and let the user
    // finish reading before they choose to jump back to the bottom.
    autoScroll.value = false;
    showScrollToBottom.value = true;
    scheduleViewportSave();
    return;
  }
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  const distance = scrollHeight - scrollTop - clientHeight;
  autoScroll.value = distance < CHAT_STICKY_THRESHOLD_PX;
  showScrollToBottom.value = distance >= CHAT_STICKY_THRESHOLD_PX;
  scheduleViewportSave();
}

function restoreInitialViewport(): void {
  const host = listRef.value;
  if (!host || !restorableViewport || !initialViewportActive || initialViewportRestored) return;
  // A hidden pane cannot apply a scroll position yet. The resize observer below
  // retries once the lane becomes visible.
  if (host.scrollHeight === 0) return;
  const anchor = [...host.querySelectorAll<HTMLElement>(".msg")]
    .find((row) => row.dataset.id === restorableViewport.anchorId);
  // This is initial restoration only. History prepends continue to use native
  // scroll anchoring and never receive a scrollTop correction.
  host.scrollTop = anchor
    ? Math.max(0, host.scrollTop + anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - restorableViewport.anchorOffset)
    : restorableViewport.scrollTop;
  initialViewportRestored = true;
  showScrollToBottom.value = true;
}

function beginTurnAnchor(messageId: string): void {
  turnAnchorPending = true;
  const seq = ++turnAnchorSeq;
  const epoch = followEpoch;
  const hostAtRequest = listRef.value;
  if (hostAtRequest) disableNativeScrollAnchoring(hostAtRequest);
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit the new row before measuring it.
      await nextTick();
      await nextTick();
      if (epoch !== followEpoch || turnAnchorSeq !== seq) return;
      const host = listRef.value;
      if (!host) return;
      const row = host.querySelector<HTMLElement>(`.msg[data-id="${escapeSelectorValue(messageId)}"]`);
      if (!row) return;
      cancelBottomSettlement();
      settlingBottom = false;
      disableNativeScrollAnchoring(host);
      turnAnchorEl = row;
      autoScroll.value = false;
      showScrollToBottom.value = true;
      turnAnchorRequested = false;
      alignTurnAnchorToViewportTop();
    } finally {
      if (turnAnchorSeq === seq) {
        turnAnchorPending = false;
        if (!turnAnchorEl) {
          turnAnchorRequested = false;
          clearTurnAnchor();
        }
      }
    }
  })();
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function isStreamingAssistantText(message: ChatMessage | undefined): boolean {
  return Boolean(
    message &&
    message.id !== LIVE_STEP_MESSAGE_ID &&
    message.id !== LIVE_ACTIVITY_MESSAGE_ID &&
    message.role === "assistant" &&
    message.kind === "text" &&
    message.streaming === true,
  );
}

const lastUserMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    if (props.messages[index]?.role === "user") return props.messages[index].id;
  }
  return "";
});

const streamingTurnAnchorId = computed(() => {
  let lastUserIndex = -1;
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    if (props.messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = props.messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = props.messages[index];
    if (isStreamingAssistantText(message)) return message.id;
  }
  return "";
});

function requestTurnAnchor(): void {
  // A follow-up prompt replaces the previous reading anchor. Releasing and
  // immediately reacquiring the same host also makes the native anchoring
  // transition explicit for WebKit.
  if (turnAnchorEl) clearTurnAnchor();
  turnAnchorSeq += 1;
  turnAnchorPending = false;
  turnAnchorRequested = true;
  const host = listRef.value;
  if (host) disableNativeScrollAnchoring(host);
}

onMounted(() => {
  const host = listRef.value;
  if (host && restorableViewport) {
    // Restore synchronously when the cached pane is already laid out so the
    // first visible frame does not briefly jump to the default scroll position.
    restoreInitialViewport();
    if (!initialViewportRestored) void nextTick().then(restoreInitialViewport);
  } else if (streamingTurnAnchorId.value) {
    beginTurnAnchor(streamingTurnAnchorId.value);
  } else {
    scrollChatToBottom();
  }
  window.addEventListener("pagehide", saveViewport);
  document.addEventListener("visibilitychange", saveBeforeBackground);
  if (host && typeof ResizeObserver !== "undefined") {
    chatResizeObserver = new ResizeObserver(() => {
      restoreInitialViewport();
      // If the chat pane is initially hidden (e.g. mobile tab), scrollHeight can be 0.
      // Once the pane becomes visible, ensure we still land at the bottom.
      scheduleChatScrollToBottom();
    });
    chatResizeObserver.observe(host);
    const content = host.querySelector(".messageList");
    if (content) chatResizeObserver.observe(content);
  }
});

watch([lastUserMessageId, streamingTurnAnchorId, () => props.messages.length], ([id, anchorId, currentMessageCount], previous) => {
  const [previousId, previousAnchorId] = previous;
  const tail = props.messages.at(-1);
  const hasActiveStreamingTail = Boolean(anchorId) || Boolean(tail?.streaming);
  const messageDelta = currentMessageCount - observedMessageCount;
  const isInitialTranscriptHydration = !hasActiveStreamingTail && messageDelta > 2;
  observedMessageCount = currentMessageCount;
  if (isInitialTranscriptHydration) {
    turnAnchorRequested = false;
    return;
  }
  const isNewUserTurn = Boolean(id && id !== previousId);
  const isTurnStart = isNewUserTurn && (messageDelta <= 1 || hasActiveStreamingTail);
  if (isTurnStart && (autoScroll.value || turnAnchorEl)) requestTurnAnchor();
  if (turnAnchorRequested && anchorId && anchorId !== previousAnchorId) beginTurnAnchor(anchorId);
});

watch(
  () => props.messages.length,
  () => {
    if (turnAnchorEl || turnAnchorPending || turnAnchorRequested) return;
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
    () => String(lastMessage.value?.content ?? ""),
    () => Boolean(lastMessage.value?.streaming),
  ],
  ([messageId, content, streaming]) => {
    const tailAdvanced = messageId !== initialTailMessageId ||
      content !== initialTailContent ||
      streaming !== initialTailStreaming;
    if (initialViewportActive && tailAdvanced) {
      initialViewportActive = false;
      // A freshly submitted turn anchors to the viewport top instead of
      // jumping to the bottom; other tail advances keep the old behavior.
      if (!turnAnchorEl && !turnAnchorPending && !turnAnchorRequested) scrollChatToBottom();
      return;
    }
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
  saveViewport();
  followEpoch += 1;
  turnAnchorSeq += 1;
  turnAnchorPending = false;
  turnAnchorRequested = false;
  clearTurnAnchor();
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
        @wheel.passive="onChatWheel"
        @touchstart.passive="onChatTouchStart"
        @touchmove.passive="onChatTouchMove"
        @touchend.passive="clearChatTouchStart"
        @touchcancel.passive="clearChatTouchStart"
        @keydown="onChatKeydown"
      >
        <MainChatMessageList
          :messages="messages"
          :initial-first-loaded-id="restorableViewport?.firstLoadedId"
          :initial-anchor-id="restorableViewport?.anchorId"
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
