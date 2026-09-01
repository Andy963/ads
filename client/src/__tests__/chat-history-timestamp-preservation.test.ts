import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";

describe("chat timestamp preservation", () => {
  it("does not overwrite missing timestamp with Date.now() in pushMessageBeforeLive", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const historicalTimestamp = 1672531199000; // Historical fixed time

    // Push item with explicit historical timestamp
    chat.pushMessageBeforeLive({
      id: "msg-history-1",
      role: "user",
      kind: "text",
      content: "Historical question",
      ts: historicalTimestamp,
    }, rt);

    // Push item without timestamp
    chat.pushMessageBeforeLive({
      id: "msg-history-2",
      role: "assistant",
      kind: "text",
      content: "Historical answer without ts",
    }, rt);

    const messages = rt.messages.value;
    expect(messages).toHaveLength(2);

    // Message 1 must retain its historical timestamp
    expect(messages[0]?.ts).toBe(historicalTimestamp);

    // Message 2 must NOT have been assigned Date.now(); should be undefined
    expect(messages[1]?.ts).toBeUndefined();
  });

  it("assigns prompt creation timestamp when sending prompt", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    rt.connected.value = true;
    rt.ws = {
      sendPrompt: vi.fn().mockReturnValue(true),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    const before = Date.now();
    chat.enqueuePrompt("New prompt", []);
    const after = Date.now();

    const userMsg = rt.messages.value.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(typeof userMsg?.ts).toBe("number");
    expect(userMsg!.ts!).toBeGreaterThanOrEqual(before);
    expect(userMsg!.ts!).toBeLessThanOrEqual(after);
  });

  it("preserves missing timestamps when applying replayed history", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    chat.applyResumeHistory([
      { id: "history-user", role: "user", kind: "text", content: "Old question", ts: 1672531199000 },
      { id: "history-assistant", role: "assistant", kind: "text", content: "Old answer" },
    ], rt);

    expect(rt.messages.value[0]?.ts).toBe(1672531199000);
    expect(rt.messages.value[1]?.ts).toBeUndefined();
  });

  it("assigns a timestamp to a newly created live assistant message", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const before = Date.now();
    chat.finalizeAssistant("Live answer", rt);
    const after = Date.now();

    expect(rt.messages.value[0]?.ts).toBeGreaterThanOrEqual(before);
    expect(rt.messages.value[0]?.ts).toBeLessThanOrEqual(after);
  });
});
