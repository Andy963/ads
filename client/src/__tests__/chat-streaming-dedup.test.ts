import { describe, expect, it } from "vitest";
import { ref } from "vue";

import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createStreamingActions } from "../app/chatStreaming";
import { findLastLiveIndex, isLiveMessageId } from "../app/chatLive";
import { normalizeTurnSemanticOrder, STREAM_DISCONNECT_NOTICE } from "../lib/chat_sync";

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
      messages.value = normalizeTurnSemanticOrder(items);
    },
    dropEmptyAssistantPlaceholder: () => {},
    findLastLiveIndex,
    isLiveMessageId,
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
    expect(messages.value.map((message) => message.id)).toEqual(["u-1", "live-step", "exec-1"]);
  });

  it("resumes only the unrendered suffix of a cumulative snapshot after a command boundary", () => {
    const firstPhase = "Step 1: Inspecting the workspace.";
    const secondPhase = "Step 2: Updating the configuration.";
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      {
        id: "a-1",
        role: "assistant",
        kind: "text",
        content: `${firstPhase}\n\n${STREAM_DISCONNECT_NOTICE}`,
        streaming: false,
      },
      { id: "exec-1", role: "system", kind: "execute", content: "$ npm test\n", command: "npm test", streaming: false },
    ]);

    // Replaying the same cumulative snapshot is a no-op.
    streaming.replaceStreamingText(firstPhase, runtime);
    expect(messages.value).toHaveLength(3);

    // The snapshot includes the already-rendered phase, so only its suffix gets a new bubble.
    streaming.replaceStreamingText(`${firstPhase}${secondPhase}`, runtime);

    const assistantMessages = messages.value.filter((message) => message.role === "assistant" && message.kind === "text");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content).toBe(`${firstPhase}\n\n${STREAM_DISCONNECT_NOTICE}`);
    expect(assistantMessages[1]?.content).toBe(secondPhase);
    expect(messages.value.map((message) => message.kind)).toEqual(["text", "text", "execute", "text"]);
  });

  it("appends a recovered suffix to an already-live post-command bubble", () => {
    const firstPhase = "Step 1: Inspecting the workspace.";
    const secondPhase = "Step 2: Updating the configuration.";
    const finalPhase = " Final summary.";
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      { id: "a-1", role: "assistant", kind: "text", content: firstPhase, streaming: false },
      { id: "exec-1", role: "system", kind: "execute", content: "$ npm test\n", command: "npm test", streaming: false },
      { id: "a-2", role: "assistant", kind: "text", content: secondPhase, streaming: true },
    ]);

    streaming.replaceStreamingText(`${firstPhase}${secondPhase}${finalPhase}`, runtime);

    expect(messages.value.find((message) => message.id === "a-1")?.content).toBe(firstPhase);
    expect(messages.value.find((message) => message.id === "a-2")?.content).toBe(`${secondPhase}${finalPhase}`);
    expect(messages.value.filter((message) => message.role === "assistant" && message.kind === "text")).toHaveLength(2);
  });

  it("replaces the provider live-step snapshot verbatim", () => {
    const { messages, runtime, streaming } = createHarness();

    streaming.upsertStepLiveDelta("I will inspect the workspace first.\n", runtime);
    streaming.upsertStepLiveDelta("I will now verify the relevant configuration.\n", runtime);

    expect(messages.value.find((message) => message.id === "live-step")?.content).toBe("I will now verify the relevant configuration.\n");
  });

  it("renders a provider reasoning summary as the live step", () => {
    const { messages, runtime, streaming } = createHarness();

    streaming.upsertStepLiveDelta("I will compare the adapters before running the check.\n", runtime);

    expect(messages.value.find((message) => message.id === "live-step")?.content).toBe(
      "I will compare the adapters before running the check.\n",
    );
  });

  it("does not persist a live snapshot as a thought card when the turn completes", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      { id: "a-1", role: "assistant", kind: "text", content: "Done", streaming: true },
    ]);

    streaming.upsertStepLiveDelta("I will inspect the workspace.\n", runtime);
    streaming.upsertStepLiveDelta("I will update the source file.\n", runtime);
    streaming.clearStepLive(runtime);

    expect(messages.value.find((message) => message.id === "live-step")).toBeUndefined();
    expect(messages.value.filter((message) => message.kind === "thought")).toHaveLength(0);
    expect(messages.value.some((message) => message.content.includes("Inspecting workspace"))).toBe(false);
  });

  it("does not store provider live-step text as thought cards upon turn completion", () => {
    const { messages, runtime, streaming } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "run the task" },
      { id: "a-1", role: "assistant", kind: "text", content: "Done", streaming: true },
    ]);

    streaming.upsertStepLiveDelta("I will inspect the workspace.\n", runtime);
    streaming.upsertStepLiveDelta("I will update the source file.\n", runtime);
    streaming.clearStepLive(runtime);

    expect(messages.value.find((message) => message.id === "live-step")).toBeUndefined();
    expect(messages.value.filter((message) => message.kind === "thought")).toHaveLength(0);
  });
});
