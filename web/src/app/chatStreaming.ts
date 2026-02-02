import { clearLiveActivityWindow, renderLiveActivityMarkdown } from "../lib/live_activity";

import type { ChatItem, ProjectRuntime } from "./controller";

const LIVE_ACTIVITY_TTL_MS = 3000;

function trimToLastLines(text: string, maxLines: number, maxChars = 2500): string {
  const normalized = String(text ?? "");
  const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
  const lines = recent.split("\n");
  if (lines.length <= maxLines) return recent;
  return lines.slice(lines.length - maxLines).join("\n");
}

export function createStreamingActions(params: {
  liveStepId: string;
  liveActivityId: string;
  runtimeOrActive: (rt?: ProjectRuntime) => ProjectRuntime;
  setMessages: (items: ChatItem[], rt?: ProjectRuntime) => void;
  dropEmptyAssistantPlaceholder: (rt?: ProjectRuntime) => void;
  findLastLiveIndex: (items: ChatItem[]) => number;
  isLiveMessageId: (id: string) => boolean;
  randomId: (prefix: string) => string;
}) {
  const { liveStepId, liveActivityId, runtimeOrActive, setMessages, dropEmptyAssistantPlaceholder, findLastLiveIndex, isLiveMessageId, randomId } =
    params;

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
    if (firstLine.startsWith("[boot]") || firstLine.startsWith("[analysis]")) {
      return true;
    }
    return firstLine === "active" || firstLine === "thinking…" || firstLine === "thinking..." || firstLine === "working…";
  };

  const upsertStreamingDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    let streamIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        streamIndex = i;
        break;
      }
    }
    if (streamIndex >= 0) {
      existing[streamIndex]!.content += chunk;
      setMessages(existing.slice(), state);
      return;
    }

    const nextItem: ChatItem = {
      id: randomId("stream"),
      role: "assistant",
      kind: "text",
      content: chunk,
      streaming: true,
      ts: Date.now(),
    };
    const lastLiveIndex = findLastLiveIndex(existing);
    if (lastLiveIndex < 0) {
      setMessages([...existing, nextItem], state);
      return;
    }
    const insertAt = Math.min(existing.length, lastLiveIndex + 1);
    setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);
  };

  const upsertStepLiveDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    dropEmptyAssistantPlaceholder(state);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    const existing = state.messages.value.slice();
    const idx = existing.findIndex((m) => m.id === liveStepId);
    const current = idx >= 0 ? existing[idx]!.content : "";
    const nextText = trimToLastLines(current + chunk, 14);
    const nextItem: ChatItem = {
      id: liveStepId,
      role: "assistant",
      kind: "text",
      content: nextText,
      streaming: true,
      ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
    };
    const withoutStep = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

    let insertAt = withoutStep.length;
    for (let i = withoutStep.length - 1; i >= 0; i--) {
      const m = withoutStep[i]!;
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        insertAt = i;
        break;
      }
    }

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
    let insertAt = stepIdx >= 0 ? stepIdx : withoutActivity.length;
    if (stepIdx < 0) {
      for (let i = withoutActivity.length - 1; i >= 0; i--) {
        const m = withoutActivity[i]!;
        if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
          insertAt = i;
          break;
        }
      }
    }

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
    const next = existing.filter((m) => !isLiveMessageId(m.id));
    if (next.length === existing.length) return;
    setMessages(next, state);
  };

  return { shouldIgnoreStepDelta, upsertStreamingDelta, upsertStepLiveDelta, upsertLiveActivity, clearStepLive };
}
