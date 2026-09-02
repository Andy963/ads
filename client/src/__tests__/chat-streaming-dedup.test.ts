import { describe, expect, it } from "vitest";
import { ref } from "vue";

import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createStreamingActions } from "../app/chatStreaming";

function createHarness(initial: ChatItem[] = []) {
  const messages = ref<ChatItem[]>(initial);
  const runtime = {
    messages,
    liveActivity: { head: 0, tail: 0, size: 0, capacity: 10, totalRecorded: 0, buffer: [] },
    liveActivityTtlTimer: null,
  } as unknown as ProjectRuntime;
  const streaming = createStreamingActions({
    liveStepId: "live-step",
    liveActivityId: "live-activity",
    runtimeOrActive: () => runtime,
    setMessages: (items) => {
      messages.value = items;
    },
    dropEmptyAssistantPlaceholder: () => {},
    findLastLiveIndex: () => -1,
    isLiveMessageId: (id) => id === "live-step" || id === "live-activity",
    randomId: (prefix) => `${prefix}-1`,
  });
  return { messages, runtime, streaming };
}

describe("chat streaming duplicate protection", () => {
  it("does not append a repeated cumulative prefix and still appends new text", () => {
    const { messages, runtime, streaming } = createHarness();
    const first = "This is a sufficiently long assistant response prefix.";

    streaming.upsertStreamingDelta(first, runtime);
    streaming.upsertStreamingDelta(first, runtime);
    streaming.upsertStreamingDelta(`${first} Continued with the next sentence.`, runtime);

    expect(messages.value).toHaveLength(1);
    expect(messages.value[0]?.content).toBe(`${first} Continued with the next sentence.`);
  });

  it("preserves legitimate text when the chunk starts with a repeated boundary", () => {
    const { messages, runtime, streaming } = createHarness();
    const repeatedBoundary = "This repeated boundary is legitimate response content.";
    const current = `The existing response ends with: ${repeatedBoundary}`;
    const incoming = `${repeatedBoundary} Then the answer continues normally.`;

    streaming.upsertStreamingDelta(current, runtime);
    streaming.upsertStreamingDelta(incoming, runtime);

    expect(messages.value[0]?.content).toBe(current + incoming);
  });

  it("replaces the live process snapshot and preserves command cards", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      { id: "exec-1", role: "system", kind: "execute", content: "$ npm test\n", command: "npm test", streaming: false },
    ]);

    streaming.upsertStepLiveDelta("[tool] Inspecting workspace\n", runtime);
    streaming.upsertStepLiveDelta("[editing] Updating source file\n", runtime);

    const liveSteps = messages.value.filter((message) => message.id === "live-step");
    expect(liveSteps).toHaveLength(1);
    expect(liveSteps[0]?.content).toBe("[editing] Updating source file\n");
    expect(liveSteps[0]?.content).not.toContain("Inspecting workspace");
    expect(messages.value.find((message) => message.id === "exec-1")?.content).toBe("$ npm test\n");
  });

  it("does not replace a substantive snapshot with ignored analysis noise", () => {
    const { messages, runtime, streaming } = createHarness();

    streaming.upsertStepLiveDelta("[tool] Inspecting workspace\n", runtime);
    streaming.upsertStepLiveDelta("[analysis] Reasoning\n", runtime);

    expect(messages.value.find((message) => message.id === "live-step")?.content).toBe("[tool] Inspecting workspace\n");
  });

  it("promotes only the latest live snapshot when the turn completes", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      { id: "a-1", role: "assistant", kind: "text", content: "Done", streaming: true },
    ]);

    streaming.upsertStepLiveDelta("[tool] Inspecting workspace\n", runtime);
    streaming.upsertStepLiveDelta("[editing] Updating source file\n", runtime);
    streaming.clearStepLive(runtime);

    expect(messages.value.find((message) => message.id === "live-step")).toBeUndefined();
    expect(messages.value.filter((message) => message.kind === "thought")).toHaveLength(1);
    expect(messages.value.find((message) => message.kind === "thought")?.content).toBe("[editing] Updating source file");
    expect(messages.value.some((message) => message.content.includes("Inspecting workspace"))).toBe(false);
  });
});
