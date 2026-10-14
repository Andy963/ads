<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MainChatComposerPanel from "./MainChatComposerPanel.vue";
import MainChatMessageList from "./MainChatMessageList.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt } from "./mainChat/types";
import { useCopyMessage } from "./mainChat/useCopyMessage";
import { loadMarkdown, loadedMarkdown } from "../lib/markdown/loader";
import { createTapActivation } from "../lib/tapActivation";
import type { TranscriptViewport } from "../app/transcriptCache";
import { findStreamingAnswerId, hasExecutionBlockAfter } from "../app/chatStreaming";

const props = withDefaults(defineProps<{
  messages: ChatMessage[];
  viewport?: TranscriptViewport | null;
  transcriptAlignSeq?: number;
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  draft?: string;
  latestPromptKey?: string;
  voiceInputActive?: boolean;
  connected: boolean;
  busy: boolean;
  inputLocked?: boolean;
  readOnly?: boolean;
  apiToken?: string;
  runningTaskCount?: number;
  workspaceRoot?: string | null;
  viewportScopeKey?: string;
  transcriptScopeKey?: string;
  transcriptAuthoritative?: boolean;
  transcriptAuthoritativeSeq?: number;
  transcriptResetSeq?: number;
  threadWarning?: string | null;
  connectionStatusKind?: "info" | "progress" | "disconnected" | "error" | null;
  connectionStatusMessage?: string | null;
}>(), { voiceInputActive: true, transcriptAlignSeq: 0, transcriptAuthoritativeSeq: 0, transcriptResetSeq: 0 });

const emit = defineEmits<{
  (e: "update:draft", value: string): void;
  (e: "update:viewportScope", value: string | undefined): void;
  (e: "update:viewport", value: TranscriptViewport): void;
  (e: "send", content: string): void;
  (e: "retryMessage", message: ChatMessage): void;
  (e: "interrupt"): void;
  (e: "clear"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeImage", index: number): void;
  (e: "removeQueued", id: string): void;
  (e: "retryQueued", id: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const initialViewport = props.viewport;
const initialTailMessage = props.messages.at(-1);
let initialTailMessageId = initialTailMessage?.id ?? "";
let initialTailContent = String(initialTailMessage?.content ?? "");
let initialTailStreaming = Boolean(initialTailMessage?.streaming);
const INITIAL_MESSAGE_WINDOW = 30;

function hasInFlightTurn(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.streaming) return true;
    if (m?.role === "user") break;
  }
  return false;
}

function transcriptSignature(messages: readonly ChatMessage[]): string {
  return JSON.stringify(messages.map((message) => [
    message.id,
    message.role,
    message.kind,
    message.content,
    Boolean(message.streaming),
  ]));
}

function isValidRestorableViewport(
  viewport: TranscriptViewport | null | undefined,
  messages: readonly ChatMessage[],
  tailMessageId: string,
  currentScopeKey?: string,
): viewport is TranscriptViewport {
  if (!viewport || viewport.following !== false) return false;
  if (!viewport.tailMessageId || viewport.tailMessageId !== tailMessageId) return false;
  if (viewport.scopeKey && currentScopeKey && viewport.scopeKey !== currentScopeKey) return false;
  if (messages.length === 0) return false;

  const inFlight = hasInFlightTurn(messages);
  const anchorIndex = viewport.anchorId ? messages.findIndex((m) => m.id === viewport.anchorId) : -1;
  const firstLoadedIndex = viewport.firstLoadedId ? messages.findIndex((m) => m.id === viewport.firstLoadedId) : -1;

  if (anchorIndex < 0 && firstLoadedIndex < 0) return false;

  const effectiveIndex = anchorIndex >= 0 ? anchorIndex : firstLoadedIndex;

  const recentWindowStart = Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW);
  if (effectiveIndex < recentWindowStart && viewport.userControlled !== true) {
    return false;
  }

  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIndex = i;
  }
  // Completed-turn restores are allowed only for an explicit user position.
  // Reading-lock positions remain transient and cold-start at the tail.
  if (!inFlight && lastUserIndex >= 0 && viewport.userControlled !== true) {
    return false;
  }
  if (inFlight && lastUserIndex >= 0 && effectiveIndex < lastUserIndex && viewport.userControlled !== true) {
    return false;
  }

  return true;
}

const restorableViewport = ref<TranscriptViewport | null>(
  isValidRestorableViewport(
    initialViewport,
    props.messages,
    initialTailMessageId,
    props.transcriptScopeKey,
  )
    ? initialViewport
    : null,
);
const autoScroll = ref(!restorableViewport.value);
let initialViewportActive = Boolean(restorableViewport.value);
let initialViewportRestored = false;
let viewportTailGuardActive = Boolean(restorableViewport.value);
let wasAnchoredBeforeDisconnect = !restorableViewport.value;
let viewportUserControlled = Boolean(restorableViewport.value?.userControlled);
let userTookViewportControl = false;
let observedTranscriptAuthoritative = Boolean(props.transcriptAuthoritative);
let observedTranscriptAuthoritativeSeq = props.transcriptAuthoritativeSeq;
let lastAuthoritativeTailId = restorableViewport.value?.tailMessageId ?? initialTailMessageId;
let lastAuthoritativeTranscriptSignature = transcriptSignature(props.messages);
const showScrollToBottom = ref(false);
let viewportFrame: number | null = null;
let initialViewportRestoreFrame: number | null = null;
let suppressInitialViewportScroll = false;

function saveViewport(): void {
  const host = listRef.value;
  if (!host || host.clientHeight === 0) return;
  const rows = [...host.querySelectorAll<HTMLElement>(".messageList > .msg")];
  const top = host.getBoundingClientRect().top;
  const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top);
  const turnStreaming = Boolean(props.messages.at(-1)?.streaming) || Boolean(streamingAnswerId.value);
  const following = autoScroll.value || (!viewportUserControlled && !turnStreaming && isViewportInFinalTurn());
  const viewport = {
    following,
    firstLoadedId: rows[0]?.dataset.id ?? "",
    anchorId: anchor?.dataset.id ?? "",
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    scrollTop: Math.max(0, host.scrollTop),
    userControlled: viewportUserControlled,
    scopeKey: props.transcriptScopeKey || undefined,
    tailMessageId: props.messages.at(-1)?.id ?? "",
  } satisfies TranscriptViewport;
  emit("update:viewportScope", props.viewportScopeKey);
  emit("update:viewport", viewport);
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
// Window during which a scroll event is attributed to visualViewport layout
// rather than to the user. Mobile keyboard and browser-toolbar animations run
// for 250-300ms and can emit their final scroll correction long after the last
// animation frame, so the two-frame window this replaces expired while the
// animation was still running and misread that late correction as "the user
// scrolled away". The value tracks the viewport-metric burst ladder in
// client/src/lib/viewport.ts (50/150/300/500/800/1200/1800ms) so both layers
// cover the same churn. Real wheel/touch/key input still cancels this
// immediately via onChatScrollIntent.
//
// This window deliberately applies to visualViewport events only. Content
// growth arms its own much shorter guard on every ResizeObserver callback, and
// widening that one to match would hold the guard open for the whole of a
// stream, because streaming deltas arrive faster than any window that still
// expires between them. Do not rename this back to a viewport-wide constant:
// that is what let it reach the content path once already.
//
// Accepted trade-off: for this long a scroll carrying no wheel, touch or key
// intent - a native scrollbar-thumb drag - cannot stop tail-following. The
// issue's acceptance criteria mandate exactly this, and every other scroll
// source the chat exposes is covered by onChatScrollIntent.
const CHAT_KEYBOARD_LAYOUT_TRANSITION_MS = 1800;

const liveStepPinnedToBottom = ref(true);
let liveStepScrollEl: HTMLElement | null = null;
let liveStepScrollFrame: number | null = null;

const liveStepExpanded = ref(false);
const liveStepHasOverflow = ref(false);

let chatResizeObserver: ResizeObserver | null = null;
let chatScrollQueued: number | null = null;
let bottomSettleFrame: number | null = null;
let settlingBottom = false;
let chatTouchStart: { x: number; y: number } | null = null;
let chatPhysicalScrollIntent = false;
let chatVisualViewport: VisualViewport | null = null;
let chatKeyboardLayoutTransition = false;
let chatKeyboardLayoutTransitionTimer: number | null = null;
let chatContentLayoutTransition = false;
let chatContentLayoutTransitionFrame: number | null = null;

// Two-phase reading viewport. Phase 1 (intermediate execution): the viewport
// follows the streaming tail so commands and live steps stay visible. Phase 2
// (final answer): the first non-empty answer block arms the reading lock. A
// short answer may not have enough scroll range to reach the top offset, but it
// still owns the viewport from that point onward; waiting for it to grow would
// keep the transcript in bottom-following mode. The target is therefore
// clamped to the currently reachable range, native scroll anchoring is
// disabled, and the answer grows downward without per-frame scrollTop
// corrections. Phase 3: only physical input (wheel with a non-zero delta, a
// touch drag past the threshold, scroll keys, or the scroll-to-bottom button)
// releases the reading lock — layout reflow from burst streaming must not hand
// control back.
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
    if (distance > 2) {
      host.scrollTop = height;
      void host.offsetHeight;
    }
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

// Attempt the one-shot alignment. The answer owns the reading state even when
// its ideal target is outside the current scroll range; scrollTop is clamped
// by the browser to the nearest reachable position.
function tryLockAnswerRow(row: HTMLElement, smooth: boolean): boolean {
  const host = listRef.value;
  if (!host) return false;
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

function markViewportUserControlled(): void {
  viewportUserControlled = true;
  userTookViewportControl = true;
  initialViewportActive = false;
  viewportTailGuardActive = false;
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
      if (!row) {
        readingLockPendingId = messageId;
        return;
      }
      tryLockAnswerRow(row, options?.smooth !== false);
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
  viewportUserControlled = false;
  if (explicit) userTookViewportControl = false;
  viewportTailGuardActive = false;
  showScrollToBottom.value = false;
  const host = listRef.value;
  if (host) {
    host.scrollTop = host.scrollHeight;
    void host.offsetHeight;
  }
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
  chatKeyboardLayoutTransition = false;
  chatContentLayoutTransition = false;
  if (chatKeyboardLayoutTransitionTimer !== null) {
    window.clearTimeout(chatKeyboardLayoutTransitionTimer);
    chatKeyboardLayoutTransitionTimer = null;
  }
  if (chatContentLayoutTransitionFrame !== null) cancelFrame(chatContentLayoutTransitionFrame);
  chatContentLayoutTransitionFrame = null;
  initialViewportActive = false;
  suppressInitialViewportScroll = false;
  if (initialViewportRestoreFrame !== null) cancelFrame(initialViewportRestoreFrame);
  initialViewportRestoreFrame = null;
  markViewportUserControlled();
  pauseChatAutoScroll();
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
  const epoch = followEpoch;
  if (chatScrollQueued === epoch) return;
  chatScrollQueued = epoch;
  void (async () => {
    try {
      // Allow Vue + MarkdownContent to commit DOM updates before measuring scrollHeight.
      await nextTick();
      await nextTick();
      if (epoch !== followEpoch) return;
      if (readingLockAligning) return;
      // While the reading lock holds, the answer grows downward on its own;
      // never re-pin the bottom or correct the scroll position per frame.
      if (readingLockEl) return;
      const host = listRef.value;
      if (!host) return;
      if (readingLockPendingId && autoScroll.value) {
        // The answer row may have been mounted after the watcher ran.
        const row = host.querySelector<HTMLElement>(`.msg[data-id="${escapeSelectorValue(readingLockPendingId)}"]`);
        if (row && tryLockAnswerRow(row, false)) {
          scheduleViewportSave();
          return;
        }
      }
      if (!autoScroll.value) return;
      host.scrollTop = host.scrollHeight;
      void host.offsetHeight;
      showScrollToBottom.value = false;
      settleBottomLayout();
      scheduleViewportSave();
    } finally {
      if (chatScrollQueued === epoch) chatScrollQueued = null;
    }
  })();
}

function onVisualViewportChange(): void {
  markChatKeyboardLayoutTransition();
  if (!autoScroll.value || readingLockEl || readingLockAligning) return;
  scheduleChatScrollToBottom();
}

function markChatKeyboardLayoutTransition(): void {
  chatKeyboardLayoutTransition = true;
  if (chatKeyboardLayoutTransitionTimer !== null) window.clearTimeout(chatKeyboardLayoutTransitionTimer);
  chatKeyboardLayoutTransitionTimer = window.setTimeout(() => {
    chatKeyboardLayoutTransitionTimer = null;
    chatKeyboardLayoutTransition = false;
  }, CHAT_KEYBOARD_LAYOUT_TRANSITION_MS);
}

function markChatViewportLayoutTransition(): void {
  chatContentLayoutTransition = true;
  if (chatContentLayoutTransitionFrame !== null) cancelFrame(chatContentLayoutTransitionFrame);
  chatContentLayoutTransitionFrame = scheduleFrame(() => {
    chatContentLayoutTransitionFrame = scheduleFrame(() => {
      chatContentLayoutTransitionFrame = null;
      chatContentLayoutTransition = false;
    });
  });
}

function handleSend(content: string): void {
  // Pin across the frames in which the optimistic bubble and the assistant
  // placeholder render, so a wrapped prompt cannot settle above the fold.
  scrollChatToBottom(true);
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

const EMPTY_OUTLINE_ANALYSIS = { titles: [] as string[], hasMeaningfulBody: false };
const liveStepOutlineAnalysis = ref<{ titles: string[]; hasMeaningfulBody: boolean }>(EMPTY_OUTLINE_ANALYSIS);

watch(
  () => liveStepMessage.value?.content ?? "",
  (content) => {
    if (!content) {
      liveStepOutlineAnalysis.value = EMPTY_OUTLINE_ANALYSIS;
      return;
    }
    const mod = loadedMarkdown();
    if (mod) {
      liveStepOutlineAnalysis.value = mod.analyzeMarkdownOutline(content);
      return;
    }
    void loadMarkdown().then((loaded) => {
      const latest = liveStepMessage.value?.content ?? "";
      liveStepOutlineAnalysis.value = latest ? loaded.analyzeMarkdownOutline(latest) : EMPTY_OUTLINE_ANALYSIS;
    });
  },
  { immediate: true },
);
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
  if (!physicalScrollIntent && (chatKeyboardLayoutTransition || chatContentLayoutTransition)) {
    scheduleViewportSave();
    return;
  }
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  const distance = scrollHeight - scrollTop - clientHeight;
  // Scrollbar-thumb drags do not emit wheel/touch/key intent. A non-bottom
  // scroll outside a layout transition is still an explicit user position.
  if (!physicalScrollIntent && !initialViewportActive && !suppressInitialViewportScroll &&
      !chatKeyboardLayoutTransition &&
      !chatContentLayoutTransition && distance >= CHAT_STICKY_THRESHOLD_PX) {
    markViewportUserControlled();
  }
  autoScroll.value = distance < CHAT_STICKY_THRESHOLD_PX;
  showScrollToBottom.value = distance >= CHAT_STICKY_THRESHOLD_PX;
  scheduleViewportSave();
}

function restoreInitialViewport(): void {
  const host = listRef.value;
  const viewport = restorableViewport.value;
  if (!host || !viewport || !initialViewportActive || initialViewportRestored) return;
  // A hidden pane cannot apply a scroll position yet. The resize observer below
  // retries once the lane becomes visible.
  if (host.scrollHeight === 0) return;
  const anchor = [...host.querySelectorAll<HTMLElement>(".msg")]
    .find((row) => row.dataset.id === viewport.anchorId);
  // This is initial restoration only. History prepends continue to use native
  // scroll anchoring and never receive a scrollTop correction.
  host.scrollTop = anchor
    ? Math.max(0, host.scrollTop + anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - viewport.anchorOffset)
    : viewport.scrollTop;
  initialViewportRestored = true;
  initialViewportActive = false;
  viewportTailGuardActive = true;
  suppressInitialViewportScroll = true;
  if (initialViewportRestoreFrame !== null) cancelFrame(initialViewportRestoreFrame);
  initialViewportRestoreFrame = scheduleFrame(() => {
    initialViewportRestoreFrame = null;
    suppressInitialViewportScroll = false;
  });
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

// This is deliberately separate from the transcript's last user message. A
// cold-start history can end in a completed assistant answer, but only a turn
// that was observed as active may use a completed answer as a lock candidate.
const activeTurnUserId = ref("");
const liveStreamingAnswerId = computed(() => findStreamingAnswerId(props.messages, isLiveCardMessageId));
const streamingAnswerId = computed(() => {
  if (activeTurnUserId.value || props.busy) {
    return findStreamingAnswerId(props.messages, isLiveCardMessageId, {
      userId: activeTurnUserId.value || undefined,
      includeCompleted: true,
    });
  }
  return liveStreamingAnswerId.value;
});

if (props.busy || hasInFlightTurn(props.messages)) {
  activeTurnUserId.value = lastUserMessageId.value;
}

function isViewportInFinalTurn(): boolean {
  const host = listRef.value;
  if (!host) return false;
  const { scrollTop, scrollHeight, clientHeight } = host;
  const distance = scrollHeight - scrollTop - clientHeight;
  if (distance < CHAT_STICKY_THRESHOLD_PX) return true;

  const turnStartId = lastUserMessageId.value || readingLockEl?.dataset.id || readingLockPendingId;
  if (!turnStartId) return true;
  const row = host.querySelector<HTMLElement>(`.msg[data-id="${escapeSelectorValue(turnStartId)}"]`);
  if (!row) return true;
  const hostRect = host.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (hostRect.height > 0) {
    return rowRect.top <= hostRect.bottom;
  }
  return distance < CHAT_STICKY_THRESHOLD_PX;
}

onMounted(() => {
  const host = listRef.value;
  chatVisualViewport = window.visualViewport ?? null;
  chatVisualViewport?.addEventListener("resize", onVisualViewportChange, { passive: true });
  chatVisualViewport?.addEventListener("scroll", onVisualViewportChange, { passive: true });
  if (host && restorableViewport.value) {
    // Restore synchronously when the cached pane is already laid out so the
    // first visible frame does not briefly jump to the default scroll position.
    restoreInitialViewport();
    if (!initialViewportRestored) void nextTick().then(restoreInitialViewport);
    if (streamingAnswerId.value && !restorableViewport.value.userControlled) {
      engageReadingLock(streamingAnswerId.value, { smooth: false });
    }
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
  const messageDelta = currentMessageCount - observedMessageCount;
  const isNewUserTurn = Boolean(id && id !== previousId);
  const hasLiveTurnSignal =
    props.busy ||
    Boolean(tail?.streaming) ||
    Boolean(liveStreamingAnswerId.value) ||
    Boolean(activeTurnUserId.value && activeTurnUserId.value === id);
  const isInitialTranscriptHydration = messageDelta > 2 && !hasLiveTurnSignal;
  const authoritativeBootstrapPending = Boolean(props.transcriptAuthoritative) &&
    (!observedTranscriptAuthoritative || props.transcriptAuthoritativeSeq !== observedTranscriptAuthoritativeSeq);
  observedMessageCount = currentMessageCount;
  if (userTookViewportControl && !autoScroll.value) return;
  if (isInitialTranscriptHydration) {
    activeTurnUserId.value = "";
    if (!userTookViewportControl && (wasAnchoredBeforeDisconnect || autoScroll.value)) {
      autoScroll.value = true;
      showScrollToBottom.value = false;
      scheduleChatScrollToBottom();
    }
    return;
  }
  if (!id) activeTurnUserId.value = "";
  if (isNewUserTurn && !authoritativeBootstrapPending &&
      (props.busy || Boolean(tail?.streaming) || Boolean(liveStreamingAnswerId.value) || Boolean(previousId))) {
    activeTurnUserId.value = id;
  }
  const currentAnswerId = activeTurnUserId.value === id && id
    ? findStreamingAnswerId(props.messages, isLiveCardMessageId, { userId: id, includeCompleted: true })
    : answerId;
  // The locked row can disappear when the transcript is reset or replaced.
  // Check the message list itself because a normal Vue/Markdown update may
  // recreate the DOM row with the same message id while the lock remains
  // authoritative.
  const anchoredMessageId = readingLockEl?.dataset.id ?? readingLockPendingId;
  if (anchoredMessageId && !props.messages.some((m) => m.id === anchoredMessageId)) {
    releaseReadingLock();
    autoScroll.value = true;
    scheduleChatScrollToBottom();
  }
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
  if (currentAnswerId && currentAnswerId !== previousAnswerId && !readingLockAligning) {
    if (readingLockEl) {
      // The streaming answer was re-created (e.g. a snapshot rewrite moved it
      // to a fresh message): move the reading position to the replacement.
      if (readingLockEl.dataset.id !== currentAnswerId) {
        releaseReadingLock();
        engageReadingLock(currentAnswerId, { smooth: false });
      }
    } else if (autoScroll.value) {
      engageReadingLock(currentAnswerId, { smooth: false });
    }
  } else if (!currentAnswerId && (previousAnswerId || readingLockEl || readingLockPendingId)) {
    if (isViewportInFinalTurn()) {
      releaseReadingLock();
      readingLockAligning = false;
      autoScroll.value = true;
      showScrollToBottom.value = false;
      scheduleChatScrollToBottom();
    } else {
      releaseReadingLock();
      readingLockAligning = false;
    }
    scheduleViewportSave();
  }
});

watch(
  [() => props.transcriptScopeKey, () => props.transcriptResetSeq],
  ([scopeKey, resetSeq], [previousScopeKey, previousResetSeq]) => {
    if (scopeKey === previousScopeKey && resetSeq === previousResetSeq) return;
    // The runtime may remain mounted while a project/session identity is being
    // rebound. A position from the old tuple is never valid in the new one.
    const candidate = props.viewport;
    const nextViewport = resetSeq === previousResetSeq && candidate?.scopeKey === scopeKey && isValidRestorableViewport(
      candidate,
      props.messages,
      props.messages.at(-1)?.id ?? "",
      scopeKey,
    ) ? candidate : null;
    followEpoch += 1;
    readingLockSeq += 1;
    releaseReadingLock();
    readingLockAligning = false;
    cancelBottomSettlement();
    if (viewportFrame !== null) cancelFrame(viewportFrame);
    viewportFrame = null;
    if (initialViewportRestoreFrame !== null) cancelFrame(initialViewportRestoreFrame);
    initialViewportRestoreFrame = null;
    suppressInitialViewportScroll = false;
    chatPhysicalScrollIntent = false;
    activeTurnUserId.value = "";
    observedMessageCount = props.messages.length;
    initialTailMessageId = props.messages.at(-1)?.id ?? "";
    initialTailContent = String(props.messages.at(-1)?.content ?? "");
    initialTailStreaming = Boolean(props.messages.at(-1)?.streaming);
    restorableViewport.value = nextViewport;
    initialViewportActive = Boolean(nextViewport);
    initialViewportRestored = false;
    viewportTailGuardActive = Boolean(nextViewport);
    viewportUserControlled = Boolean(nextViewport?.userControlled);
    userTookViewportControl = false;
    wasAnchoredBeforeDisconnect = !nextViewport;
    observedTranscriptAuthoritative = Boolean(props.transcriptAuthoritative);
    observedTranscriptAuthoritativeSeq = props.transcriptAuthoritativeSeq;
    lastAuthoritativeTailId = nextViewport?.tailMessageId ?? props.messages.at(-1)?.id ?? "";
    lastAuthoritativeTranscriptSignature = transcriptSignature(props.messages);
    if (nextViewport) {
      autoScroll.value = false;
      void nextTick().then(() => {
        if (props.transcriptScopeKey === scopeKey && props.transcriptResetSeq === resetSeq) restoreInitialViewport();
      });
    } else {
      scrollChatToBottom();
    }
  },
);

watch(
  [() => Boolean(props.transcriptAuthoritative), () => props.transcriptAuthoritativeSeq],
  ([authoritative, authoritativeSeq]) => {
    const becameAuthoritative = authoritative && !observedTranscriptAuthoritative;
    const sequenceChanged = authoritativeSeq !== observedTranscriptAuthoritativeSeq;
    observedTranscriptAuthoritative = authoritative;
    observedTranscriptAuthoritativeSeq = authoritativeSeq;
    if (!authoritative || (!becameAuthoritative && !sequenceChanged) || userTookViewportControl) return;

    const currentTailId = props.messages.at(-1)?.id ?? "";
    const currentTranscriptSignature = transcriptSignature(props.messages);
    const savedAnchorStillExists = !restorableViewport.value || props.messages.some((message) =>
      message.id === restorableViewport.value.anchorId || message.id === restorableViewport.value.firstLoadedId,
    );
    if (currentTailId !== lastAuthoritativeTailId ||
        currentTranscriptSignature !== lastAuthoritativeTranscriptSignature || !savedAnchorStillExists) {
      // The cache was superseded by a newer authoritative transcript. Do not
      // strand the user at the cached offset unless they intervened first.
      initialViewportActive = false;
      scrollChatToBottom();
      lastAuthoritativeTailId = currentTailId;
      lastAuthoritativeTranscriptSignature = currentTranscriptSignature;
      return;
    }
    lastAuthoritativeTailId = currentTailId;
    lastAuthoritativeTranscriptSignature = currentTranscriptSignature;
    if (!restorableViewport.value) {
      autoScroll.value = true;
      scheduleChatScrollToBottom();
    }
  },
);

watch(
  () => props.messages.length,
  () => {
    if (readingLockEl || readingLockAligning) return;
    if (autoScroll.value) scheduleChatScrollToBottom();
    else showScrollToBottom.value = true;
  },
);

watch(
  () => props.connected,
  (connected, wasConnected) => {
    if (!connected && wasConnected) {
      wasAnchoredBeforeDisconnect = autoScroll.value || (!streamingAnswerId.value && isViewportInFinalTurn());
    } else if (connected && !wasConnected) {
      if (!userTookViewportControl && wasAnchoredBeforeDisconnect && !streamingAnswerId.value && !readingLockEl) {
        autoScroll.value = true;
        showScrollToBottom.value = false;
        scheduleChatScrollToBottom();
      }
    }
  },
);

watch(
  () => props.transcriptAlignSeq,
  (seq) => {
    if (seq && !userTookViewportControl && !readingLockEl && !readingLockAligning && !streamingAnswerId.value) {
      scrollChatToBottom(true);
    }
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
    if ((initialViewportActive || viewportTailGuardActive) && tailAdvanced) {
      initialViewportActive = false;
      viewportTailGuardActive = false;
      // A freshly submitted turn leaves the restored viewport once new content
      // starts streaming; in-flight restored turns keep reading lock without jumping.
      if (!hasInFlightTurn(props.messages) && !readingLockEl && !readingLockAligning) scrollChatToBottom();
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
  if (chatKeyboardLayoutTransitionTimer !== null) window.clearTimeout(chatKeyboardLayoutTransitionTimer);
  chatKeyboardLayoutTransitionTimer = null;
  chatKeyboardLayoutTransition = false;
  if (chatContentLayoutTransitionFrame !== null) cancelFrame(chatContentLayoutTransitionFrame);
  chatContentLayoutTransitionFrame = null;
  chatContentLayoutTransition = false;
  if (initialViewportRestoreFrame !== null) cancelFrame(initialViewportRestoreFrame);
  initialViewportRestoreFrame = null;
  suppressInitialViewportScroll = false;
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
          :key="JSON.stringify([props.transcriptScopeKey, props.transcriptResetSeq])"
          :messages="messages"
          :auto-scroll="autoScroll"
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
      :voice-input-active="voiceInputActive"
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
      @retry-queued="emit('retryQueued', $event)"
    />
  </div>
</template>

<style src="./MainChat.css" scoped></style>
