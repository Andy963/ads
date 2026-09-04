import { clearLiveActivityWindow, renderLiveActivityMarkdown } from "../lib/live_activity";
import {
  findAssistantInsertIndex,
  findProcessInsertIndex,
  stripStreamingDisconnectNotice,
} from "../lib/chat_sync";

import type { ChatItem, ProjectRuntime } from "./controller";

const LIVE_ACTIVITY_TTL_MS = 3000;

function stripStreamingOverlap(current: string, incoming: string): string {
  if (!current || !incoming) return incoming;
  if (incoming === current) return "";
  if (incoming.startsWith(current)) return incoming.slice(current.length);
  return incoming;
}

function trimLiveStepSnapshot(text: string, maxLines: number, maxChars = 2500): string {
  const normalized = String(text ?? "");
  const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
  const lines = recent.split("\n");
  if (lines.length <= maxLines) return recent;
  return lines.slice(lines.length - maxLines).join("\n");
}

function isActionStepTrace(text: string): boolean {
  const firstLine = text.trim().split("\n")[0]!.toLowerCase();
  return (
    firstLine.startsWith("[tool]") ||
    firstLine.startsWith("[editing]") ||
    firstLine.startsWith("[command]") ||
    firstLine.startsWith("[boot]") ||
    firstLine.startsWith("[context]") ||
    firstLine.startsWith("[connection]")
  );
}

function getRenderedAssistantText(items: ChatItem[], isLiveMessageId: (id: string) => boolean): string {
  let lastUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  return items
    .slice(lastUserIndex + 1)
    .filter((item) => item.role === "assistant" && item.kind === "text" && !isLiveMessageId(item.id))
    .map((item) => stripStreamingDisconnectNotice(String(item.content ?? "")))
    .join("");
}

function getUnrenderedSnapshotText(
  items: ChatItem[],
  snapshot: string,
  isLiveMessageId: (id: string) => boolean,
): { text: string; matched: boolean } {
  const normalizedSnapshot = String(snapshot ?? "").replace(/\r\n/g, "\n");
  const rendered = getRenderedAssistantText(items, isLiveMessageId).replace(/\r\n/g, "\n");
  if (!rendered || !normalizedSnapshot.startsWith(rendered)) {
    return { text: normalizedSnapshot, matched: false };
  }
  return { text: normalizedSnapshot.slice(rendered.length), matched: true };
}

export function createStreamingActions(params: {
  liveStepId: string;
  liveActivityId: string;
  runtimeOrActive: (rt?: ProjectRuntime) => ProjectRuntime;
  setMessages: (items: ChatItem[], rt?: ProjectRuntime) => void;
  dropEmptyAssistantPlaceholder: (rt?: ProjectRuntime) => void;
  /** Retained for compatibility with older callers; insertion uses shared anchors. */
  findLastLiveIndex?: (items: ChatItem[]) => number;
  isLiveMessageId: (id: string) => boolean;
  randomId: (prefix: string) => string;
}) {
  const { liveStepId, liveActivityId, runtimeOrActive, setMessages, dropEmptyAssistantPlaceholder, isLiveMessageId, randomId } =
    params;

  const findActiveStreamingAssistantIndex = (items: ChatItem[]): number => {
    for (let i = items.length - 1; i >= 0; i--) {
      const msg = items[i]!;
      if (isLiveMessageId(msg.id)) continue;
      // Tool execution blocks and patches demarcate phase boundaries. Assistant text
      // before a tool call belongs to a prior conversational phase and must not be concatenated into.
      if (msg.kind === "execute" || msg.kind === "command" || msg.kind === "patch") {
        return -1;
      }
      if (msg.role === "assistant" && msg.kind === "text" && msg.streaming) {
        return i;
      }
    }
    return -1;
  };

  const clearLiveActivityTimer = (state: ProjectRuntime): void => {
    if (state.liveActivityTtlTimer === null) return;
    window.clearTimeout(state.liveActivityTtlTimer);
    state.liveActivityTtlTimer = null;
  };

  const clearLiveActivity = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    clearLiveActivityTimer(state);
    clearLiveActivityWindow(state.liveActivity);

    const existing = state.messages.value.slice();
    const next = existing.filter((m) => m.id !== liveActivityId);
    if (next.length === existing.length) return;
    setMessages(next, state);
  };

  const shouldIgnoreStepDelta = (delta: string): boolean => {
    const normalized = String(delta ?? "");
    if (!normalized) return true;
    if (normalized.length > 2000) return false;
    const trimmed = normalized.trim();
    if (!trimmed) return true;
    const firstLine = trimmed.split("\n")[0]!.trim().toLowerCase();
    if (firstLine.startsWith("[boot]")) {
      return true;
    }
    // Command announcements are redundant with execute cards (Issue #129)
    if (firstLine.startsWith("[command]")) {
      return true;
    }
    if (firstLine.startsWith("[analysis]")) {
      const analysisText = firstLine.slice("[analysis]".length).trim();
      return !analysisText || analysisText === "开始处理请求" || /^reasoning$/i.test(analysisText);
    }
    return firstLine === "active" || firstLine === "thinking…" || firstLine === "thinking..." || firstLine === "working…";
  };

  const upsertStreamingDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    const streamIndex = findActiveStreamingAssistantIndex(existing);
    if (streamIndex >= 0) {
      const current = String(existing[streamIndex]!.content ?? "");
      const nextChunk = stripStreamingOverlap(current, chunk);
      if (!nextChunk) return;
      existing[streamIndex] = {
        ...existing[streamIndex]!,
        content: current + nextChunk,
      };
      setMessages(existing.slice(), state);
      return;
    }

    // Seal any earlier in-flight assistant bubbles from previous phases
    const sealedExisting = existing.map((m) => {
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        return { ...m, streaming: false };
      }
      return m;
    });

    const nextItem: ChatItem = {
      id: randomId("stream"),
      role: "assistant",
      kind: "text",
      content: chunk,
      streaming: true,
      ts: Date.now(),
    };
    const insertAt = findAssistantInsertIndex(sealedExisting);
    setMessages([...sealedExisting.slice(0, insertAt), nextItem, ...sealedExisting.slice(insertAt)], state);
  };

  const sealActiveStreamingAssistant = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    let updated = false;
    const next = existing.map((m) => {
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        updated = true;
        return { ...m, streaming: false };
      }
      return m;
    });
    if (updated) {
      setMessages(next, state);
    }
  };

  /**
   * Replace the in-flight assistant text with an absolute snapshot.
   *
   * `delta` frames are relative and live-only; a client that reconnects mid-turn
   * never sees the ones it missed. The server persists a coalesced `delta_snapshot`
   * carrying the full text so far, and catch-up applies it here — the streaming
   * block is rewritten rather than appended to, so replaying a snapshot is idempotent.
   */
  const replaceStreamingText = (text: string, rt?: ProjectRuntime, ts?: number): void => {
    const state = runtimeOrActive(rt);
    const nextText = String(text ?? "");
    if (!nextText) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    const recovered = getUnrenderedSnapshotText(existing, nextText, isLiveMessageId);
    const streamIndex = findActiveStreamingAssistantIndex(existing);
    if (streamIndex >= 0) {
      const current = String(existing[streamIndex]!.content ?? "");
      const nextContent = recovered.matched ? current + recovered.text : nextText;
      if (current === nextContent) return;
      existing[streamIndex] = {
        ...existing[streamIndex]!,
        content: nextContent,
        ...(Number.isFinite(ts) && (ts as number) > 0 ? { ts: Math.floor(ts as number) } : {}),
      };
      setMessages(existing.slice(), state);
      return;
    }

    if (recovered.matched && !recovered.text) return;

    const sealedExisting = existing.map((m) => {
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        return { ...m, streaming: false };
      }
      return m;
    });

    const nextItem: ChatItem = {
      id: randomId("stream"),
      role: "assistant",
      kind: "text",
      content: recovered.text,
      streaming: true,
      ts: (Number.isFinite(ts) && (ts as number) > 0) ? Math.floor(ts as number) : Date.now(),
    };
    const insertAt = findAssistantInsertIndex(sealedExisting);
    setMessages([...sealedExisting.slice(0, insertAt), nextItem, ...sealedExisting.slice(insertAt)], state);
  };

  const upsertThoughtDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();

    const thoughtIndex = existing.findIndex(
      (m) => m.role === "assistant" && m.kind === "thought" && m.streaming,
    );

    if (thoughtIndex >= 0) {
      const current = String(existing[thoughtIndex]!.content ?? "");
      const nextChunk = stripStreamingOverlap(current, chunk);
      if (!nextChunk) return;
      existing[thoughtIndex] = {
        ...existing[thoughtIndex]!,
        content: current + nextChunk,
      };
      setMessages(existing.slice(), state);
      return;
    }

    const nextItem: ChatItem = {
      id: randomId("thought"),
      role: "assistant",
      kind: "thought",
      content: chunk,
      streaming: true,
      ts: Date.now(),
    };
    const insertAt = findProcessInsertIndex(existing);
    setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);
  };

  const upsertStepLiveDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk || shouldIgnoreStepDelta(chunk)) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    const idx = existing.findIndex((m) => m.id === liveStepId);
    // Step events are status snapshots. The wire field remains `delta` for
    // protocol compatibility, but the live card must show only the newest
    // substantive snapshot instead of an append-only transcript.
    const nextText = trimLiveStepSnapshot(chunk, 14);
    const nextItem: ChatItem = {
      id: liveStepId,
      role: "assistant",
      kind: "text",
      content: nextText,
      streaming: true,
      ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
    };
    const withoutStep = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;
    const insertAt = findProcessInsertIndex(withoutStep);

    const next = [...withoutStep.slice(0, insertAt), nextItem, ...withoutStep.slice(insertAt)];
    setMessages(next, state);
  };

  const upsertLiveActivity = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    dropEmptyAssistantPlaceholder(state);
    const markdown = renderLiveActivityMarkdown(state.liveActivity);

    const existing = state.messages.value.slice();

    if (!markdown) {
      clearLiveActivityTimer(state);
      const next = existing.filter((m) => m.id !== liveActivityId);
      if (next.length === existing.length) return;
      setMessages(next, state);
      return;
    }

    const idx = existing.findIndex((m) => m.id === liveActivityId);
    const nextItem: ChatItem = {
      id: liveActivityId,
      role: "assistant",
      kind: "text",
      content: markdown,
      streaming: true,
      ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
    };
    const withoutActivity = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

    const stepIdx = withoutActivity.findIndex((m) => m.id === liveStepId);
    const insertAt = stepIdx >= 0 ? stepIdx : findProcessInsertIndex(withoutActivity);

    const next = [...withoutActivity.slice(0, insertAt), nextItem, ...withoutActivity.slice(insertAt)];
    setMessages(next, state);

    clearLiveActivityTimer(state);
    state.liveActivityTtlTimer = window.setTimeout(() => {
      clearLiveActivity(state);
    }, LIVE_ACTIVITY_TTL_MS);
  };

  const clearStepLive = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    clearLiveActivityTimer(state);
    clearLiveActivityWindow(state.liveActivity);
    const existing = state.messages.value.slice();
    const stepMsg = existing.find((m) => m.id === liveStepId);
    const stepContent = trimLiveStepSnapshot(String(stepMsg?.content ?? "").trim(), 14).trim();

    let next = existing.filter((m) => !isLiveMessageId(m.id));

    // Finalize any in-flight thought card
    next = next.map((m) => {
      if (m.kind === "thought" && m.streaming) {
        return { ...m, streaming: false };
      }
      return m;
    });

    // Action step traces ([tool], [editing], [command], etc.) MUST NEVER be stored as thought.
    // Only genuine reasoning text (e.g. from legacy producers that prefixed [analysis]) is preserved.
    if (stepContent && !isActionStepTrace(stepContent) && !shouldIgnoreStepDelta(stepContent)) {
      const cleanReasoning = stepContent.startsWith("[analysis]")
        ? stepContent.slice("[analysis]".length).trim()
        : stepContent;
      if (cleanReasoning) {
        const alreadyHas = next.some((m) => m.kind === "thought" && m.content.includes(cleanReasoning));
        if (!alreadyHas) {
          const thoughtItem: ChatItem = {
            id: randomId("thought"),
            role: "assistant",
            kind: "thought",
            content: cleanReasoning,
            streaming: false,
            ts: stepMsg?.ts ?? Date.now(),
          };
          const insertAt = findProcessInsertIndex(next);
          next.splice(insertAt, 0, thoughtItem);
        }
      }
    }
    if (next.length === existing.length && next.every((m, idx) => m === existing[idx])) return;
    setMessages(next, state);
  };

  return {
    shouldIgnoreStepDelta,
    upsertStreamingDelta,
    replaceStreamingText,
    upsertThoughtDelta,
    upsertStepLiveDelta,
    upsertLiveActivity,
    clearStepLive,
    sealActiveStreamingAssistant,
  };
}
