<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

import MainChatPendingImageViewer from "./MainChatPendingImageViewer.vue";
import { resolveComposerImagePreview } from "./mainChat/attachmentPreview";
import type { IncomingImage, QueuedPrompt } from "./mainChat/types";
import { useMainChatComposer } from "./mainChat/useComposer";
import { useComposerActionMenu } from "./mainChat/useComposerActionMenu";
import { createTapActivation } from "../lib/tapActivation";
import {
  readLatestPromptPreference,
  writeLatestPromptPreference,
} from "../lib/preferencesStore";

type PendingImagePreview = {
  key: string;
  src: string;
  href: string;
};

type TextSelectionRange = {
  start: number;
  end: number;
};

const props = defineProps<{
  draft?: string;
  latestPromptKey?: string;
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  connected: boolean;
  busy: boolean;
  inputLocked?: boolean;
  apiToken?: string;
  runningTaskCount?: number;
  connectionStatusKind?: "info" | "progress" | "disconnected" | "error" | null;
  connectionStatusMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:draft", value: string): void;
  (e: "send", content: string): void;
  (e: "interrupt"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeImage", index: number): void;
  (e: "removeQueued", id: string): void;
  (e: "retryQueued", id: string): void;
}>();

const canInterrupt = computed(() => props.busy);

const normalizedConnectionStatusKind = computed(() => props.connectionStatusKind ?? "info");
const latestPrompt = ref("");
const latestPromptScopeKey = computed(() => String(props.latestPromptKey ?? "").trim());

function resolveLatestPromptScope(): { projectId: string; lane: string } {
  const scope = latestPromptScopeKey.value;
  const separator = scope.indexOf(":");
  if (!scope || separator <= 0) return { projectId: "", lane: "" };
  return {
    projectId: scope.slice(0, separator).trim(),
    lane: scope.slice(separator + 1).trim(),
  };
}

function loadLatestPrompt(): void {
  const { projectId, lane } = resolveLatestPromptScope();
  if (!projectId || !lane) {
    latestPrompt.value = "";
    return;
  }
  try {
    latestPrompt.value = readLatestPromptPreference(projectId, lane) ?? "";
  } catch {
    latestPrompt.value = "";
  }
}

function persistLatestPrompt(content: string): void {
  const prompt = String(content ?? "").trim();
  if (!prompt) return;
  latestPrompt.value = prompt;
  const { projectId, lane } = resolveLatestPromptScope();
  if (!projectId || !lane) return;
  try {
    writeLatestPromptPreference(projectId, lane, prompt);
  } catch {
    // Keep the in-memory fallback when browser storage is unavailable.
  }
}

watch(latestPromptScopeKey, loadLatestPrompt, { immediate: true });

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const pendingImageViewerOpen = ref(false);
const pendingImageViewerIndex = ref(0);

const pendingImagePreviews = computed<PendingImagePreview[]>(() => {
  const token = String(props.apiToken ?? "").trim();
  return props.pendingImages.map((image, idx) => {
    const resolved = resolveComposerImagePreview(String(image?.data ?? ""), { apiToken: token });
    const fallback = `pending-image-${idx + 1}`;
    const keySeed = resolved?.src ? resolved.src.slice(0, 96) : fallback;
    return {
      key: `${idx}-${keySeed}`,
      src: resolved?.src ?? "",
      href: resolved?.href ?? "",
    };
  });
});

function openPendingImageViewer(index = 0): void {
  const total = props.pendingImages.length;
  if (!total) return;
  pendingImageViewerIndex.value = clamp(index, 0, total - 1);
  pendingImageViewerOpen.value = true;
}

function closePendingImageViewer(): void {
  pendingImageViewerOpen.value = false;
}

function removeAttachment(index: number): void {
  emit("removeImage", index);
  if (props.pendingImages.length <= 1) {
    emit("clearImages");
  }
}

watch(
  () => props.pendingImages.length,
  (len) => {
    if (len <= 0) {
      pendingImageViewerOpen.value = false;
      pendingImageViewerIndex.value = 0;
      return;
    }
    pendingImageViewerIndex.value = clamp(pendingImageViewerIndex.value, 0, len - 1);
  },
  { flush: "post" },
);

const {
  input,
  inputEl,
  hasContent,
  composerRowEl,
  leftActionsEl,
  rightActionsEl,
  composerExpanded,
  fileInputEl,
  send,
  onInput,
  onCompositionStart,
  onCompositionEnd,
  onInputKeydown,
  onPaste,
  recording,
  transcribing,
  voiceStatusKind,
  voiceStatusMessage,
  voiceWaveformLevels,
  voiceWaveformReactive,
  toggleRecording,
  cancelRecording,
  stopAndSend,
  triggerFileInput,
  onFileInputChange,
} = useMainChatComposer({
  getDraft: () => String(props.draft ?? ""),
  getDraftScope: () => String(props.latestPromptKey ?? ""),
  onDraftChange: (draft) => emit("update:draft", draft),
  pendingImages: props.pendingImages,
  isBusy: () => props.busy,
  isInputLocked: () => Boolean(props.inputLocked),
  getApiToken: () => String(props.apiToken ?? ""),
  onSend: (content) => {
    try {
      persistLatestPrompt(content);
    } catch {
      // Browser storage must not prevent the prompt from being dispatched.
    }
    emit("send", content);
  },
  onAddImages: (images) => emit("addImages", images),
});

const sendActivation = createTapActivation(send, { preserveFocus: true });

function onSendPointerDown(ev: PointerEvent): void {
  if (!recording.value) {
    sendActivation.onPointerDown(ev, undefined);
  }
}
function onSendPointerMove(ev: PointerEvent): void {
  if (!recording.value) {
    sendActivation.onPointerMove(ev);
  }
}
function onSendPointerCancel(ev: PointerEvent): void {
  if (!recording.value) {
    sendActivation.onPointerCancel(ev);
  }
}
function onSendPointerUp(ev: PointerEvent): void {
  if (!recording.value) {
    sendActivation.onPointerUp(ev);
  }
}
function onSendClick(ev: MouseEvent): void {
  if (recording.value) {
    stopAndSend();
  } else {
    sendActivation.onClick(ev, undefined);
  }
}

const composerRoot = ref<HTMLElement | null>(null);
const actionMenuId = useId();
const hasTextSelection = ref(false);
const actionMenuSelection = ref<TextSelectionRange | null>(null);
const {
  trigger: actionMenuTrigger,
  menu: actionMenuElement,
  open: actionMenuOpen,
  style: actionMenuStyle,
  toggle: toggleActionMenu,
  close: closeActionMenu,
} = useComposerActionMenu(composerRoot, () => Boolean(props.inputLocked));

const ACTION_MENU_POINTER_SLOP_PX = 10;
const ACTION_MENU_CLICK_SUPPRESS_MS = 700;
let actionMenuPointerCandidate: { pointerId: number; x: number; y: number } | null = null;
let actionMenuPointerActivationAt = 0;
let actionMenuClickSuppressTimer: ReturnType<typeof setTimeout> | null = null;

function clearActionMenuPointerCandidate(): void {
  actionMenuPointerCandidate = null;
}

function clearActionMenuClickSuppression(): void {
  actionMenuPointerActivationAt = 0;
  if (actionMenuClickSuppressTimer !== null) {
    clearTimeout(actionMenuClickSuppressTimer);
    actionMenuClickSuppressTimer = null;
  }
}

function rememberActionMenuSelection(): void {
  const el = inputEl.value;
  if (!el || props.inputLocked) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (end <= start) return;
  actionMenuSelection.value = { start, end };
  hasTextSelection.value = true;
}

function releaseActionMenuSelection(): void {
  actionMenuSelection.value = null;
}

function toggleActionMenuFromInput(): void {
  if (actionMenuOpen.value) releaseActionMenuSelection();
  toggleActionMenu();
}

function markActionMenuPointerActivation(): void {
  actionMenuPointerActivationAt = Date.now();
  if (actionMenuClickSuppressTimer !== null) clearTimeout(actionMenuClickSuppressTimer);
  actionMenuClickSuppressTimer = setTimeout(() => {
    actionMenuPointerActivationAt = 0;
    actionMenuClickSuppressTimer = null;
  }, ACTION_MENU_CLICK_SUPPRESS_MS);
}

function onActionMenuPointerDown(event: PointerEvent): void {
  if (props.inputLocked || event.button > 0) {
    clearActionMenuPointerCandidate();
    return;
  }
  rememberActionMenuSelection();
  actionMenuPointerCandidate = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  const target = event.currentTarget;
  if (target instanceof HTMLElement && target.setPointerCapture) {
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      clearActionMenuPointerCandidate();
    }
  }
}

function onActionMenuPointerUp(event: PointerEvent): void {
  const candidate = actionMenuPointerCandidate;
  clearActionMenuPointerCandidate();
  if (!candidate || candidate.pointerId !== event.pointerId || props.inputLocked) return;
  if (
    Math.abs(event.clientX - candidate.x) > ACTION_MENU_POINTER_SLOP_PX ||
    Math.abs(event.clientY - candidate.y) > ACTION_MENU_POINTER_SLOP_PX
  ) {
    return;
  }
  markActionMenuPointerActivation();
  toggleActionMenuFromInput();
}

function onActionMenuPointerCancel(): void {
  clearActionMenuPointerCandidate();
}

function onActionMenuClick(event: MouseEvent): void {
  if (
    actionMenuPointerActivationAt > 0 &&
    event.detail > 0 &&
    Date.now() - actionMenuPointerActivationAt < ACTION_MENU_CLICK_SUPPRESS_MS
  ) {
    clearActionMenuClickSuppression();
    return;
  }
  clearActionMenuClickSuppression();
  toggleActionMenuFromInput();
}

function attachFromActionMenu(): void {
  releaseActionMenuSelection();
  closeActionMenu();
  triggerFileInput();
}

async function restoreFromActionMenu(): Promise<void> {
  releaseActionMenuSelection();
  closeActionMenu();
  await restoreLatestPrompt();
}

async function quoteFromActionMenu(): Promise<void> {
  const selection = actionMenuSelection.value;
  releaseActionMenuSelection();
  closeActionMenu();
  await wrapSelectedTextWithTripleQuotes(selection);
}

const canRestoreLatestPrompt = computed(
  () => !props.inputLocked && !input.value.trim() && Boolean(latestPrompt.value.trim()),
);

watch(
  () => Boolean(props.inputLocked),
  (locked) => {
    if (!locked) return;
    closeActionMenu();
    hasTextSelection.value = false;
  },
);

function updateTextSelection(): void {
  const el = inputEl.value;
  if (!el || props.inputLocked) {
    hasTextSelection.value = false;
    actionMenuSelection.value = null;
    return;
  }
  const start = el.selectionStart;
  const end = el.selectionEnd;
  hasTextSelection.value = end > start;
  actionMenuSelection.value = end > start ? { start, end } : null;
}

function clearTextSelectionState(): void {
  if (actionMenuSelection.value) {
    hasTextSelection.value = true;
    return;
  }
  hasTextSelection.value = false;
}

async function restoreLatestPrompt(): Promise<void> {
  if (!canRestoreLatestPrompt.value) return;
  const prompt = latestPrompt.value;
  input.value = prompt;
  await nextTick();
  const el = inputEl.value;
  if (!el) return;
  el.focus();
  el.setSelectionRange(prompt.length, prompt.length);
  updateTextSelection();
}

async function wrapSelectedTextWithTripleQuotes(selectionOverride: TextSelectionRange | null = null): Promise<void> {
  const el = inputEl.value;
  if (!el || props.inputLocked) return;
  const current = input.value;
  const currentSelection = { start: el.selectionStart, end: el.selectionEnd };
  const selection = selectionOverride ?? currentSelection;
  const start = Math.max(0, Math.min(selection.start, current.length));
  const end = Math.max(start, Math.min(selection.end, current.length));
  if (end <= start) return;
  const selected = current.slice(start, end);
  input.value = `${current.slice(0, start)}\"\"\"${selected}\"\"\"${current.slice(end)}`;
  await nextTick();
  el.focus();
  el.setSelectionRange(start + 3, end + 3);
  updateTextSelection();
}

onBeforeUnmount(() => {
  clearActionMenuPointerCandidate();
  clearActionMenuClickSuppression();
});
</script>

<template>
  <div ref="composerRoot" class="composer">
    <div
      v-if="connectionStatusMessage"
      class="laneStatusBar"
      :class="`laneStatusBar--${normalizedConnectionStatusKind}`"
      role="status"
      aria-live="polite"
      data-testid="lane-connection-status"
    >
      <span class="laneStatusDot" aria-hidden="true" />
      <span class="laneStatusText">{{ connectionStatusMessage }}</span>
    </div>

    <div v-if="queuedPrompts.length" class="queue" aria-label="排队消息">
      <div v-for="(q, idx) in queuedPrompts" :key="q.id" class="queue-item">
        <span class="queue-badge" :title="`第 ${idx + 1} 条排队消息`">#{{ idx + 1 }}</span>
        <div class="queue-text">
          <span>{{ q.text || `[图片 x${q.imagesCount}]` }}</span>
          <span v-if="q.text && q.imagesCount" class="queue-sub"> · 图片 x{{ q.imagesCount }}</span>
        </div>
        <span
          class="queue-status"
          :data-status="q.deliveryStatus ?? 'offline'"
          :title="q.queueError || undefined"
        >
          <template v-if="q.deliveryStatus === 'offline'">Waiting for connection</template>
          <template v-else-if="q.deliveryStatus === 'awaiting_ack'">Sending</template>
          <template v-else-if="q.deliveryStatus === 'queued'">Queued on server</template>
          <template v-else-if="q.deliveryStatus === 'running'">Running</template>
          <template v-else-if="q.deliveryStatus === 'failed'">Failed</template>
        </span>
        <button
          v-if="q.deliveryStatus === 'failed'"
          class="queue-action queue-action--retry"
          type="button"
          title="重试"
          aria-label="重试排队消息"
          @click="emit('retryQueued', q.id)"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 3.5a6.5 6.5 0 1 1-6.26 8.33.75.75 0 1 1 1.44-.43A5 5 0 1 0 7.2 6.7H5.25V5.2a.75.75 0 0 1 1.5 0v.8h.8a.75.75 0 0 1 0 1.5H5.25V6a.75.75 0 0 1 1.5 0v.9A6.48 6.48 0 0 1 10 3.5Z" />
          </svg>
        </button>
        <button
          v-if="q.deliveryStatus === 'offline' || q.deliveryStatus === 'failed' || q.deliveryStatus === undefined"
          class="queue-action queue-action--remove"
          type="button"
          title="移除"
          @click="emit('removeQueued', q.id)"
        >
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
      <div class="attachmentsStrip" aria-label="图片附件缩略图">
        <div
          v-for="(img, idx) in pendingImagePreviews"
          :key="img.key"
          class="attachmentsThumbItem"
          :data-testid="`attachment-item-${idx}`"
        >
          <button
            class="attachmentsThumb"
            type="button"
            :title="`预览图片 ${idx + 1}`"
            :aria-label="`预览图片 ${idx + 1}`"
            @click="openPendingImageViewer(idx)"
          >
            <img v-if="img.src" class="attachmentsThumbImg" :src="img.src" alt="" />
            <span v-else class="attachmentsThumbFallback">图片</span>
          </button>
          <button
            class="attachmentsRemoveBadge"
            type="button"
            :title="`删除图片 ${idx + 1}`"
            :aria-label="`删除图片 ${idx + 1}`"
            :data-testid="`attachment-remove-${idx}`"
            :disabled="inputLocked"
            @click.stop="removeAttachment(idx)"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="inputWrap">
      <input
        ref="fileInputEl"
        type="file"
        accept="image/*"
        multiple
        class="hiddenFileInput"
        :disabled="inputLocked"
        @change="onFileInputChange"
      />
      <div
        ref="composerRowEl"
        class="composerMainRow"
        :class="{
          'composerMainRow--expanded': composerExpanded,
          'composerMainRow--recording': recording || transcribing,
        }"
      >
        <div ref="leftActionsEl" class="composerMainRowLeft">
          <button
            v-if="recording || transcribing"
            type="button"
            class="voiceCancelBtn"
            title="取消录音"
            aria-label="取消录音"
            data-testid="voice-cancel-btn"
            :disabled="transcribing"
            @click="cancelRecording"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button
            v-else
            ref="actionMenuTrigger"
            class="attachIcon composerActionToggle"
            type="button"
            title="更多输入操作"
            aria-label="更多输入操作"
            :aria-expanded="actionMenuOpen"
            :aria-controls="actionMenuOpen ? actionMenuId : undefined"
            aria-haspopup="menu"
            data-testid="composer-actions-toggle"
            :disabled="inputLocked"
            @pointerdown="onActionMenuPointerDown"
            @pointerup="onActionMenuPointerUp"
            @pointercancel="onActionMenuPointerCancel"
            @touchstart="rememberActionMenuSelection"
            @mousedown="rememberActionMenuSelection"
            @click.stop="onActionMenuClick"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M10 3a.75.75 0 0 1 .75.75v5.5h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5h-5.5a.75.75 0 0 1 0-1.5h5.5v-5.5A.75.75 0 0 1 10 3Z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
        <div v-if="recording || transcribing" class="voiceWaveformContainer" aria-hidden="true">
          <template v-if="recording">
            <div class="voiceDotTrail">
              <span v-for="i in 14" :key="`dot-${i}`" class="voiceDot" />
            </div>
            <div
              class="voiceEqualizerBars"
              :class="{ 'voiceEqualizerBars--reactive': voiceWaveformReactive }"
            >
              <span
                v-for="i in 18"
                :key="`eq-${i}`"
                class="eqBar"
                :style="voiceWaveformReactive
                  ? {
                      animation: 'none',
                      opacity: String(0.45 + (voiceWaveformLevels[i - 1] ?? 0.12) * 0.5),
                      transform: `scaleY(${voiceWaveformLevels[i - 1] ?? 0.12})`,
                    }
                  : { animationDelay: `${(i % 5) * 0.12}s` }"
              />
            </div>
          </template>
          <template v-else-if="transcribing">
            <div class="voiceTranscribingState">
              <span class="voiceSpinner" />
              <span class="voiceTranscribingText">正在转录语音…</span>
            </div>
          </template>
        </div>
        <textarea
          v-show="!recording && !transcribing"
          ref="inputEl"
          :disabled="inputLocked"
          rows="1"
          class="composer-input"
          aria-label="Message"
          placeholder="Message..."
          title="Enter to send, Shift+Enter for a new line. Paste images to attach."
          @input="onInput"
          @change="onInput"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @keydown="onInputKeydown"
          @paste="onPaste"
          @select="updateTextSelection"
          @keyup="updateTextSelection"
          @mouseup="updateTextSelection"
          @focus="updateTextSelection"
          @blur="clearTextSelectionState"
        />
        <div ref="rightActionsEl" class="composerMainRowRight">
          <div v-if="recording" class="voiceIndicator recording" aria-hidden="true" style="display: none;">
            <div class="voiceBars">
              <span class="bar" />
              <span class="bar" />
              <span class="bar" />
            </div>
          </div>
          <div v-else-if="transcribing" class="voiceIndicator transcribing" aria-hidden="true" style="display: none;">
            <span class="voiceSpinner" />
          </div>
          <button
            v-if="recording || transcribing"
            class="micIcon voiceStopBtn"
            :class="{ recording, transcribing }"
            :disabled="transcribing"
            type="button"
            title="停止录音并输入"
            data-testid="voice-stop-btn"
            @click="toggleRecording"
          >
            <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
          </button>
          <button
            v-else
            class="micIcon"
            :class="{ recording, transcribing }"
            :disabled="canInterrupt || transcribing || (inputLocked && !recording)"
            type="button"
            title="语音输入（追加到输入框）"
            data-testid="composer-mic-btn"
            @click="toggleRecording"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 13.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4.5a3 3 0 0 0 3 3Z" />
              <path
                d="M5.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 1 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V18a.75.75 0 0 1-1.5 0v-1.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75Z"
              />
            </svg>
          </button>
          <button v-if="canInterrupt" class="stopIcon" type="button" title="中断" @click="emit('interrupt')">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
            <span v-if="runningTaskCount > 0" class="runningBadge">{{ runningTaskCount }}</span>
          </button>
          <button
            v-else
            class="sendIcon"
            :class="{ 'sendIcon--activeVoice': recording }"
            :disabled="!recording && (inputLocked || (!hasContent && pendingImages.length === 0) || transcribing)"
            type="button"
            :title="recording ? '停止并直接发送' : '发送'"
            data-testid="composer-send-btn"
            @pointerdown="onSendPointerDown"
            @pointermove="onSendPointerMove"
            @pointercancel="onSendPointerCancel"
            @pointerup="onSendPointerUp"
            @click="onSendClick"
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
      </div>
      <Teleport to="body">
        <div
          v-if="actionMenuOpen"
          :id="actionMenuId"
          ref="actionMenuElement"
          class="actionSheet"
          :style="actionMenuStyle"
          role="menu"
          aria-label="输入操作"
          data-testid="composer-action-sheet"
          @click.stop
        >
          <button
            class="actionSheetItem"
            type="button"
            role="menuitem"
            data-testid="action-attach-image"
            :disabled="inputLocked"
            @click="attachFromActionMenu"
          >
            <span class="actionSheetIcon" aria-hidden="true">📎</span>
            <span>添加图片附件</span>
          </button>
          <button
            class="actionSheetItem"
            type="button"
            role="menuitem"
            data-testid="wrap-triple-quotes"
            :disabled="inputLocked || !hasTextSelection"
            @click="quoteFromActionMenu"
          >
            <span class="actionSheetIcon actionSheetIcon--mono" aria-hidden="true">&quot;&quot;&quot;</span>
            <span>快速引用选中文本</span>
          </button>
          <button
            class="actionSheetItem"
            type="button"
            role="menuitem"
            data-testid="restore-latest-prompt"
            :disabled="!canRestoreLatestPrompt"
            @click="restoreFromActionMenu"
          >
            <span class="actionSheetIcon" aria-hidden="true">↺</span>
            <span>恢复上一条输入</span>
          </button>
        </div>
      </Teleport>
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

    <MainChatPendingImageViewer v-if="pendingImageViewerOpen" :previews="pendingImagePreviews" @close="closePendingImageViewer" />
  </div>
</template>

<style scoped>
.sendIcon,
.composerActionToggle,
.micIcon,
.stopIcon {
  touch-action: manipulation;
}

.composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 16px var(--app-safe-bottom, env(safe-area-inset-bottom, 0px));
  background: var(--app-bg, #ffffff);
  position: relative;
  z-index: 20;
}

.laneStatusBar {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
  font-weight: 600;
}

.laneStatusBar--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: #fef2f2;
  color: #b91c1c;
}

.laneStatusBar--info,
.laneStatusBar--progress {
  border-color: rgba(96, 165, 250, 0.45);
  background: #eff6ff;
  color: #1d4ed8;
}

.laneStatusBar--progress .laneStatusDot {
  animation: laneStatusPulse 1.2s ease-in-out infinite;
}

@keyframes laneStatusPulse {
  50% {
    opacity: 0.35;
  }
}

.laneStatusDot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: currentColor;
  flex-shrink: 0;
}

.laneStatusText {
  min-width: 0;
  line-height: 1.35;
  word-break: break-word;
}

.queue {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding-right: 2px;
}

.queue-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04), 0 4px 12px rgba(15, 23, 42, 0.03);
  backdrop-filter: blur(8px);
}

.queue-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.1);
  color: #2563eb;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-mono, monospace);
  line-height: 1.4;
  flex-shrink: 0;
  margin-top: 1px;
}

.queue-text {
  min-width: 0;
  flex: 1;
  font-size: 12.5px;
  line-height: 1.45;
  color: #0f172a;
  font-weight: 500;
  max-height: calc(1.45em * 3);
  overflow-y: auto;
  overflow-x: hidden;
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.5) transparent;
}

.queue-text::-webkit-scrollbar {
  width: 4px;
}

.queue-text::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.5);
  border-radius: 999px;
}

.queue-sub {
  color: #64748b;
  font-weight: 600;
  font-size: 11.5px;
}

.queue-status {
  flex-shrink: 0;
  align-self: center;
  font-size: 10.5px;
  font-weight: 600;
  color: #64748b;
  white-space: nowrap;
}

.queue-status[data-status="queued"] {
  color: #2563eb;
}

.queue-status[data-status="running"] {
  color: #15803d;
}

.queue-status[data-status="failed"] {
  color: #dc2626;
}

.queue-action {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  margin-top: 1px;
  transition: color 0.12s ease, background 0.12s ease;
}

.queue-action:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.queue-action--retry:hover {
  color: #2563eb;
  background: rgba(37, 99, 235, 0.08);
}

.inputWrap {
  width: 100%;
  box-sizing: border-box;
  position: relative;
  border-radius: 24px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 24px rgba(15, 23, 42, 0.06);
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.inputWrap:focus-within {
  border-color: rgba(37, 99, 235, 0.55);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 24px rgba(15, 23, 42, 0.08), 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.hiddenFileInput {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.composerMainRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "left input right";
  align-items: flex-end;
  padding: 8px;
  flex-shrink: 0;
  column-gap: 6px;
  row-gap: 2px;
}

.composerMainRow--expanded {
  grid-template-areas:
    "input input input"
    "left . right";
  row-gap: 2px;
}

.composerMainRow--recording {
  background: var(--surface-2, #f1f5f9);
  border-radius: 999px;
  align-items: center;
  min-height: 48px;
  padding: 4px 8px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: background-color 0.2s ease, border-radius 0.2s ease;
}

.voiceCancelBtn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--surface-3, rgba(148, 163, 184, 0.25));
  color: var(--text, #0f172a);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.1s ease;
}

.voiceCancelBtn:hover:not(:disabled) {
  background: rgba(148, 163, 184, 0.38);
}

.voiceCancelBtn:active:not(:disabled) {
  transform: scale(0.95);
}

.voiceCancelBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.voiceWaveformContainer {
  grid-area: input;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  height: 36px;
  overflow: hidden;
  padding: 0 6px;
  user-select: none;
}

.voiceDotTrail {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.55;
  overflow: hidden;
}

.voiceDot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #94a3b8;
  flex-shrink: 0;
}

.voiceEqualizerBars {
  display: flex;
  align-items: center;
  gap: 2.5px;
  height: 28px;
  padding-right: 4px;
}

.eqBar {
  width: 3px;
  min-height: 4px;
  height: 12px;
  border-radius: 999px;
  background: var(--text, #334155);
  animation: eqWave 0.65s ease-in-out infinite alternate;
}

.voiceEqualizerBars--reactive .eqBar {
  animation: none;
  transform-origin: center;
  will-change: transform, opacity;
}

@keyframes eqWave {
  0% {
    height: 5px;
    opacity: 0.45;
  }
  50% {
    height: 24px;
    opacity: 0.95;
  }
  100% {
    height: 12px;
    opacity: 0.65;
  }
}

.voiceTranscribingState {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #2563eb;
  font-size: 13px;
  font-weight: 600;
}

.voiceTranscribingText {
  animation: voicePulse 1.5s ease-in-out infinite;
}

@keyframes voicePulse {
  0%, 100% { opacity: 0.65; }
  50% { opacity: 1; }
}

.micIcon.voiceStopBtn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--surface-3, rgba(148, 163, 184, 0.28));
  color: var(--text, #0f172a);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.1s ease;
}

.micIcon.voiceStopBtn:hover:not(:disabled) {
  background: rgba(148, 163, 184, 0.42);
}

.micIcon.voiceStopBtn:active:not(:disabled) {
  transform: scale(0.95);
}

.sendIcon--activeVoice {
  background: #007aff !important;
  opacity: 1 !important;
  cursor: pointer !important;
  box-shadow: 0 1px 4px rgba(0, 122, 255, 0.35);
}

.sendIcon--activeVoice:active {
  transform: scale(0.95);
}

.composerMainRowLeft,
.composerMainRowRight {
  display: flex;
  flex: 0 0 auto;
  min-height: 34px;
  gap: 6px;
  align-items: center;
}

.composerMainRowLeft {
  grid-area: left;
}

.composerMainRowRight {
  grid-area: right;
}

.attachIcon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--muted, #64748b);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

.attachIcon:hover:not(:disabled) {
  color: var(--text, #0f172a);
  background: rgba(15, 23, 42, 0.06);
}

.attachIcon:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.composerActionToggle:focus-visible,
.micIcon:focus-visible,
.sendIcon:focus-visible,
.stopIcon:focus-visible,
.actionSheetItem:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}

.actionSheet {
  position: fixed;
  z-index: 200;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  display: grid;
  grid-auto-rows: max-content;
  gap: 2px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.16);
}

.actionSheetItem {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: #334155;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.actionSheetItem:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.08);
  color: #1d4ed8;
}

.actionSheetItem:disabled {
  color: #94a3b8;
  cursor: not-allowed;
  opacity: 0.6;
}

.actionSheetIcon {
  width: 22px;
  flex: 0 0 22px;
  text-align: center;
  font-size: 15px;
  line-height: 1;
}

.actionSheetIcon--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: -1px;
}

.voiceIndicator {
  width: 22px;
  height: 18px;
  display: grid;
  place-items: center;
}

.voiceIndicator.recording {
  color: #dc2626;
}

.voiceIndicator.transcribing {
  color: #2563eb;
}

.voiceBars {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 14px;
}

.voiceBars .bar {
  width: 3px;
  border-radius: 3px;
  background: currentColor;
  animation: voiceBars 0.45s ease-in-out infinite;
}

.voiceBars .bar:nth-child(2) {
  animation-delay: 0.08s;
}

.voiceBars .bar:nth-child(3) {
  animation-delay: 0.16s;
}

.voiceSpinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(37, 99, 235, 0.22);
  border-top-color: currentColor;
  animation: voiceSpin 0.75s linear infinite;
}

.voiceToast {
  position: absolute;
  right: 8px;
  top: -36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-size: 12px;
  color: var(--muted);
  max-width: min(72vw, 380px);
  pointer-events: none;
  animation: voiceToastIn 0.14s ease-out;
}

.voiceToast.ok {
  border-color: rgba(16, 185, 129, 0.25);
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
}

.voiceToast.error {
  border-color: rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.06);
  color: #dc2626;
}

.voiceToastIcon {
  width: 14px;
  height: 14px;
  display: block;
  flex-shrink: 0;
}

.voiceToastText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachmentsBar {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-height: 56px;
  margin-bottom: 4px;
  padding: 4px 6px 2px;
}

.attachmentsStrip {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow-x: auto;
  max-width: 100%;
  padding: 6px 4px;
}

.attachmentsThumbItem {
  position: relative;
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
}

.attachmentsThumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(226, 232, 240, 0.9));
  background: var(--surface-2, rgba(15, 23, 42, 0.04));
  overflow: hidden;
  box-sizing: border-box;
  padding: 0;
  display: block;
  cursor: pointer;
  transition: transform 0.1s ease, box-shadow 0.15s ease;
}

.attachmentsThumb:hover {
  transform: scale(1.02);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

.attachmentsThumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.attachmentsThumbImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.attachmentsThumbFallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 700;
  color: #64748b;
}

.attachmentsRemoveBadge {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--surface, #ffffff);
  background: #475569;
  color: #ffffff;
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  z-index: 2;
  transition: background-color 0.15s ease, transform 0.1s ease;
}

.attachmentsRemoveBadge:hover {
  background: #ef4444;
  transform: scale(1.1);
}

.attachmentsRemoveBadge:active {
  transform: scale(0.95);
}

.composer-input {
  grid-area: input;
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  resize: none;
  overflow-y: hidden;
  min-height: 34px;
  border-radius: 0;
  border: none;
  padding: 6px 4px;
  font-size: 16px;
  line-height: 1.5;
  background: transparent;
  color: #0f172a;
  box-sizing: border-box;
}

.composer-input::placeholder {
  color: var(--muted-2, #94a3b8);
}

.composer-input:focus {
  outline: none;
  background: transparent;
  box-shadow: none;
}

.micIcon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--muted, #64748b);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s, transform 0.1s;
}

.micIcon:hover:not(:disabled) {
  color: #0f172a;
}

.micIcon:active:not(:disabled) {
  transform: scale(0.98);
}

.micIcon:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.micIcon.recording {
  color: #dc2626;
}

.micIcon.recording:hover:not(:disabled) {
  color: #b91c1c;
}

.micIcon.transcribing {
  color: #2563eb;
}

.sendIcon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: #2563eb;
  color: #ffffff;
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
  transition: background-color 0.15s, box-shadow 0.15s, transform 0.1s;
}

.sendIcon:disabled {
  background: #e2e8f0;
  color: #94a3b8;
  box-shadow: none;
  cursor: not-allowed;
}

.sendIcon:hover:not(:disabled) {
  background: #1d4ed8;
}

.sendIcon:active:not(:disabled) {
  transform: scale(0.94);
}

.stopIcon {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: #ef4444;
  color: #ffffff;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background-color 0.15s;
}

.runningBadge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: #dc2626;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

.stopIcon:hover {
  background: #dc2626;
}

@media (max-width: 768px) {
  .composer {
    padding-left: 12px;
    padding-right: 12px;
  }

  .actionSheet {
    width: min(270px, calc(100vw - 40px));
  }
}

@keyframes voiceBars {
  0%,
  100% {
    height: 4px;
    opacity: 0.55;
  }

  50% {
    height: 14px;
    opacity: 1;
  }
}

@keyframes voiceSpin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes voiceToastIn {
  from {
    transform: translateY(4px);
    opacity: 0;
  }

  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
