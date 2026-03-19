<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MarkdownContent from "./MarkdownContent.vue";
import MainChatComposerPanel from "./MainChatComposerPanel.vue";
import MainChatHeader from "./MainChatHeader.vue";

import type { ChatMessage, IncomingImage, QueuedPrompt, RenderMessage } from "./mainChat/types";
import { useCopyMessage } from "./mainChat/useCopyMessage";
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
const expandedPatchIds = ref<Set<string>>(new Set());

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

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPatchStatHtml(added: number | null | undefined, removed: number | null | undefined): string {
  if (typeof added !== "number" || typeof removed !== "number") {
    return `<span class="patchCardStatBinary">(binary)</span>`;
  }
  return (
    `<span class="patchCardStat">(` +
    `<span class="patchCardStatAdd">+${added}</span> ` +
    `<span class="patchCardStatDel">-${removed}</span>` +
    `)</span>`
  );
}

function patchHeaderTitle(m: RenderMessage): string {
  const files = Array.isArray(m.patch?.files) ? m.patch?.files : [];
  const first = files[0];
  if (!first?.path) return "补丁";
  return first.path;
}

function patchHeaderMeta(m: RenderMessage): string {
  const files = Array.isArray(m.patch?.files) ? m.patch?.files : [];
  const first = files[0];
  const hiddenCount = Math.max(0, files.length - 1);
  const parts: string[] = [];
  if (first) parts.push(formatPatchStatHtml(first.added, first.removed));
  if (hiddenCount > 0) parts.push(`<span class="patchCardMetaExtra">${escapeHtml(`另 ${hiddenCount} 个文件`)}</span>`);
  return parts.join(" ");
}

function patchDiffLineKind(line: string): "add" | "del" | "meta" | "hunk" | "ctx" {
  if (!line) return "ctx";
  if (line.startsWith("diff --git ")) return "meta";
  if (line.startsWith("index ")) return "meta";
  if (line.startsWith("new file mode ")) return "meta";
  if (line.startsWith("deleted file mode ")) return "meta";
  if (line.startsWith("similarity index ")) return "meta";
  if (line.startsWith("rename from ")) return "meta";
  if (line.startsWith("rename to ")) return "meta";
  if (line.startsWith("Binary files ")) return "meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function renderPatchDiffHtml(raw: unknown): string {
  const text = String(raw ?? "");
  if (!text) return "";

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return lines
    .map((line) => {
      const kind = patchDiffLineKind(line);
      return `<span class="patchCardDiffLine patchCardDiffLine--${kind}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
}

function isPatchExpanded(id: string): boolean {
  return expandedPatchIds.value.has(id);
}

function togglePatchExpanded(id: string): void {
  const next = new Set(expandedPatchIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedPatchIds.value = next;
}

watch(
  () =>
    props.messages
      .filter((m) => m.kind === "patch")
      .map((m) => String(m.id ?? "").trim())
      .filter(Boolean),
  (ids) => {
    const visibleIds = new Set(ids);
    const next = new Set([...expandedPatchIds.value].filter((id) => visibleIds.has(id)));
    if (next.size !== expandedPatchIds.value.size) {
      expandedPatchIds.value = next;
    }
  },
  { immediate: true },
);

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
const showActiveBorder = computed(() => props.busy);

const { copiedMessageId, onCopyMessage, formatMessageTs } = useCopyMessage();

function shouldShowMsgActions(m: RenderMessage): boolean {
  if (m.streaming && m.content.length === 0) return false;
  if (m.kind === "patch") return false;
  return true;
}

function shouldUseCompactBubble(m: RenderMessage): boolean {
  // Compact layout when we don't render footer actions.
  return !shouldShowMsgActions(m);
}

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
    <MainChatHeader
      v-if="title"
      :title="title"
      :busy="busy"
      :header-action="headerAction"
      :header-resume-action="headerResumeAction"
      @new-session="emit('newSession')"
      @resume-thread="emit('resumeThread')"
    />
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
        <div v-else-if="m.kind === 'patch'" :class="['bubble', 'bubble--compact', 'patchCard']">
          <div class="patchCardHeader">
            <div class="patchCardSummary">
              <div class="patchCardTitle" :title="patchHeaderTitle(m)">{{ patchHeaderTitle(m) }}</div>
              <div v-if="patchHeaderMeta(m)" class="patchCardMeta" v-html="patchHeaderMeta(m)"></div>
            </div>
            <button
              class="patchCardToggle"
              type="button"
              :aria-expanded="isPatchExpanded(m.id)"
              :data-testid="`patch-toggle-${m.id}`"
              @click.stop="togglePatchExpanded(m.id)"
            >
              {{ isPatchExpanded(m.id) ? "收起" : "展开" }}
            </button>
          </div>
          <div v-if="isPatchExpanded(m.id)" class="patchCardBody">
            <pre class="patchCardDiff" v-html="renderPatchDiffHtml(m.patch?.diff || m.content)"></pre>
            <div v-if="m.patch?.truncated" class="patchCardNote">Diff 已截断，避免刷屏。</div>
          </div>
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

    <MainChatComposerPanel
      v-if="!readOnly"
      :queued-prompts="queuedPrompts"
      :pending-images="pendingImages"
      :connected="connected"
      :busy="busy"
      :agents="agents"
      :active-agent-id="activeAgentId"
      :models="models"
      :model-id="modelId"
      :model-reasoning-effort="modelReasoningEffort"
      :agent-delegations="agentDelegations"
      :api-token="apiToken"
      @send="emit('send', $event)"
      @interrupt="emit('interrupt')"
      @add-images="emit('addImages', $event)"
      @clear-images="emit('clearImages')"
      @remove-queued="emit('removeQueued', $event)"
      @switch-agent="emit('switchAgent', $event)"
      @set-model="emit('setModel', $event)"
      @set-reasoning-effort="emit('setReasoningEffort', $event)"
    />
  </div>
</template>

<style src="./MainChat.css" scoped></style>
