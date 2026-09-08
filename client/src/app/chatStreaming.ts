import { toRaw } from "vue";

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

  const pendingFrameStates = new Set<ProjectRuntime>();
  let pendingFrame: number | null = null;

  const flushStreamingFrame = (): void => {
    pendingFrame = null;
    const states = [...pendingFrameStates];
    pendingFrameStates.clear();
    for (const state of states) {
      setMessages(state.messages.value.slice(), state);
    }
  };

  const scheduleStreamingFrame = (state: ProjectRuntime): void => {
    pendingFrameStates.add(state);
    if (pendingFrame !== null) return;

    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame !== "function") {
      // Non-visual environments (SSR and jsdom) do not provide a frame clock.
      // Flush synchronously there so state consumers keep the same contract.
      flushStreamingFrame();
      return;
    }

    // Use a sentinel while invoking requestAnimationFrame because test clocks
    // are allowed to invoke the callback synchronously.
    pendingFrame = -1;
    const frame = requestFrame(() => flushStreamingFrame());
    if (pendingFrame === -1) pendingFrame = frame;
  };

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
    // Source `step` is provider-authored explanation text. The backend is the
    // boundary that decides which provider event is a live-step; the client
    // only rejects an empty frame and must preserve the text verbatim.
    return !String(delta ?? "").trim();
  };

  const upsertStreamingDelta = (
    delta: string,
    rt?: ProjectRuntime,
    ts?: number,
    options?: { preserveRepeatedText?: boolean },
  ): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    const streamIndex = findActiveStreamingAssistantIndex(existing);
    if (streamIndex >= 0) {
      const current = String(existing[streamIndex]!.content ?? "");
      const nextChunk = options?.preserveRepeatedText ? chunk : stripStreamingOverlap(current, chunk);
      if (!nextChunk) return;
      const rawMessages = toRaw(state.messages.value) as ChatItem[];
      const rawMessage = toRaw(rawMessages[streamIndex]) as ChatItem | undefined;
      if (!rawMessage) return;
      rawMessage.content = current + nextChunk;
      scheduleStreamingFrame(state);
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
      ts: (Number.isFinite(ts) && (ts as number) > 0) ? Math.floor(ts as number) : Date.now(),
    };
    const insertAt = findAssistantInsertIndex(sealedExisting);
    const rawMessages = toRaw(state.messages.value) as ChatItem[];
    const nextMessages = [...sealedExisting.slice(0, insertAt), nextItem, ...sealedExisting.slice(insertAt)].map(
      (message) => toRaw(message) as ChatItem,
    );
    rawMessages.splice(0, rawMessages.length, ...nextMessages);
    scheduleStreamingFrame(state);
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
        ...(Number.isFinite(ts) && (ts as number) > 0
          ? { ts: Math.floor(ts as number) }
          : {}),
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

  // Keep reasoning in the internal message state for backwards compatibility
  // and for history reconciliation. MainChatMessageList deliberately filters
  // these items, so they never become standalone visible blocks.
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
    // Thought and plan cards are no longer part of the visible or persisted
    // turn contract. Drop legacy cards as the turn is sealed as well.
    const next = existing.filter(
      (m) => !isLiveMessageId(m.id) && m.kind !== "thought" && m.kind !== "plan",
    );
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
    flushStreamingFrame,
  };
}
