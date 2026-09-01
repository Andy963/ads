import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";

describe("flushQueuedPrompts error handling", () => {
  it("preserves user message bubble in transcript when ws sendPrompt fails", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    rt.connected.value = true;
    rt.ws = {
      sendPrompt: vi.fn().mockReturnValue(false),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    chat.enqueuePrompt("Analyze database deadlock issue", []);

    expect(rt.ws?.sendPrompt).toHaveBeenCalled();

    // User message bubble must be preserved
    const userMessages = rt.messages.value.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("Analyze database deadlock issue");

    // Empty assistant placeholder must be dropped
    const assistantMessages = rt.messages.value.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);

    // State flags must be cleared
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.connected.value).toBe(false);

    // Failed prompt must remain in queuedPrompts for retry
    expect(rt.queuedPrompts.value).toHaveLength(1);
    expect(rt.queuedPrompts.value[0]?.text).toBe("Analyze database deadlock issue");
  });

  it("does not duplicate user bubble if retry is flushed again", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    let allowSend = false;
    rt.connected.value = true;
    rt.ws = {
      sendPrompt: vi.fn().mockImplementation(() => allowSend),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    chat.enqueuePrompt("Check server logs", []);
    expect(rt.messages.value.filter((m) => m.role === "user")).toHaveLength(1);

    // Reconnect and retry
    rt.connected.value = true;
    allowSend = true;
    await chat.flushQueuedPrompts(rt);

    // User message should still only have 1 entry
    const userMessages = rt.messages.value.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("Check server logs");
  });
});
