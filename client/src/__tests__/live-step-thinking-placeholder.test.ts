import { describe, expect, it } from "vitest";
import { ref } from "vue";

import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createStreamingActions } from "../app/chatStreaming";
import { isLiveMessageId } from "../app/chatLive";
import { normalizeTurnSemanticOrder } from "../lib/chat_sync";

// Mirror of the real dropEmptyAssistantPlaceholder in app/chat.ts: the empty
// streaming assistant bubble (the "thinking" placeholder) is removed as soon as
// substantive streaming content — including the first live-step — arrives.
function dropEmptyAssistantPlaceholder(messages: ReturnType<typeof ref<ChatItem[]>>): void {
  const existing = messages.value.slice();
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const message = existing[i]!;
    if (isLiveMessageId(message.id)) continue;
    if (message.role === "assistant" && message.kind === "text" && message.streaming && !String(message.content ?? "").trim()) {
      messages.value = [...existing.slice(0, i), ...existing.slice(i + 1)];
      return;
    }
    if (message.role === "assistant" && message.streaming) {
      return;
    }
  }
}

function createHarness(initial: ChatItem[]) {
  const messages = ref<ChatItem[]>(initial);
  const runtime = {
    messages,
    liveActivity: { maxSteps: 5, steps: [], pendingCommand: null },
    liveActivityTtlTimer: null,
  } as unknown as ProjectRuntime;
  const streaming = createStreamingActions({
    liveStepId: "live-step",
    liveActivityId: "live-activity",
    runtimeOrActive: () => runtime,
    setMessages: (items) => {
      messages.value = normalizeTurnSemanticOrder(items);
    },
    dropEmptyAssistantPlaceholder: () => dropEmptyAssistantPlaceholder(messages),
    isLiveMessageId,
    randomId: (prefix) => `${prefix}-1`,
  });
  return { messages, runtime, streaming };
}

describe("live-step progress contract", () => {
  it("replaces the blank thinking placeholder with the live-step card on the first step delta", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "placeholder-1", role: "assistant", kind: "text", content: "", streaming: true, ts: 2 },
    ]);

    streaming.upsertStepLiveDelta("Inspecting the failing test first.", runtime);

    expect(messages.value.some((message) => message.id === "placeholder-1")).toBe(false);
    const liveStep = messages.value.find((message) => message.id === "live-step");
    expect(liveStep?.content).toBe("Inspecting the failing test first.");
    expect(liveStep?.streaming).toBe(true);
    expect(messages.value.map((message) => message.id)).toEqual(["u-1", "live-step"]);
  });

  it("keeps the live-step card as the newest snapshot and clears it with live activity on turn completion", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "placeholder-1", role: "assistant", kind: "text", content: "", streaming: true, ts: 2 },
    ]);

    streaming.upsertStepLiveDelta("Inspecting the failing test first.", runtime);
    streaming.upsertStepLiveDelta("Then running the checks.", runtime);

    const liveSteps = messages.value.filter((message) => message.id === "live-step");
    expect(liveSteps).toHaveLength(1);
    expect(liveSteps[0]?.content).toBe("Then running the checks.");

    streaming.upsertStreamingDelta("All checks pass.", runtime);
    streaming.clearStepLive(runtime);

    expect(messages.value.some((message) => message.id === "live-step")).toBe(false);
    expect(messages.value.some((message) => message.id === "live-activity")).toBe(false);
    expect(messages.value.some((message) => message.kind === "thought")).toBe(false);
    expect(messages.value.some((message) => message.content === "All checks pass.")).toBe(true);
  });
});
