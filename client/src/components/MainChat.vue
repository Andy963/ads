<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChatDotRound, Refresh } from "@element-plus/icons-vue";
import MarkdownContent from "./MarkdownContent.vue";
import DraggableModal from "./DraggableModal.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt, RenderMessage } from "./mainChat/types";
import { useMainChatComposer } from "./mainChat/useComposer";
import { useCopyMessage } from "./mainChat/useCopyMessage";
import { resolveComposerImagePreview } from "./mainChat/attachmentPreview";
import { isPatchMessageMarkdown } from "../lib/patch_message";
import { analyzeMarkdownOutline } from "../lib/markdown";
import type { ModelConfig } from "../api/types";

const props = defineProps<{
  title?: string;
  messages: ChatMessage[];
  queuedPrompts: QueuedPrompt[];
  pendingImages: IncomingImage[];
  connected: boolean;
  busy: boolean;
  readOnly?: boolean;
  agents?: Array<{ id: string; name: string; ready: boolean; error?: string }>;
  activeAgentId?: string;
  models?: ModelConfig[];
  modelId?: string;
  modelReasoningEffort?: string;
  agentDelegations?: Array<{
    id: string;
    agentId: string;
    agentName: string;
    prompt: string;
    startedAt: number;
  }>;
  apiToken?: string;
  headerAction?: { title: string; ariaLabel?: string; testId?: string };
  headerResumeAction?: { title: string; ariaLabel?: string; testId?: string; disabled?: boolean };
}>();

const emit = defineEmits<{
  (e: "send", content: string): void;
  (e: "interrupt"): void;
  (e: "clear"): void;
  (e: "newSession"): void;
  (e: "resumeThread"): void;
  (e: "addImages", images: IncomingImage[]): void;
  (e: "clearImages"): void;
  (e: "removeQueued", id: string): void;
  (e: "switchAgent", agentId: string): void;
  (e: "setModel", modelId: string): void;
  (e: "setReasoningEffort", effort: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const showScrollToBottom = ref(false);

const openCommandTrees = ref<Set<string>>(new Set());

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

async function scrollChatToBottom(): Promise<void> {
  if (!listRef.value) return;
  await nextTick();
  if (!listRef.value) return;
  listRef.value.scrollTop = listRef.value.scrollHeight;
  autoScroll.value = true;
  showScrollToBottom.value = false;
}

const scrollToBottom = scrollChatToBottom;

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

function isCommandTreeOpen(id: string, commandsCount: number): boolean {
  void commandsCount;
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
  // Keep the collapsed outline within the 3-line clamp: 2 titles + a "+N more" line.
  return titles.slice(0, 2);
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

function isLiveStepRenderMessage(m: RenderMessage): boolean {
  return m.id === LIVE_STEP_MESSAGE_ID && m.role === "assistant" && m.kind === "text";
}

const renderMessages = computed<RenderMessage[]>(() => {
  let latestExecuteId: string | null = null;
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i]!;
    if (m.kind === "execute") {
      latestExecuteId = m.id;
      break;
    }
  }

  // Execute previews are only meaningful while the agent is running; finalized command
  // trees are no longer shown, so we also suppress command summary items here.
  return props.messages.filter((m) => m.kind !== "command" && (m.kind !== "execute" || m.id === latestExecuteId));
});

	const canInterrupt = computed(() => props.busy);
	const showActiveBorder = computed(() => props.busy);

	const agentOptions = computed(() => (Array.isArray(props.agents) ? props.agents : []));
	const readyAgentOptions = computed(() => agentOptions.value.filter((a) => Boolean(a?.ready) && String(a?.id ?? "").trim()));
	const modelOptions = computed(() => (Array.isArray(props.models) ? props.models : []));

	const selectedAgentId = computed(() => {
	  const active = String(props.activeAgentId ?? "").trim();
	  if (active && readyAgentOptions.value.some((a) => String(a.id ?? "").trim() === active)) {
	    return active;
	  }
	  const fallback = readyAgentOptions.value[0]?.id ?? "";
	  return String(fallback ?? "").trim();
	});

	function formatAgentLabel(agent: { id: string; name: string; ready: boolean; error?: string }): string {
	  const id = String(agent.id ?? "").trim();
	  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name;
  if (agent.ready) return base || "agent";
	  const suffix = String(agent.error ?? "").trim() || "unavailable";
	  return base ? `${base} - ${suffix}` : suffix;
	}

	const lastAutoSwitchedAgentId = ref<string | null>(null);

	watch(
	  () => [
	    Boolean(props.connected),
	    Boolean(props.busy),
	    Boolean(props.readOnly),
	    String(props.activeAgentId ?? "").trim(),
	    readyAgentOptions.value.map((a) => String(a.id ?? "").trim()).join("\n"),
	  ],
	  () => {
	    if (!props.connected || props.busy || props.readOnly) {
	      lastAutoSwitchedAgentId.value = null;
	      return;
	    }

	    const options = readyAgentOptions.value;
	    if (options.length === 0) {
	      lastAutoSwitchedAgentId.value = null;
	      return;
	    }

	    const active = String(props.activeAgentId ?? "").trim();
	    if (active && options.some((a) => String(a.id ?? "").trim() === active)) {
	      lastAutoSwitchedAgentId.value = null;
	      return;
	    }

	    const next = selectedAgentId.value;
	    if (!next || next === active) return;
	    if (lastAutoSwitchedAgentId.value === next) return;

	    lastAutoSwitchedAgentId.value = next;
	    emit("switchAgent", next);
	  },
	  { immediate: true },
	);

	function onAgentChange(ev: Event): void {
	  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
	  const next = String(value ?? "").trim();
	  if (!next) return;
  emit("switchAgent", next);
}

function normalizeModelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function isUnsetModelId(modelId: string): boolean {
  const id = String(modelId ?? "").trim().toLowerCase();
  return !id || id === "auto";
}

function modelAllowedAgents(model: ModelConfig): string[] | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return null;
  const agents = raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return agents.length > 0 ? agents : null;
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

function isGeminiModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.includes("gemini") || id.startsWith("auto-gemini");
}

function supportsAgentModel(args: { agentId: string; model: ModelConfig }): boolean {
  const agentId = String(args.agentId ?? "").trim().toLowerCase();
  if (!agentId) return true;

  const allowed = modelAllowedAgents(args.model);
  if (allowed) {
    return allowed.map((id) => id.toLowerCase()).includes(agentId);
  }

  const provider = String(args.model.provider ?? "").trim().toLowerCase();
  const modelId = String(args.model.id ?? "").trim();

  if (agentId === "claude") {
    if (provider.includes("anthropic")) return true;
    return isClaudeModelId(modelId);
  }
  if (agentId === "gemini") {
    if (provider.includes("google")) return true;
    return isGeminiModelId(modelId);
  }
  if (agentId === "codex") {
    if (provider.includes("anthropic") || provider.includes("google")) return false;
    if (isClaudeModelId(modelId) || isGeminiModelId(modelId)) return false;
    return true;
  }

  return true;
}

const filteredModelOptions = computed(() => {
  const agentId = selectedAgentId.value;
  return modelOptions.value.filter((model) => supportsAgentModel({ agentId, model }));
});

const effectiveModelId = computed(() => {
  const options = filteredModelOptions.value;
  if (options.length === 0) return "";
  const current = normalizeModelId(props.modelId);
  if (!isUnsetModelId(current) && options.some((m) => String(m.id ?? "").trim() === current)) {
    return current;
  }
  return String(options[0]?.id ?? "").trim();
});

watch(
  () => [selectedAgentId.value, props.modelId, filteredModelOptions.value.map((m) => String(m.id ?? "").trim()).join("\n")],
  () => {
    const options = filteredModelOptions.value;
    if (options.length === 0) return;
    const desired = String(options[0]?.id ?? "").trim();
    if (!desired) return;

    const current = normalizeModelId(props.modelId);
    if (!isUnsetModelId(current) && options.some((m) => String(m.id ?? "").trim() === current)) {
      return;
    }

    if (desired !== current) {
      emit("setModel", desired);
    }
  },
  { immediate: true },
);

function formatModelLabel(model: ModelConfig): string {
  const id = String(model.id ?? "").trim();
  const name = String(model.displayName ?? "").trim() || id;
  return name || "model";
}

function onModelChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
  const next = normalizeModelId(value);
  if (!next || isUnsetModelId(next)) return;
  emit("setModel", next);
}

const reasoningEffortValue = computed(() => {
  const raw = String(props.modelReasoningEffort ?? "").trim().toLowerCase();
  if (raw === "medium" || raw === "high" || raw === "xhigh") return raw;
  if (raw === "low") return "medium";
  return "high";
});

function onReasoningEffortChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement | null)?.value ?? "";
  emit("setReasoningEffort", String(value ?? "").trim());
}

const agentDelegationLabel = computed(() => {
  const entries = Array.isArray(props.agentDelegations) ? props.agentDelegations : [];
  if (!props.busy || entries.length === 0) return "";
  const names: string[] = [];
  for (const entry of entries) {
    const label = String(entry.agentName || entry.agentId || "").trim();
    if (!label) continue;
    if (!names.includes(label)) names.push(label);
  }
  if (names.length === 0) return "Delegating to agents…";
  const shown = names.slice(0, 3).join(", ");
  const hidden = Math.max(0, names.length - 3);
  const suffix = hidden ? ` +${hidden} more` : "";
  return `Delegating to: ${shown}${suffix}`;
});

const { copiedMessageId, onCopyMessage, formatMessageTs } = useCopyMessage();

const pendingImageViewerOpen = ref(false);
const pendingImageViewerIndex = ref(0);

type PendingImagePreview = {
  key: string;
  src: string;
  href: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

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

const activePendingImage = computed<PendingImagePreview | null>(() => {
  const list = props.pendingImages;
  if (!list.length) return null;
  const idx = clamp(pendingImageViewerIndex.value, 0, list.length - 1);
  return pendingImagePreviews.value[idx] ?? null;
});

const activePendingImageAlt = computed(() => {
  const total = props.pendingImages.length;
  if (!total) return "Attachment image";
  const idx = clamp(pendingImageViewerIndex.value, 0, total - 1);
  return `Attachment image ${idx + 1} of ${total}`;
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

function showPrevPendingImage(): void {
  const total = props.pendingImages.length;
  if (total <= 1) return;
  pendingImageViewerIndex.value = (pendingImageViewerIndex.value - 1 + total) % total;
}

function showNextPendingImage(): void {
  const total = props.pendingImages.length;
  if (total <= 1) return;
  pendingImageViewerIndex.value = (pendingImageViewerIndex.value + 1) % total;
}

function onPendingImageViewerKeydown(ev: KeyboardEvent): void {
  if (!pendingImageViewerOpen.value) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closePendingImageViewer();
    return;
  }
  if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    showPrevPendingImage();
    return;
  }
  if (ev.key === "ArrowRight") {
    ev.preventDefault();
    showNextPendingImage();
  }
}

watch(
  () => pendingImageViewerOpen.value,
  (open) => {
    if (typeof window === "undefined") return;
    if (open) window.addEventListener("keydown", onPendingImageViewerKeydown);
    else window.removeEventListener("keydown", onPendingImageViewerKeydown);
  },
  { flush: "post" },
);

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

function shouldShowMsgActions(m: RenderMessage): boolean {
  if (m.streaming && m.content.length === 0) return false;
  // Patch diffs are machine-generated; hide copy/timestamp chrome to keep them compact.
  if (m.kind === "text" && m.role === "system" && isPatchMessageMarkdown(m.content)) return false;
  return true;
}

function shouldUseCompactBubble(m: RenderMessage): boolean {
  // Compact layout when we don't render footer actions.
  return !shouldShowMsgActions(m);
}

const { input, inputEl, fileInputEl, send, onInputKeydown, onPaste, recording, transcribing, voiceStatusKind, voiceStatusMessage, toggleRecording, triggerFileInput, onFileInputChange } =
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
  autoScroll.value = distance < CHAT_STICKY_THRESHOLD_PX;
  showScrollToBottom.value = distance >= CHAT_STICKY_THRESHOLD_PX;
}

onMounted(() => {
  // Project switches remount this component (keyed by activeProjectId). Ensure we start at the newest message.
  autoScroll.value = true;
  void scrollChatToBottom();

  const host = listRef.value;
  if (host && typeof ResizeObserver !== "undefined") {
    chatResizeObserver = new ResizeObserver(() => {
      // If the chat pane is initially hidden (e.g. mobile tab), scrollHeight can be 0.
      // Once the pane becomes visible, ensure we still land at the bottom.
      scheduleChatScrollToBottom();
    });
    chatResizeObserver.observe(host);
  }
});

watch(
  () => props.messages.length,
  async () => {
    if (autoScroll.value && listRef.value) {
      await nextTick();
      if (!listRef.value) return;
      listRef.value.scrollTop = listRef.value.scrollHeight;
      showScrollToBottom.value = false;
      return;
    }
    showScrollToBottom.value = true;
  },
);

const lastMessage = computed(() => props.messages[props.messages.length - 1] ?? null);
const liveActivityMessage = computed(
  () => props.messages.find((m) => m.id === LIVE_ACTIVITY_MESSAGE_ID) ?? null,
);

watch(
  [() => lastMessage.value?.id ?? "", () => lastMessage.value?.content.length ?? 0, () => Boolean(lastMessage.value?.streaming)],
  () => {
    scheduleChatScrollToBottom();
  },
  { flush: "post" },
);

watch(
  [() => Boolean(liveActivityMessage.value), () => liveActivityMessage.value?.content.length ?? 0],
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
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", onPendingImageViewerKeydown);
  }
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

function getCommands(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.match(/^\$\s*/))
    .map((line) => line.replace(/^\$\s*/, ""));
}

const commandTreeCommandsById = computed(() => {
  const map = new Map<string, string[]>();
  for (const m of renderMessages.value) {
    if (m.kind !== "command") continue;
    map.set(m.id, getCommands(m.content));
  }
  return map;
});

function getCommandTreeCommands(m: RenderMessage): string[] {
  return commandTreeCommandsById.value.get(m.id) ?? [];
}

function getCommandTreeShownCount(m: RenderMessage): number {
  if (typeof m.commandsShown === "number" && Number.isFinite(m.commandsShown) && m.commandsShown >= 0) return m.commandsShown;
  return getCommandTreeCommands(m).length;
}

function getCommandTreeTotalCount(m: RenderMessage): number {
  const shown = getCommandTreeShownCount(m);
  if (typeof m.commandsTotal === "number" && Number.isFinite(m.commandsTotal) && m.commandsTotal >= 0) return m.commandsTotal;
  return shown;
}

function hasCommandTreeOverflow(m: RenderMessage): boolean {
  return getCommandTreeTotalCount(m) > getCommandTreeShownCount(m);
}

</script>

<template>
  <div class="detail" :class="{ 'detail--active': showActiveBorder }">
    <div v-if="title" class="paneHeader">
      <div class="paneTitle">{{ title }}</div>
      <div class="paneHeaderActions">
        <button
          v-if="headerResumeAction"
          class="paneHeaderIconBtn"
          type="button"
          :title="headerResumeAction.title"
          :aria-label="headerResumeAction.ariaLabel || headerResumeAction.title"
          :disabled="busy || Boolean(headerResumeAction.disabled)"
          :data-testid="headerResumeAction.testId"
          @click.stop="emit('resumeThread')"
        >
          <el-icon :size="16" aria-hidden="true">
            <Refresh />
          </el-icon>
        </button>
        <button
          v-if="headerAction"
          class="paneHeaderIconBtn"
          type="button"
          :title="headerAction.title"
          :aria-label="headerAction.ariaLabel || headerAction.title"
          :disabled="busy"
          :data-testid="headerAction.testId"
          @click.stop="emit('newSession')"
        >
          <el-icon :size="16" aria-hidden="true">
            <ChatDotRound />
          </el-icon>
        </button>
      </div>
    </div>
    <div ref="listRef" class="chat" @scroll="handleScroll">
      <div v-if="messages.length === 0" class="chat-empty">
        <span>直接开始对话…</span>
      </div>
      <div v-for="m in renderMessages" :key="m.id" class="msg" :data-id="m.id" :data-role="m.role" :data-kind="m.kind">
        <div v-if="m.kind === 'command'" class="command-block">
          <button class="command-tree-header" type="button" aria-label="Toggle commands"
            :aria-expanded="isCommandTreeOpen(m.id, getCommandTreeCommands(m).length)" @click="toggleCommandTree(m.id)">
            <span v-if="getCommandTreeCommands(m).length > 0" class="command-caret" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="caretPath(isCommandTreeOpen(m.id, getCommandTreeCommands(m).length))" />
              </svg>
            </span>
            <span class="prompt-tag">Executes</span>
            <span class="command-count">
              {{ getCommandTreeTotalCount(m) }} 条命令<span v-if="hasCommandTreeOverflow(m)">
                (showing last {{ getCommandTreeShownCount(m) }})</span>
            </span>
          </button>
          <div v-if="isCommandTreeOpen(m.id, getCommandTreeCommands(m).length)" class="command-tree">
            <div v-for="(cmd, cIdx) in getCommandTreeCommands(m)" :key="cIdx" class="command-tree-item">
              <span class="command-tree-branch">├─</span>
              <span class="command-cmd">{{ cmd }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="m.kind === 'execute'" :class="['bubble', 'bubble--compact', 'execute-block']">
          <div class="execute-header">
            <div class="execute-left">
              <span class="prompt-tag">&gt;_</span>
              <span class="execute-cmd" :title="m.command || ''">{{ m.command || "" }}</span>
            </div>
          </div>
          <pre v-if="m.content.trim()" class="execute-output">{{ m.content }}</pre>
          <div v-if="(m.hiddenLineCount ?? 0) > 0" class="execute-more">… {{ m.hiddenLineCount }} more lines</div>
        </div>
        <div v-else :class="[
          'bubble',
          {
            'bubble--compact': shouldUseCompactBubble(m),
          },
        ]">
          <div v-if="m.role === 'assistant' && m.kind === 'text' && m.streaming && m.content.length === 0"
            class="typing" aria-label="AI is thinking">
            <span class="thinkingText">thinking</span>
          </div>
          <div v-else-if="isLiveStepRenderMessage(m)" class="liveStep">
            <div class="liveStepBody" :data-expanded="String(liveStepExpanded)"
              :data-outline-only="String(!liveStepExpanded && liveStepOutlineItems.length > 0)"
              :data-trivial-outline="String(liveStepCollapsedTrivialOutline)"
              :class="{ 'liveStepBody--clamped': liveStepHasOverflow && !liveStepExpanded && liveStepCanToggleExpanded }">
              <MarkdownContent :content="m.content" />
              <div v-if="!liveStepExpanded && liveStepOutlineItems.length > 0" class="liveStepOutline" aria-hidden="true">
                <div v-for="(title, idx) in liveStepOutlineItems" :key="idx" class="liveStepOutlineItem" :title="title">
                  <span class="liveStepOutlineBullet" aria-hidden="true">•</span>
                  <span class="liveStepOutlineText">{{ title }}</span>
                </div>
                <div v-if="liveStepOutlineHiddenCount > 0" class="liveStepOutlineMore">
                  +{{ liveStepOutlineHiddenCount }} more
                </div>
              </div>
            </div>
            <div v-if="liveStepCanToggleExpanded" class="liveStepToggleRow">
              <button class="liveStepToggleBtn" type="button" :aria-expanded="liveStepExpanded"
                @click.stop="toggleLiveStepExpanded">
                {{ liveStepExpanded ? "Collapse" : "Expand" }}
              </button>
            </div>
          </div>
          <MarkdownContent v-else :content="m.content" />
          <div v-if="shouldShowMsgActions(m)" class="msgActions">
            <button class="msgCopyBtn" type="button" aria-label="Copy message" @click="onCopyMessage(m)">
              <svg v-if="copiedMessageId === m.id" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            <span v-if="m.ts" class="msgTime">{{ formatMessageTs(m.ts) }}</span>
          </div>
        </div>
      </div>
      <button v-if="showScrollToBottom" class="scrollToBottom" type="button" aria-label="Scroll to bottom" title="回到底部"
        @click="scrollToBottom">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </button>
    </div>

    <div v-if="!readOnly" class="composer">
      <div v-if="agentDelegationLabel" class="delegationBar" aria-label="Agent delegation status">
        <span class="delegationSpinner" aria-hidden="true" />
        <span class="delegationText">{{ agentDelegationLabel }}</span>
      </div>

      <div v-if="queuedPrompts.length" class="queue" aria-label="排队消息">
        <div v-for="q in queuedPrompts" :key="q.id" class="queue-item">
          <div class="queue-text">
            {{ q.text || `[图片 x${q.imagesCount}]` }}
            <span v-if="q.text && q.imagesCount" class="queue-sub"> · 图片 x{{ q.imagesCount }}</span>
          </div>
          <button class="queue-del" type="button" title="移除" @click="emit('removeQueued', q.id)">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="pendingImages.length" class="attachmentsBar" aria-label="已粘贴图片">
        <div class="attachmentsStrip" aria-label="图片附件缩略图">
          <button
            v-for="(img, idx) in pendingImagePreviews"
            :key="img.key"
            class="attachmentsThumb"
            type="button"
            :title="`预览图片 ${idx + 1}`"
            :aria-label="`预览图片 ${idx + 1}`"
            @click="openPendingImageViewer(idx)"
          >
            <img v-if="img.src" class="attachmentsThumbImg" :src="img.src" alt="" />
            <span v-else class="attachmentsThumbFallback">图片</span>
          </button>
        </div>
        <button class="attachmentsClear" type="button" title="清空图片" @click="emit('clearImages')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd"
              d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
              clip-rule="evenodd" />
          </svg>
        </button>
      </div>

      <div class="inputWrap">
        <input
          ref="fileInputEl"
          type="file"
          accept="image/*"
          multiple
          class="hiddenFileInput"
          @change="onFileInputChange"
        />
        <textarea v-model="input" ref="inputEl" rows="5" class="composer-input"
          placeholder="输入…（Enter 发送，Alt+Enter 换行，粘贴图片）" @keydown="onInputKeydown" @paste="onPaste" />
	        <div class="inputToolbar">
	          <div class="inputToolbarLeft">
	            <button class="attachIcon" type="button" title="添加图片附件" @click="triggerFileInput">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M15.621 4.379a3.5 3.5 0 0 0-4.95 0l-7.07 7.07a5 5 0 0 0 7.07 7.072l4.95-4.95a.75.75 0 0 0-1.06-1.061l-4.95 4.95a3.5 3.5 0 1 1-4.95-4.95l7.07-7.07a2 2 0 1 1 2.83 2.828l-7.07 7.071a.5.5 0 0 1-.707-.707l4.95-4.95a.75.75 0 1 0-1.06-1.06l-4.95 4.95a2 2 0 0 0 2.828 2.828l7.07-7.071a3.5 3.5 0 0 0 0-4.95Z" clip-rule="evenodd" />
              </svg>
            </button>
	            <div v-if="readyAgentOptions.length" class="agentSelect">
	              <select
	                class="agentSelectInput"
	                :value="selectedAgentId"
	                :disabled="!connected || busy"
	                aria-label="Select agent"
	                @change="onAgentChange"
	              >
	                <option v-for="a in readyAgentOptions" :key="a.id" :value="a.id">
	                  {{ formatAgentLabel(a) }}
	                </option>
	              </select>
	            </div>
            <div v-if="agentOptions.length" class="agentSelect">
              <select
                class="agentSelectInput"
                :value="effectiveModelId"
                :disabled="!connected || busy || filteredModelOptions.length === 0"
                aria-label="Select model"
                data-testid="chat-model-select"
                @change="onModelChange"
              >
                <option v-if="filteredModelOptions.length === 0" value="" disabled>
                  No models
                </option>
                <option v-for="m in filteredModelOptions" :key="m.id" :value="m.id">
                  {{ formatModelLabel(m) }}
                </option>
              </select>
            </div>
            <div v-if="selectedAgentId === 'codex'" class="agentSelect">
              <select
                class="agentSelectInput"
                :value="reasoningEffortValue"
                :disabled="!connected || busy"
                aria-label="Select reasoning effort"
                data-testid="chat-reasoning-effort"
                @change="onReasoningEffortChange"
              >
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra High</option>
              </select>
            </div>
          </div>
          <div class="inputToolbarRight">
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
            <button class="micIcon" :class="{ recording, transcribing }" :disabled="canInterrupt || transcribing"
              type="button" :title="recording ? '停止录音' : '语音输入（追加到输入框）'" @click="toggleRecording">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 13.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v4.5a3 3 0 0 0 3 3Z" />
                <path
                  d="M5.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 1 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V18a.75.75 0 0 1-1.5 0v-1.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75Z" />
              </svg>
            </button>
            <button v-if="canInterrupt" class="stopIcon" type="button" title="中断" @click="emit('interrupt')">
              <span class="interruptSpinner" aria-hidden="true" />
            </button>
            <button v-else class="sendIcon"
              :disabled="(!input.trim() && pendingImages.length === 0) || recording || transcribing" type="button"
              title="发送" @click="send">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd"
                  d="M10 3a.75.75 0 0 1 .53.22l4.5 4.5a.75.75 0 1 1-1.06 1.06l-3.22-3.22V16a.75.75 0 0 1-1.5 0V5.56L6.03 8.78A.75.75 0 1 1 4.97 7.72l4.5-4.5A.75.75 0 0 1 10 3Z"
                  clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
        <div v-if="(voiceStatusKind === 'ok' || voiceStatusKind === 'error') && voiceStatusMessage" class="voiceToast"
          :class="voiceStatusKind" role="status" aria-live="polite">
          <svg v-if="voiceStatusKind === 'ok'" class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor"
            aria-hidden="true">
            <path fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.53-9.47a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L6.47 11.1a.75.75 0 1 1 1.06-1.06l1.72 1.72 3.22-3.22a.75.75 0 0 1 1.06 0Z"
              clip-rule="evenodd" />
          </svg>
          <svg v-else class="voiceToastIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5Zm-1.5 7.5a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 0 1.5H10a.75.75 0 0 1-.75-.75Z"
              clip-rule="evenodd" />
          </svg>
          <span class="voiceToastText">{{ voiceStatusMessage }}</span>
        </div>
      </div>
    </div>

    <DraggableModal v-if="pendingImageViewerOpen" card-variant="large" @close="closePendingImageViewer">
      <div class="attachmentsViewer">
        <div class="attachmentsViewerHeader" data-drag-handle>
          <div class="attachmentsViewerTitle">附件预览</div>
          <button class="attachmentsViewerClose" type="button" @click="closePendingImageViewer">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd"
                d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                clip-rule="evenodd" />
            </svg>
          </button>
        </div>
        <div class="attachmentsViewerBody">
          <div class="attachmentsViewerImages">
            <template v-for="img in pendingImagePreviews" :key="img.key">
              <img v-if="img.src" class="attachmentsViewerImg" :src="img.src" alt="" />
            </template>
          </div>
        </div>
      </div>
    </DraggableModal>
  </div>
</template>

<style src="./MainChat.css" scoped></style>
