<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import MarkdownContent from "./MarkdownContent.vue";
import ChatFilePreviewModal from "./ChatFilePreviewModal.vue";
import type { ChatMessage, RenderMessage } from "./mainChat/types";
import type { ChatItem } from "../app/controllerTypes";
import { PATCH_DIFF_FALLBACK_KEY, splitUnifiedDiffByPath } from "../lib/patchDiff";
import { normalizeTurnSemanticOrder } from "../lib/chat_sync";
import type { MarkdownFilePreviewLink } from "../lib/markdown";

const LIVE_STEP_MESSAGE_ID = "live-step";

const props = defineProps<{
  messages: ChatMessage[];
  copiedMessageId: string | null;
  formatMessageTs: (ts: number) => string;
  liveStepExpanded: boolean;
  liveStepHasOverflow: boolean;
  liveStepCanToggleExpanded: boolean;
  liveStepOutlineItems: string[];
  liveStepOutlineHiddenCount: number;
  liveStepCollapsedTrivialOutline: boolean;
  workspaceRoot?: string | null;
}>();

const emit = defineEmits<{
  (e: "copyMessage", message: RenderMessage): void;
  (e: "toggleLiveStepExpanded"): void;
}>();

const openCommandTrees = ref<Set<string>>(new Set());
const expandedExecuteIds = ref<Set<string>>(new Set());
const expandedPatchKeys = ref<Set<string>>(new Set());
const filePreviewTarget = ref<MarkdownFilePreviewLink | null>(null);
const messageListEl = ref<HTMLElement | null>(null);
const earlierMessagesSentinel = ref<HTMLElement | null>(null);
const windowStart = ref(0);
const windowEnd = ref(0);
const loadingEarlierMessages = ref(false);

const INITIAL_MESSAGE_WINDOW = 30;
const EARLIER_MESSAGE_PAGE_SIZE = 20;
const CHAT_BOTTOM_THRESHOLD_PX = 80;

let messageScrollRoot: HTMLElement | null = null;
let earlierMessagesObserver: IntersectionObserver | null = null;

type PatchRenderRow = {
  key: string;
  path: string;
  added: number | null;
  removed: number | null;
  diff: string;
};

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

function patchRowTitle(row: PatchRenderRow): string {
  const title = String(row.path ?? "").trim();
  return title || "补丁";
}

function patchRowMeta(row: PatchRenderRow): string {
  const parts: string[] = [];
  parts.push(formatPatchStatHtml(row.added, row.removed));
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

function patchExpandKey(messageId: string, rowKey: string): string {
  return `${messageId}::${rowKey}`;
}

function buildPatchRows(m: RenderMessage): PatchRenderRow[] {
  const files = Array.isArray(m.patch?.files) ? m.patch.files : [];
  const diff = String(m.patch?.diff ?? m.content ?? "").trimEnd();
  const diffByPath = splitUnifiedDiffByPath(diff);
  const fallbackDiff = diffByPath.get(PATCH_DIFF_FALLBACK_KEY) ?? "";
  const rows: PatchRenderRow[] = [];
  const seen = new Set<string>();
  let fallbackUsed = false;

  for (const file of files) {
    const filePath = String(file?.path ?? "").trim();
    if (!filePath) continue;
    const rowDiff = diffByPath.get(filePath) ?? (!fallbackUsed && files.length === 1 ? fallbackDiff : "");
    if (rowDiff === fallbackDiff && rowDiff) fallbackUsed = true;
    rows.push({
      key: filePath,
      path: filePath,
      added: file?.added ?? null,
      removed: file?.removed ?? null,
      diff: rowDiff,
    });
    seen.add(filePath);
  }

  for (const [path, section] of diffByPath.entries()) {
    if (path === PATCH_DIFF_FALLBACK_KEY || seen.has(path) || !section.trim()) continue;
    rows.push({
      key: path,
      path,
      added: null,
      removed: null,
      diff: section,
    });
    seen.add(path);
  }

  if (!rows.length && fallbackDiff) {
    rows.push({
      key: PATCH_DIFF_FALLBACK_KEY,
      path: "补丁",
      added: null,
      removed: null,
      diff: fallbackDiff,
    });
    fallbackUsed = true;
  }

  if (!fallbackUsed && fallbackDiff) {
    rows.push({
      key: `${PATCH_DIFF_FALLBACK_KEY}:extra`,
      path: "补丁",
      added: null,
      removed: null,
      diff: fallbackDiff,
    });
  }

  return rows;
}

function isPatchExpanded(messageId: string, rowKey: string): boolean {
  return expandedPatchKeys.value.has(patchExpandKey(messageId, rowKey));
}

function togglePatchExpanded(messageId: string, rowKey: string): void {
  const key = patchExpandKey(messageId, rowKey);
  const next = new Set(expandedPatchKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedPatchKeys.value = next;
}

const renderMessages = computed<RenderMessage[]>(() => {
  const rawOrdered = normalizeTurnSemanticOrder(props.messages as ChatItem[]) as ChatMessage[];
  const turns: ChatMessage[][] = [];
  let currentTurn: ChatMessage[] = [];
  for (const msg of rawOrdered) {
    if (msg.role === "user" && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  const processed: ChatMessage[] = [];
  for (const turn of turns) {
    const turnPatches = turn
      .filter((m) => (m.kind === "patch" && Boolean(m.patch || m.content)) || Boolean(m.patch))
      .map((m) => m.patch ?? (m.content ? { files: [], diff: m.content } : null))
      .filter(Boolean);

    let mergedPatch: ChatMessage["patch"] | undefined;
    if (turnPatches.length > 0) {
      const allFiles = turnPatches.flatMap((p) => p?.files ?? []);
      const allDiffs = turnPatches.map((p) => p?.diff ?? "").filter(Boolean).join("\n\n");
      const truncated = turnPatches.some((p) => p?.truncated);
      if (allFiles.length > 0 || allDiffs.trim()) {
        mergedPatch = {
          files: allFiles,
          diff: allDiffs,
          truncated: truncated || undefined,
        };
      }
    }

    const visibleTurn: ChatMessage[] = [];
    for (const msg of turn) {
      if (msg.kind === "thought" || msg.kind === "plan" || msg.kind === "patch" || msg.kind === "command") {
        continue;
      }
      visibleTurn.push({ ...msg });
    }

    if (mergedPatch) {
      // A patch is supplementary metadata, never a standalone message. Only
      // fold it into a substantive assistant explanation; creating an empty
      // bubble would make a patch look like an unsolicited response.
      const target = [...visibleTurn]
        .reverse()
        .find((m) => m.role === "assistant" && m.kind === "text" && String(m.content ?? "").trim());
      if (target) {
        target.patch = mergedPatch;
      }
    }

    processed.push(...visibleTurn);
  }
  return processed;
});

const hasEarlierMessages = computed(() => windowStart.value > 0);

const windowedMessages = computed<RenderMessage[]>(() => {
  const end = Math.min(windowEnd.value || renderMessages.value.length, renderMessages.value.length);
  const start = Math.min(windowStart.value, end);
  return renderMessages.value.slice(start, end);
});

function sameMessageIds(left: RenderMessage[] | undefined, right: RenderMessage[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((message, index) => message.id === right[index]?.id);
}

function resolveMessageScrollRoot(): HTMLElement | null {
  const list = messageListEl.value;
  if (!list) return null;
  return (list.closest(".chat") as HTMLElement | null) ?? list.parentElement;
}

function isMessageScrollRootNearBottom(): boolean {
  const root = messageScrollRoot ?? resolveMessageScrollRoot();
  if (!root) return true;
  const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
  return root.scrollHeight <= root.clientHeight || distance <= CHAT_BOTTOM_THRESHOLD_PX;
}

function showLatestMessages(): void {
  const total = renderMessages.value.length;
  const nextStart = Math.max(0, total - INITIAL_MESSAGE_WINDOW);
  if (windowEnd.value === total && windowStart.value === nextStart) return;
  windowStart.value = nextStart;
  windowEnd.value = total;
}

defineExpose({ showLatestMessages });

function handleMessageScroll(): void {
  if (isMessageScrollRootNearBottom()) showLatestMessages();
}

async function loadEarlierMessages(): Promise<void> {
  if (loadingEarlierMessages.value || !hasEarlierMessages.value) return;

  const root = messageScrollRoot ?? resolveMessageScrollRoot();
  const previousScrollTop = root?.scrollTop ?? 0;
  const previousScrollHeight = root?.scrollHeight ?? 0;
  const nextStart = Math.max(0, windowStart.value - EARLIER_MESSAGE_PAGE_SIZE);

  loadingEarlierMessages.value = true;
  windowStart.value = nextStart;
  try {
    await nextTick();
    if (root) {
      root.scrollTop = previousScrollTop + (root.scrollHeight - previousScrollHeight);
    }
  } finally {
    loadingEarlierMessages.value = false;
  }
}

function observeEarlierMessagesSentinel(): void {
  earlierMessagesObserver?.disconnect();
  earlierMessagesObserver = null;

  const sentinel = earlierMessagesSentinel.value;
  if (!sentinel || typeof IntersectionObserver === "undefined") return;

  earlierMessagesObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadEarlierMessages();
    },
    {
      root: messageScrollRoot,
      rootMargin: "240px 0px 0px 0px",
    },
  );
  earlierMessagesObserver.observe(sentinel);
}

watch(
  renderMessages,
  (next, previous) => {
    if (!previous || previous.length === 0 || next.length === 0) {
      windowStart.value = Math.max(0, next.length - INITIAL_MESSAGE_WINDOW);
      windowEnd.value = next.length;
      return;
    }

    if (sameMessageIds(previous, next)) return;

    const isTailAppend =
      next.length >= previous.length &&
      previous.every((message, index) => message.id === next[index]?.id);
    if (isTailAppend) {
      if (isMessageScrollRootNearBottom()) {
        showLatestMessages();
      } else {
        windowEnd.value = Math.min(windowEnd.value || previous.length, previous.length);
      }
      return;
    }

    if (isMessageScrollRootNearBottom()) {
      showLatestMessages();
      return;
    }

    const currentStartId = previous[windowStart.value]?.id;
    const preservedStart = currentStartId ? next.findIndex((message) => message.id === currentStartId) : -1;
    if (preservedStart >= 0) {
      const visibleCount = Math.max(0, (windowEnd.value || previous.length) - windowStart.value);
      windowStart.value = preservedStart;
      windowEnd.value = Math.min(next.length, preservedStart + visibleCount);
      return;
    }

    windowStart.value = Math.max(0, next.length - INITIAL_MESSAGE_WINDOW);
    windowEnd.value = next.length;
  },
  { immediate: true },
);

watch(windowStart, () => {
  void nextTick().then(observeEarlierMessagesSentinel);
});

onMounted(() => {
  messageScrollRoot = resolveMessageScrollRoot();
  messageScrollRoot?.addEventListener("scroll", handleMessageScroll, { passive: true });
  observeEarlierMessagesSentinel();
});

onBeforeUnmount(() => {
  earlierMessagesObserver?.disconnect();
  earlierMessagesObserver = null;
  messageScrollRoot?.removeEventListener("scroll", handleMessageScroll);
  messageScrollRoot = null;
});

watch(
  () =>
    renderMessages.value
      .filter((m) => Boolean(m.patch))
      .flatMap((m) =>
        buildPatchRows(m as RenderMessage)
          .map((row) => patchExpandKey(String(m.id ?? "").trim(), row.key))
          .filter(Boolean),
      )
      .filter(Boolean),
  (keys) => {
    const visibleKeys = new Set(keys);
    const next = new Set([...expandedPatchKeys.value].filter((key) => visibleKeys.has(key)));
    if (next.size !== expandedPatchKeys.value.size) {
      expandedPatchKeys.value = next;
    }
  },
  { immediate: true },
);

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

function executeRawContent(m: RenderMessage): string {
  const full = String(m.fullContent ?? "").trimEnd();
  if (full) return full;
  return String(m.content ?? "").trimEnd();
}

function executeAllLines(m: RenderMessage): string[] {
  const raw = executeRawContent(m);
  if (!raw) return [];
  return raw.replace(/\r\n/g, "\n").split("\n");
}

function hasExpandableExecuteOutput(m: RenderMessage): boolean {
  if (m.kind !== "execute") return false;
  const lines = executeAllLines(m);
  return lines.length > 3 || (m.hiddenLineCount !== undefined && m.hiddenLineCount > 0);
}

function isExecuteExpanded(id: string): boolean {
  return expandedExecuteIds.value.has(id);
}

function getExecuteOutput(m: RenderMessage): string {
  const lines = executeAllLines(m);
  if (lines.length === 0) return "";
  if (isExecuteExpanded(m.id)) {
    return lines.join("\n");
  }
  return lines.slice(0, 3).join("\n");
}

function getExecuteHiddenCount(m: RenderMessage): number {
  const lines = executeAllLines(m);
  const localHidden = Math.max(0, lines.length - 3);
  if (m.hiddenLineCount && !m.fullContent) {
    return localHidden + m.hiddenLineCount;
  }
  return localHidden;
}

function toggleExecuteExpanded(id: string): void {
  const next = new Set(expandedExecuteIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedExecuteIds.value = next;
}

function caretPath(open: boolean): string {
  return open ? "M6 8l4 4 4-4" : "M8 6l4 4-4 4";
}

function shouldShowMsgActions(m: RenderMessage): boolean {
  if (m.streaming && m.content.length === 0) return false;
  if (m.kind === "patch" || m.kind === "thought" || m.kind === "divider") return false;
  return true;
}

function shouldUseCompactBubble(m: RenderMessage): boolean {
  return !shouldShowMsgActions(m);
}

function openFilePreview(payload: MarkdownFilePreviewLink): void {
  if (!String(props.workspaceRoot ?? "").trim()) return;
  filePreviewTarget.value = payload;
}

function closeFilePreview(): void {
  filePreviewTarget.value = null;
}

</script>

<template>
  <div
    ref="messageListEl"
    class="messageList"
    :data-total-messages="renderMessages.length"
    :data-window-start="windowStart"
    :data-window-end="windowEnd"
  >
    <div v-if="messages.length === 0" class="chat-empty">
      <span>直接开始对话…</span>
    </div>
    <div
      v-if="hasEarlierMessages"
      ref="earlierMessagesSentinel"
      class="messageHistorySentinel"
      data-testid="load-earlier-sentinel"
      aria-hidden="true"
    ></div>
    <button
      v-if="hasEarlierMessages"
      class="loadEarlierMessages"
      type="button"
      data-testid="load-earlier-messages"
      :disabled="loadingEarlierMessages"
      @click="loadEarlierMessages"
    >
      {{ loadingEarlierMessages ? "正在加载…" : "加载更早消息" }}
    </button>
    <div v-for="m in windowedMessages" :key="m.id" class="msg" :data-id="m.id" :data-role="m.role" :data-kind="m.kind">
      <div v-if="m.kind === 'command'" class="command-block">
        <button
          class="command-tree-header"
          type="button"
          aria-label="Toggle commands"
          :aria-expanded="isCommandTreeOpen(m.id, getCommandTreeCommands(m).length)"
          @click="toggleCommandTree(m.id)"
        >
          <span v-if="getCommandTreeCommands(m).length > 0" class="command-caret" aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="caretPath(isCommandTreeOpen(m.id, getCommandTreeCommands(m).length))" />
            </svg>
          </span>
          <span class="prompt-tag">执行</span>
          <span class="command-count">
            {{ getCommandTreeTotalCount(m) }} 条命令<span v-if="hasCommandTreeOverflow(m)">（显示最近 {{ getCommandTreeShownCount(m) }} 条）</span>
          </span>
        </button>
        <div v-if="isCommandTreeOpen(m.id, getCommandTreeCommands(m).length)" class="command-tree">
          <div v-for="(cmd, cIdx) in getCommandTreeCommands(m)" :key="cIdx" class="command-tree-item">
            <span class="command-tree-branch">├─</span>
            <span class="command-cmd">{{ cmd }}</span>
          </div>
        </div>
      </div>
      <div v-else-if="m.kind === 'execute'" :class="['bubble', 'bubble--compact', 'execute-block', { 'execute-block--running': m.streaming }]">
        <div class="execute-header">
          <div class="execute-left">
            <span class="prompt-tag">&gt;_</span>
            <span class="execute-cmd" :title="m.command || ''">{{ m.command || "" }}</span>
            <span v-if="m.streaming" class="executeSpinner" aria-label="Running..."></span>
          </div>
          <div class="execute-actions">
            <button class="msgCopyBtn executeCopyBtn" type="button" aria-label="复制命令输出" @click="emit('copyMessage', m)">
              <svg
                v-if="copiedMessageId === m.id"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <svg
                v-else
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        </div>
        <pre
          v-if="getExecuteOutput(m).trim()"
          :class="['execute-output', { 'execute-output--expanded': isExecuteExpanded(m.id) }]"
        >{{ getExecuteOutput(m) }}</pre>
        <button
          v-if="hasExpandableExecuteOutput(m)"
          class="execute-more execute-more--button"
          type="button"
          :aria-expanded="isExecuteExpanded(m.id)"
          @click="toggleExecuteExpanded(m.id)"
        >
          {{ isExecuteExpanded(m.id) ? "收起输出" : `… 还有 ${getExecuteHiddenCount(m)} 行` }}
        </button>
      </div>
      <div v-else-if="m.kind === 'divider'" class="sessionBoundaryDivider" data-testid="session-boundary-divider">
        <div class="sessionBoundaryLine">
          <span class="sessionBoundaryTag">⚡ New Session Initialized</span>
        </div>
        <div class="sessionBoundaryNotice">
          {{ m.content || "Previous messages above are retained for review only and are NOT injected into model prompt context." }}
        </div>
      </div>
      <div
        v-else
        :class="[
          'bubble',
          {
            'bubble--compact': shouldUseCompactBubble(m),
            'bubble--retryNotice': m.kind === 'error' && (m.retryCount ?? 0) > 0,
          },
        ]"
      >
        <span v-if="m.kind === 'error' && (m.retryCount ?? 0) > 0" class="retryBadge">x{{ m.retryCount }}</span>
        <div v-if="m.role === 'assistant' && m.kind === 'text' && m.streaming && m.content.length === 0" class="typing" aria-label="AI is thinking">
          <span class="thinkingText">thinking</span>
        </div>
        <div v-else-if="isLiveStepRenderMessage(m)" class="liveStep">
          <div
            class="liveStepBody"
            :data-expanded="String(liveStepExpanded)"
            :data-outline-only="String(!liveStepExpanded && liveStepOutlineItems.length > 0)"
            :data-trivial-outline="String(liveStepCollapsedTrivialOutline)"
            :class="{ 'liveStepBody--clamped': liveStepHasOverflow && !liveStepExpanded && liveStepCanToggleExpanded }"
          >
            <MarkdownContent :content="m.content" :enable-file-preview="Boolean(workspaceRoot)" @open-file-preview="openFilePreview" />
            <div v-if="!liveStepExpanded && liveStepOutlineItems.length > 0" class="liveStepOutline" aria-hidden="true">
              <div v-for="(title, idx) in liveStepOutlineItems" :key="idx" class="liveStepOutlineItem" :title="title">
                <span class="liveStepOutlineBullet" aria-hidden="true">•</span>
                <span class="liveStepOutlineText">{{ title }}</span>
              </div>
              <div v-if="liveStepOutlineHiddenCount > 0" class="liveStepOutlineMore">+{{ liveStepOutlineHiddenCount }} 条</div>
            </div>
          </div>
          <div v-if="liveStepCanToggleExpanded" class="liveStepToggleRow">
            <button class="liveStepToggleBtn" type="button" :aria-expanded="liveStepExpanded" @click.stop="emit('toggleLiveStepExpanded')">
              {{ liveStepExpanded ? "收起" : "展开" }}
            </button>
          </div>
        </div>
        <div v-else>
          <MarkdownContent :content="m.content" :enable-file-preview="Boolean(workspaceRoot)" @open-file-preview="openFilePreview" />
          <div v-if="m.patch && buildPatchRows(m).length > 0" class="patchCard foldedPatch">
            <div v-for="(row, rowIdx) in buildPatchRows(m)" :key="row.key" class="patchCardRow">
              <div class="patchCardHeader">
                <div class="patchCardSummary">
                  <div class="patchCardTitle" :title="patchRowTitle(row)">{{ patchRowTitle(row) }}</div>
                  <div v-if="patchRowMeta(row)" class="patchCardMeta" v-html="patchRowMeta(row)"></div>
                </div>
                <button
                  v-if="row.diff"
                  class="patchCardToggle"
                  type="button"
                  :aria-expanded="isPatchExpanded(m.id, row.key)"
                  :data-testid="`patch-toggle-${m.id}-${rowIdx}`"
                  @click.stop="togglePatchExpanded(m.id, row.key)"
                >
                  {{ isPatchExpanded(m.id, row.key) ? "收起" : "展开" }}
                </button>
              </div>
              <div v-if="row.diff && isPatchExpanded(m.id, row.key)" class="patchCardBody">
                <pre class="patchCardDiff" v-html="renderPatchDiffHtml(row.diff)"></pre>
              </div>
            </div>
            <div v-if="m.patch?.truncated" class="patchCardNote">Diff 已截断，避免刷屏。</div>
          </div>
        </div>
        <div v-if="shouldShowMsgActions(m)" class="msgActions">
          <button class="msgCopyBtn" type="button" aria-label="复制消息" @click="emit('copyMessage', m)">
            <svg
              v-if="copiedMessageId === m.id"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <svg
              v-else
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <span v-if="m.ts" class="msgTime">{{ formatMessageTs(m.ts) }}</span>
        </div>
      </div>
    </div>
    <ChatFilePreviewModal :workspace-root="workspaceRoot" :target="filePreviewTarget" @close="closeFilePreview" />
  </div>
</template>

<style scoped>
.chat-empty {
  padding: 18px;
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
}

.msg {
  display: flex;
  margin-bottom: 18px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow: visible;
  justify-content: flex-start;
  content-visibility: auto;
  contain-intrinsic-size: auto 150px;
}

.msg[data-role="user"] {
  justify-content: flex-end;
}

.messageHistorySentinel {
  width: 100%;
  height: 1px;
  pointer-events: none;
}

.loadEarlierMessages {
  display: block;
  margin: 0 auto 10px;
  padding: 5px 12px;
  border: 1px solid var(--github-border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: var(--github-muted);
  cursor: pointer;
  font-size: 12px;
}

.loadEarlierMessages:hover:not(:disabled) {
  color: var(--github-text);
  background: #ffffff;
}

.loadEarlierMessages:disabled {
  cursor: wait;
  opacity: 0.7;
}

.command-block {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  border-radius: 12px;
  padding: 8px 14px;
  border: 1px solid var(--github-border);
  background: rgba(255, 255, 255, 0.96);
}

.execute-block {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  display: flex;
  flex-direction: column;
}

.execute-header {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 0;
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
  justify-content: flex-start;
  text-align: left;
}

.execute-left {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.execute-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
}

.executeCopyBtn {
  width: 24px;
  height: 24px;
}

.execute-cmd {
  color: #0f172a;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.execute-output {
  margin: 4px 0 0 0;
  font-size: 12px;
  line-height: 1.35;
  color: #0f172a;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  max-height: calc(1.35em * 3 + 2px);
  flex: 0 0 auto;
}

.execute-output--expanded {
  display: block;
  -webkit-line-clamp: unset;
  max-height: 300px;
  overflow: auto;
}

.execute-more {
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
  flex: 0 0 auto;
}

.execute-more--button {
  align-self: flex-start;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.execute-more--button:hover {
  color: #0f172a;
}

.patchCard {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.patchCardRow {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.patchCardRow + .patchCardRow {
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.patchCardHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.patchCardSummary {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.patchCardTitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  font-weight: 800;
  color: #0f172a;
}

.patchCardMeta {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
}

.patchCardMeta :deep(.patchCardStatAdd) {
  color: #16a34a;
  font-weight: 800;
}

.patchCardMeta :deep(.patchCardStatDel) {
  color: #b91c1c;
  font-weight: 800;
}

.patchCardMeta :deep(.patchCardStatBinary) {
  color: #64748b;
  font-weight: 700;
}

.patchCardMetaExtra {
  color: #64748b;
}

.patchCardToggle {
  flex: 0 0 auto;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(255, 255, 255, 0.92);
  color: #0f172a;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  cursor: pointer;
}

.patchCardToggle:hover {
  background: #ffffff;
}

.patchCardBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.patchCardDiff {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--github-border);
  background: var(--github-code-bg);
  color: var(--github-text);
  font-size: 12px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow: auto;
  white-space: pre;
}

.patchCardDiff :deep(.patchCardDiffLine--add) {
  color: #15803d;
}

.patchCardDiff :deep(.patchCardDiffLine--del) {
  color: #b91c1c;
}

.patchCardDiff :deep(.patchCardDiffLine--meta) {
  color: #64748b;
}

.patchCardDiff :deep(.patchCardDiffLine--hunk) {
  color: #7c3aed;
}

.patchCardNote {
  font-size: 12px;
  color: #64748b;
}

.foldedPatch {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}

.command-tree-header {
  width: 100%;
  padding: 4px 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

.command-caret {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: inherit;
  padding: 0;
}

.command-tree-header:hover .command-caret {
  color: #0f172a;
}

.prompt-tag {
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-transform: none;
}

.command-count {
  color: #94a3b8;
  font-size: 12px;
  margin-left: 0;
}

.command-tree {
  padding-left: 8px;
}

.command-tree-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0;
  max-width: 100%;
  overflow: hidden;
}

.command-tree-branch {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  user-select: none;
  flex-shrink: 0;
}

.command-cmd {
  color: #64748b;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 0;
}

.bubble {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border-radius: 0;
  padding: 4px 16px 22px;
  border: none;
  background: transparent;
  box-shadow: none;
  position: relative;
  overflow: visible;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.bubble--compact {
  padding: 0;
}

.bubble--retryNotice {
  padding-right: 52px;
}

.retryBadge {
  position: absolute;
  top: 8px;
  right: 10px;
  min-width: 28px;
  height: 20px;
  padding: 0 7px;
  box-sizing: border-box;
  border-radius: 999px;
  background: rgba(251, 146, 60, 0.16);
  border: 1px solid rgba(251, 146, 60, 0.42);
  color: #9a3412;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
}

.msgActions {
  position: absolute;
  left: 10px;
  bottom: -4px;
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
  width: 30px;
  height: 30px;
  padding: 2px;
  box-sizing: border-box;
  border: none;
  background: transparent;
  color: #64748b;
  border-radius: 0;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.msgCopyBtn:hover {
  color: #0f172a;
}

.msgTime {
  font-size: 11px;
  line-height: 1;
  padding: 2px;
  color: #94a3b8;
  white-space: nowrap;
  user-select: none;
}

.msg[data-role="user"] .bubble {
  width: auto;
  max-width: min(90%, 960px);
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 16px;
  border: none;
  border-radius: 18px 18px 4px 18px;
  background: #f4f4f5;
  color: #18181b;
  overflow: visible;
}

.msg[data-role="system"] .bubble {
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(208, 215, 222, 0.95);
  background: rgba(246, 248, 250, 0.96);
}

.msg[data-kind="error"] .bubble {
  padding: 10px 14px 22px;
  border: 1px solid rgba(251, 146, 60, 0.55);
  border-color: rgba(251, 146, 60, 0.55);
  border-radius: 12px;
  background: rgba(255, 247, 237, 0.96);
  color: #7c2d12;
}

.msg[data-kind="execute"] .bubble {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  background: #f8fafc;
  overflow: hidden;
}

.msg[data-role="user"] .msgActions {
  left: auto;
  right: 10px;
}

.thoughtCard {
  border-left: 3px solid #8b5cf6;
  background: rgba(248, 250, 252, 0.94);
}

.thoughtCardHeader {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  color: #475569;
}

.thoughtCardSummary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #64748b;
}

.thoughtCardToggleText {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent);
  font-weight: 500;
}

.thoughtCardBody {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--github-border);
  font-size: 13px;
  color: #334155;
}

.msg[data-id="live-step"] .liveStepBody {
  position: relative;
}

.msg[data-id="live-step"] .liveStepBody[data-outline-only="true"] :deep(.md) {
  visibility: hidden;
}

.msg[data-id="live-step"] .liveStepBody[data-trivial-outline="true"] :deep(.md) {
  min-height: 0;
  max-height: none;
}

.msg[data-id="live-step"] .liveStepOutline {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 2px;
  font-style: italic;
  pointer-events: none;
}

.msg[data-id="live-step"] .liveStepOutlineItem {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.msg[data-id="live-step"] .liveStepOutlineBullet {
  color: rgba(15, 23, 42, 0.55);
  flex: 0 0 auto;
}

.msg[data-id="live-step"] .liveStepOutlineText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(15, 23, 42, 0.82);
  font-weight: 700;
  min-width: 0;
}

.msg[data-id="live-step"] .liveStepOutlineMore {
  color: rgba(15, 23, 42, 0.6);
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.msg[data-id="live-step"] .liveStepBody :deep(.md) {
  font-style: italic;
  max-height: 4.8em;
  max-height: 3lh;
  min-height: 4.8em;
  min-height: 3lh;
  overflow: hidden;
  overscroll-behavior: contain;
}

.msg[data-id="live-step"] .liveStepBody[data-expanded="true"] :deep(.md) {
  max-height: none;
  min-height: 0;
  overflow: visible;
}

.msg[data-id="live-step"] .liveStepBody.liveStepBody--clamped::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.6em;
  background: linear-gradient(to bottom, rgba(246, 248, 250, 0), rgba(255, 255, 255, 0.96));
  pointer-events: none;
}

.msg[data-id="live-step"] .liveStepToggleRow {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

.msg[data-id="live-step"] .liveStepToggleBtn {
  border: 1px solid var(--github-border);
  background: rgba(246, 248, 250, 0.98);
  color: var(--github-muted);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  cursor: pointer;
}

.msg[data-id="live-step"] .liveStepToggleBtn:hover {
  background: rgba(234, 238, 242, 0.98);
  color: var(--github-text);
}

.msg[data-kind="command"] .bubble {
  background: rgba(255, 255, 255, 0.96);
  border-color: var(--github-border);
}

.typing {
  display: inline-flex;
  align-items: baseline;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1;
  color: #94a3b8;
}

.thinkingText {
  font-style: italic;
}

.thinkingText::after {
  content: "...";
  display: inline-block;
  overflow: hidden;
  vertical-align: bottom;
  width: 0;
  animation: thinkingDots 1.2s steps(4, end) infinite;
}

@keyframes thinkingDots {
  to {
    width: 1.35em;
  }
}

.msg[data-kind="divider"] {
  width: 100%;
  margin: 18px 0;
  display: flex;
  justify-content: center;
  align-items: center;
}

.sessionBoundaryDivider {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  user-select: none;
  padding: 2px 0;
}

.sessionBoundaryLine {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sessionBoundaryLine::before,
.sessionBoundaryLine::after {
  content: "";
  flex: 1;
  border-bottom: 1px dashed var(--border, #cbd5e1);
}

.sessionBoundaryTag {
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 9999px;
  margin: 0 12px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sessionBoundaryNotice {
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted, #64748b);
  text-align: center;
  max-width: 90%;
  word-break: break-word;
}

.thoughtSpinner {
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 1.5px solid rgba(139, 92, 246, 0.3);
  border-top-color: #8b5cf6;
  border-radius: 50%;
  animation: actionSpin 0.8s linear infinite;
  margin-left: 6px;
  vertical-align: middle;
}

.executeSpinner {
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 1.5px solid rgba(148, 163, 184, 0.4);
  border-top-color: var(--accent, #0969da);
  border-radius: 50%;
  animation: actionSpin 0.8s linear infinite;
  margin-left: 6px;
  vertical-align: middle;
}

@media (max-width: 768px) {
  .execute-cmd,
  .execute-output,
  .command-tree-branch,
  .command-cmd,
  .patchCardDiff {
    font-size: 14px;
  }

  .prompt-tag,
  .patchCardToggle,
  .retryBadge,
  .msgTime,
  .thoughtCardToggleText,
  .liveStepToggleBtn,
  .sessionBoundaryTag,
  .sessionBoundaryNotice {
    font-size: 12px;
  }
}

@keyframes actionSpin {
  to {
    transform: rotate(360deg);
  }
}
</style>
