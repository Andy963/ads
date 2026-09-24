<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MainChatComposerPanel from "./MainChatComposerPanel.vue";
import MainChatMessageList from "./MainChatMessageList.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt } from "./mainChat/types";
import { useCopyMessage } from "./mainChat/useCopyMessage";
import { analyzeMarkdownOutline } from "../lib/markdown";
import { createTapActivation } from "../lib/tapActivation";
import type { TranscriptViewport } from "../app/transcriptCache";
import { findStreamingAnswerId, hasExecutionBlockAfter } from "../app/chatStreaming";

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
  (e: "removeImage", index: number): void;
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
const READING_LOCK_TOP_OFFSET_PX = 12;
const TOUCH_SCROLL_INTENT_THRESHOLD_PX = 10;

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
let chatPhysicalScrollIntent = false;
let chatVisualViewport: VisualViewport | null = null;
let chatViewportLayoutTransition = false;
let chatViewportLayoutTransitionFrame: number | null = null;

// Two-phase reading viewport. Phase 1 (intermediate execution): the viewport
// follows the streaming tail so commands and live steps stay visible. Phase 2
// (final answer): the first content delta of the answer block arms the reading
// lock. While the answer is still shorter than the viewport there is no scroll
// range to align it into, so tail-following continues; once the answer can
// reach the viewport top, one smooth alignment pins it there
// (READING_LOCK_TOP_OFFSET_PX), native scroll anchoring is disabled, and
// bottom-following pauses; the answer then grows downward without per-frame
// scrollTop corrections. Phase 3: only physical input (wheel with a non-zero
// delta, a touch drag past the threshold, scroll keys, or the scroll-to-bottom
// button) releases the reading lock — layout reflow from burst streaming must
// not hand control back.
let readingLockEl: HTMLElement | null = null;
let readingLockAligning = false;
let readingLockSeq = 0;
let readingLockPendingId = "";
let followEpoch = 0;
let observedMessageCount = props.messages.length;
let readingLockOverflowAnchorHost: HTMLElement | null = null;
let readingLockOverflowAnchorPreviousValue = "";

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

function releaseReadingLock(): void {
  readingLockPendingId = "";
  if (readingLockOverflowAnchorHost) {
    if (readingLockOverflowAnchorPreviousValue) {
      readingLockOverflowAnchorHost.style.setProperty("overflow-anchor", readingLockOverflowAnchorPreviousValue);
    } else {
      // WebKit keeps native scroll anchoring disabled after an inline `none`
      // declaration is removed, even when the computed stylesheet value is
      // `auto`. Re-declare the default explicitly when releasing the reading
      // lock so history prepends can anchor the reading viewport again.
      readingLockOverflowAnchorHost.style.setProperty("overflow-anchor", "auto");
    }
    readingLockOverflowAnchorHost = null;
    readingLockOverflowAnchorPreviousValue = "";
  }
  readingLockEl = null;
}

function disableNativeScrollAnchoring(host: HTMLElement): void {
  if (readingLockOverflowAnchorHost === host) return;
  if (readingLockOverflowAnchorHost) releaseReadingLock();
  readingLockOverflowAnchorHost = host;
  readingLockOverflowAnchorPreviousValue = host.style.getPropertyValue("overflow-anchor");
  host.style.setProperty("overflow-anchor", "none");
}

function scrollHostTowards(host: HTMLElement, top: number, smooth: boolean): void {
  const target = Math.max(0, top);
  if (Math.abs(host.scrollTop - target) < 1) return;
  // jsdom does not implement Element.scrollTo; tests exercise the instant path.
  if (smooth && typeof host.scrollTo === "function") {
    host.scrollTo({ top: target, behavior: "smooth" });
    return;
  }
  host.scrollTop = target;
}

// The one and only alignment of the reading lock: scroll so the answer row's
// top sits READING_LOCK_TOP_OFFSET_PX below the viewport top. After this runs
// the content grows downward on its own; no per-frame correction follows.
function alignAnswerToViewportTop(row: HTMLElement, smooth: boolean): void {
  const host = listRef.value;
  if (!host || !row.isConnected) return;
  const delta =
    row.getBoundingClientRect().top - host.getBoundingClientRect().top - READING_LOCK_TOP_OFFSET_PX;
  if (Math.abs(delta) < 1) return;
  scrollHostTowards(host, host.scrollTop + delta, smooth);
  scheduleViewportSave();
}

// Attempt the one-shot alignment. Returns false while the answer is shorter
// than the viewport: there is not enough scroll range below it to bring its
// top to the viewport top, so tail-following continues and the caller retries
// as the answer grows.
function tryLockAnswerRow(row: HTMLElement, smooth: boolean): boolean {
  const host = listRef.value;
  if (!host) return false;
  const rowTop = row.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
  const target = Math.max(0, rowTop - READING_LOCK_TOP_OFFSET_PX);
  if (target > Math.max(0, host.scrollHeight - host.clientHeight)) return false;
  cancelBottomSettlement();
  settlingBottom = false;
  disableNativeScrollAnchoring(host);
  readingLockEl = row;
  readingLockPendingId = "";
  autoScroll.value = false;
  showScrollToBottom.value = true;
  alignAnswerToViewportTop(row, smooth);
  return true;
}

function engageReadingLock(messageId: string, options?: { smooth?: boolean }): void {
  readingLockAligning = true;
  const seq = ++readingLockSeq;
  const epoch = followEpoch;
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit the new row before measuring it.
      await nextTick();
      await nextTick();
      if (epoch !== followEpoch || readingLockSeq !== seq) return;
      const host = listRef.value;
      if (!host) return;
      const row = host.querySelector<HTMLElement>(`.msg[data-id="${escapeSelectorValue(messageId)}"]`);
      if (!row) return;
      if (!tryLockAnswerRow(row, options?.smooth !== false)) {
        readingLockPendingId = messageId;
        if (autoScroll.value) host.scrollTop = host.scrollHeight;
      }
    } finally {
      if (readingLockSeq === seq) readingLockAligning = false;
    }
  })();
}

function scrollChatToBottom(explicit = false): void {
  followEpoch += 1;
  readingLockSeq += 1;
  releaseReadingLock();
  readingLockAligning = false;
  cancelBottomSettlement();
  settlingBottom = explicit;
  autoScroll.value = true;
  showScrollToBottom.value = false;
  scheduleChatScrollToBottom();
}

function pauseChatAutoScroll(): void {
  followEpoch += 1;
  readingLockSeq += 1;
  releaseReadingLock();
  readingLockAligning = false;
  cancelBottomSettlement();
  autoScroll.value = false;
  showScrollToBottom.value = true;
}

function onChatScrollIntent(): void {
  chatPhysicalScrollIntent = true;
  chatViewportLayoutTransition = false;
  if (chatViewportLayoutTransitionFrame !== null) {
    cancelFrame(chatViewportLayoutTransitionFrame);
    chatViewportLayoutTransitionFrame = null;
  }
  initialViewportActive = false;
  followEpoch += 1;
  readingLockSeq += 1;
  releaseReadingLock();
  readingLockAligning = false;
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
  if (readingLockAligning) return;
  if (!readingLockEl && !autoScroll.value) return;
  if (chatScrollQueued) return;
  chatScrollQueued = true;
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit DOM updates before measuring scrollHeight.
      await nextTick();
      await nextTick();
      if (readingLockAligning) return;
      // While the reading lock holds, the answer grows downward on its own;
      // never re-pin the bottom or correct the scroll position per frame.
      if (readingLockEl) return;
      const host = listRef.value;
      if (!host) return;
      if (readingLockPendingId && autoScroll.value) {
        // The answer has grown: retry the deferred one-shot alignment.
        const row = host.querySelector<HTMLElement>(`.msg[data-id="${escapeSelectorValue(readingLockPendingId)}"]`);
        if (row && tryLockAnswerRow(row, true)) {
          scheduleViewportSave();
          return;
        }
      }
      if (!autoScroll.value) return;
      host.scrollTop = host.scrollHeight;
      showScrollToBottom.value = false;
      settleBottomLayout();
      scheduleViewportSave();
    } finally {
      chatScrollQueued = false;
    }
  })();
}

function onVisualViewportChange(): void {
  markChatViewportLayoutTransition();
  if (!autoScroll.value || readingLockEl || readingLockAligning) return;
  scheduleChatScrollToBottom();
}

function markChatViewportLayoutTransition(): void {
  chatViewportLayoutTransition = true;
  if (chatViewportLayoutTransitionFrame !== null) cancelFrame(chatViewportLayoutTransitionFrame);
  chatViewportLayoutTransitionFrame = scheduleFrame(() => {
    chatViewportLayoutTransitionFrame = scheduleFrame(() => {
      chatViewportLayoutTransitionFrame = null;
      chatViewportLayoutTransition = false;
    });
  });
}

function handleSend(content: string): void {
  scrollChatToBottom();
  emit("send", content);
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
  const physicalScrollIntent = chatPhysicalScrollIntent;
  chatPhysicalScrollIntent = false;
  // Layout-induced scroll events during an explicit jump are not a request
  // to stop following. Actual wheel/touch/key input cancels the bounded loop.
  if (settlingBottom) {
    scheduleViewportSave();
    return;
  }
  if (readingLockEl) {
    // Reading-lock mode: the one-shot alignment owns the scroll position.
    // Scroll events here come from that alignment or from native layout, not
    // from physical input (wheel/touch/key release the lock earlier), so keep
    // the lock and leave the viewport untouched.
    autoScroll.value = false;
    showScrollToBottom.value = true;
    scheduleViewportSave();
    return;
  }
  if (!physicalScrollIntent && chatViewportLayoutTransition) {
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

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function isLiveCardMessageId(id: string): boolean {
  return id === LIVE_STEP_MESSAGE_ID || id === LIVE_ACTIVITY_MESSAGE_ID;
}

const lastUserMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    if (props.messages[index]?.role === "user") return props.messages[index].id;
  }
  return "";
});

// The turn's final answer block, detected from the message stream. Phase 2 of
// the reading viewport starts when this appears (the answer's first content
// delta has landed), not when the empty send-time placeholder is pushed.
const streamingAnswerId = computed(() => findStreamingAnswerId(props.messages, isLiveCardMessageId));

onMounted(() => {
  const host = listRef.value;
  chatVisualViewport = window.visualViewport ?? null;
  chatVisualViewport?.addEventListener("resize", onVisualViewportChange, { passive: true });
  chatVisualViewport?.addEventListener("scroll", onVisualViewportChange, { passive: true });
  if (host && restorableViewport) {
    // Restore synchronously when the cached pane is already laid out so the
    // first visible frame does not briefly jump to the default scroll position.
    restoreInitialViewport();
    if (!initialViewportRestored) void nextTick().then(restoreInitialViewport);
  } else if (streamingAnswerId.value) {
    // Remounting into an in-flight answer locks instantly, without animation.
    engageReadingLock(streamingAnswerId.value, { smooth: false });
  } else {
    scrollChatToBottom();
  }
  window.addEventListener("pagehide", saveViewport);
  document.addEventListener("visibilitychange", saveBeforeBackground);
  if (host && typeof ResizeObserver !== "undefined") {
    chatResizeObserver = new ResizeObserver(() => {
      markChatViewportLayoutTransition();
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

watch([lastUserMessageId, streamingAnswerId, () => props.messages.length], ([id, answerId, currentMessageCount], previous) => {
  const [previousId, previousAnswerId] = previous;
  const tail = props.messages.at(-1);
  const hasActiveStreamingTail = Boolean(answerId) || Boolean(tail?.streaming);
  const messageDelta = currentMessageCount - observedMessageCount;
  const isInitialTranscriptHydration = !hasActiveStreamingTail && messageDelta > 2;
  observedMessageCount = currentMessageCount;
  if (isInitialTranscriptHydration) {
    return;
  }
  // The locked row can disappear when the transcript is reset or replaced.
  // Check the message list itself (not just DOM connectivity) because this
  // watcher runs pre-flush, before the removed row leaves the document.
  const anchoredMessageId = readingLockEl?.dataset.id ?? readingLockPendingId;
  if (anchoredMessageId && ((readingLockEl && !readingLockEl.isConnected) || !props.messages.some((m) => m.id === anchoredMessageId))) {
    releaseReadingLock();
    autoScroll.value = true;
    scheduleChatScrollToBottom();
  }
  const isNewUserTurn = Boolean(id && id !== previousId);
  if (isNewUserTurn && (readingLockEl || readingLockAligning || readingLockPendingId)) {
    // A follow-up prompt supersedes the current reading position: follow the
    // new turn's intermediate execution until its answer starts.
    releaseReadingLock();
    readingLockAligning = false;
    readingLockSeq += 1;
    autoScroll.value = true;
    showScrollToBottom.value = false;
    scheduleChatScrollToBottom();
  }
  // A fresh execution block below the locked answer means the locked text was
  // intermediate narration rather than the final answer: hand the viewport
  // back to tail-following so the resumed execution stays visible.
  const observedAnswerId = readingLockEl?.dataset.id ?? readingLockPendingId;
  if (observedAnswerId && hasExecutionBlockAfter(props.messages, observedAnswerId)) {
    releaseReadingLock();
    autoScroll.value = true;
    showScrollToBottom.value = false;
    scheduleChatScrollToBottom();
  }
  if (answerId && answerId !== previousAnswerId && !readingLockAligning) {
    if (readingLockEl) {
      // The streaming answer was re-created (e.g. a snapshot rewrite moved it
      // to a fresh message): move the reading position to the replacement.
      if (readingLockEl.dataset.id !== answerId) {
        releaseReadingLock();
        engageReadingLock(answerId, { smooth: true });
      }
    } else if (autoScroll.value) {
      engageReadingLock(answerId, { smooth: true });
    }
  }
});

watch(
  () => props.messages.length,
  () => {
    if (readingLockEl || readingLockAligning) return;
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
      // A freshly submitted turn leaves the restored viewport once new content
      // starts streaming; other tail advances keep the old behavior.
      if (!readingLockEl && !readingLockAligning) scrollChatToBottom();
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
  chatVisualViewport?.removeEventListener("resize", onVisualViewportChange);
  chatVisualViewport?.removeEventListener("scroll", onVisualViewportChange);
  chatVisualViewport = null;
  if (chatViewportLayoutTransitionFrame !== null) cancelFrame(chatViewportLayoutTransitionFrame);
  chatViewportLayoutTransitionFrame = null;
  chatViewportLayoutTransition = false;
  followEpoch += 1;
  readingLockSeq += 1;
  readingLockAligning = false;
  releaseReadingLock();
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
      @send="handleSend"
      @interrupt="emit('interrupt')"
      @add-images="emit('addImages', $event)"
      @clear-images="emit('clearImages')"
      @remove-image="emit('removeImage', $event)"
      @remove-queued="emit('removeQueued', $event)"
    />
  </div>
</template>

<style src="./MainChat.css" scoped></style>
