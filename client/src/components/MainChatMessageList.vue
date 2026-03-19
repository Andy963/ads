<script setup lang="ts">
import { computed, ref, watch } from "vue";

import MarkdownContent from "./MarkdownContent.vue";
import type { ChatMessage, RenderMessage } from "./mainChat/types";

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
}>();

const emit = defineEmits<{
  (e: "copyMessage", message: RenderMessage): void;
  (e: "toggleLiveStepExpanded"): void;
}>();

const openCommandTrees = ref<Set<string>>(new Set());
const expandedPatchIds = ref<Set<string>>(new Set());

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

  return props.messages.filter((m) => m.kind !== "command" && (m.kind !== "execute" || m.id === latestExecuteId));
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

function shouldShowMsgActions(m: RenderMessage): boolean {
  if (m.streaming && m.content.length === 0) return false;
  if (m.kind === "patch") return false;
  return true;
}

function shouldUseCompactBubble(m: RenderMessage): boolean {
  return !shouldShowMsgActions(m);
}
</script>

<template>
  <div class="messageList">
    <div v-if="messages.length === 0" class="chat-empty">
      <span>直接开始对话…</span>
    </div>
    <div v-for="m in renderMessages" :key="m.id" class="msg" :data-id="m.id" :data-role="m.role" :data-kind="m.kind">
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
          <span class="prompt-tag">Executes</span>
          <span class="command-count">
            {{ getCommandTreeTotalCount(m) }} 条命令<span v-if="hasCommandTreeOverflow(m)"> (showing last {{ getCommandTreeShownCount(m) }})</span>
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
      <div
        v-else
        :class="[
          'bubble',
          {
            'bubble--compact': shouldUseCompactBubble(m),
          },
        ]"
      >
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
            <MarkdownContent :content="m.content" />
            <div v-if="!liveStepExpanded && liveStepOutlineItems.length > 0" class="liveStepOutline" aria-hidden="true">
              <div v-for="(title, idx) in liveStepOutlineItems" :key="idx" class="liveStepOutlineItem" :title="title">
                <span class="liveStepOutlineBullet" aria-hidden="true">•</span>
                <span class="liveStepOutlineText">{{ title }}</span>
              </div>
              <div v-if="liveStepOutlineHiddenCount > 0" class="liveStepOutlineMore">+{{ liveStepOutlineHiddenCount }} more</div>
            </div>
          </div>
          <div v-if="liveStepCanToggleExpanded" class="liveStepToggleRow">
            <button class="liveStepToggleBtn" type="button" :aria-expanded="liveStepExpanded" @click.stop="emit('toggleLiveStepExpanded')">
              {{ liveStepExpanded ? "Collapse" : "Expand" }}
            </button>
          </div>
        </div>
        <MarkdownContent v-else :content="m.content" />
        <div v-if="shouldShowMsgActions(m)" class="msgActions">
          <button class="msgCopyBtn" type="button" aria-label="Copy message" @click="emit('copyMessage', m)">
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
  margin-bottom: 10px;
  max-width: 100%;
  overflow: visible;
  justify-content: flex-start;
}

.command-block {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  border-radius: 12px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  background: var(--surface);
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
  flex: 0 0 auto;
}

.execute-more {
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
  flex: 0 0 auto;
}

.patchCard {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  background: rgba(255, 255, 255, 0.78);
  color: #0f172a;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  cursor: pointer;
}

.patchCardToggle:hover {
  background: rgba(255, 255, 255, 0.96);
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
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(15, 23, 42, 0.03);
  color: #0f172a;
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
  border-radius: 12px;
  padding: 12px 14px 22px 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  position: relative;
  overflow: hidden;
}

.bubble--compact {
  padding: 12px 14px;
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
  background: rgba(37, 99, 235, 0.08);
  border-color: rgba(37, 99, 235, 0.25);
}

.msg[data-role="system"] .bubble {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(148, 163, 184, 0.35);
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
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0), var(--surface));
  pointer-events: none;
}

.msg[data-id="live-step"] .liveStepToggleRow {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

.msg[data-id="live-step"] .liveStepToggleBtn {
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.03);
  color: rgba(15, 23, 42, 0.82);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  cursor: pointer;
}

.msg[data-id="live-step"] .liveStepToggleBtn:hover {
  background: rgba(15, 23, 42, 0.06);
  color: rgba(15, 23, 42, 0.92);
}

.msg[data-kind="command"] .bubble {
  background: white;
  border-color: rgba(226, 232, 240, 0.9);
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
</style>
