import { describe, expect, it } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import type { WsMessage } from "../api/ws";

describe("chat semantic card ordering (Issue #67)", () => {
  it("places plan card above execute block when command arrives before plan in the same turn", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { sendPrompt: () => true } as any,
      randomId: (p: string) => `${p}-mock`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    // 1. User sends prompt
    chat.pushMessageBeforeLive({ id: "user-msg-1", role: "user", kind: "text", content: "Optimize database queries" }, rt);

    // 2. Assistant finishes command execution first
    handler({
      type: "result",
      kind: "execute",
      command: "git status --short",
      output: "M file.ts\n",
    });

    // At this point, we should have [user, execute]
    expect(rt.messages.value.map((m) => m.kind ?? m.role)).toEqual(["text", "execute"]);

    // 3. Model then emits plan event later in the turn
    const planEvent: WsMessage = {
      type: "plan",
      planId: "plan-1",
      status: "in_progress",
      items: [
        { text: "Analyze slow query logs", status: "completed" },
        { text: "Add compound index", status: "in_progress" },
      ],
    };
    handler(planEvent);

    // 4. Verification: Plan MUST be hoisted above the execute block!
    const kinds = rt.messages.value.map((m) => m.kind ?? m.role);
    expect(kinds).toEqual(["text", "plan", "execute"]);
    expect(rt.messages.value[0]?.id).toBe("user-msg-1");
    expect(rt.messages.value[1]?.kind).toBe("plan");
    expect(rt.messages.value[2]?.kind).toBe("execute");
  });

  it("maintains plan card pinned above execute cards when plan updates multiple times", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { sendPrompt: () => true } as any,
      randomId: (p: string) => `${p}-mock`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Refactor storage" }, rt);
    handler({
      type: "result",
      kind: "execute",
      command: "npm test",
      output: "all passed\n",
    });

    // Initial plan
    handler({
      type: "plan",
      planId: "storage-plan",
      status: "in_progress",
      items: [{ text: "Step 1", status: "in_progress" }],
    });

    // Run another command
    handler({
      type: "result",
      kind: "execute",
      command: "git diff",
      output: "+ new code\n",
    });

    // Plan update
    handler({
      type: "plan",
      planId: "storage-plan",
      status: "completed",
      items: [{ text: "Step 1", status: "completed" }],
    });

    // Plan must stay above all execute blocks
    const items = rt.messages.value;
    const planIndex = items.findIndex((m) => m.kind === "plan");
    const firstExecuteIndex = items.findIndex((m) => m.kind === "execute");

    expect(planIndex).toBeGreaterThan(0); // after user
    expect(firstExecuteIndex).toBeGreaterThan(planIndex); // execute after plan
    expect(items[planIndex]?.plan?.status).toBe("completed");
  });

  it("keeps a process card above commands when the command arrives first", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;
    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { sendPrompt: () => true } as any,
      randomId: (p: string) => `${p}-mock`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Inspect the build" }, rt);
    handler({
      type: "command",
      command: { id: "cmd-1", command: "npm test", outputDelta: "$ npm test\nfirst line\n" },
    });
    handler({ type: "delta", source: "step", delta: "[tool] Inspecting the test output" });

    const ids = rt.messages.value.map((item) => item.id);
    expect(ids.indexOf("live-step")).toBeGreaterThan(ids.indexOf("u-1"));
    expect(ids.indexOf("live-step")).toBeLessThan(ids.indexOf("exec:cmd-1:npm test"));
    expect(rt.messages.value.filter((item) => item.id === "live-step")).toHaveLength(1);
  });

  it("keeps the process anchor stable when process arrives before commands and updates repeatedly", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;
    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { sendPrompt: () => true } as any,
      randomId: (p: string) => `${p}-mock`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Run checks" }, rt);
    handler({ type: "delta", source: "step", delta: "[tool] Inspecting" });
    handler({ type: "command", command: { id: "cmd-1", command: "npm test", outputDelta: "first\n" } });
    handler({ type: "delta", source: "step", delta: "[editing] Updating checks" });
    handler({ type: "command", command: { id: "cmd-2", command: "git diff", outputDelta: "second\n" } });
    handler({ type: "command", command: { id: "cmd-1", command: "npm test", outputDelta: "tail\n" } });

    const messages = rt.messages.value;
    const ids = messages.map((item) => item.id);
    const liveIndex = ids.indexOf("live-step");
    const firstExecuteIndex = messages.findIndex((item) => item.kind === "execute");
    expect(messages.filter((item) => item.id === "live-step")).toHaveLength(1);
    expect(messages.find((item) => item.id === "live-step")?.content).toBe("[editing] Updating checks");
    expect(liveIndex).toBeLessThan(firstExecuteIndex);
    expect(messages.filter((item) => item.kind === "execute").map((item) => item.command)).toEqual(["npm test", "git diff"]);
    expect(messages.find((item) => item.command === "npm test")?.content).toContain("first");
    expect(messages.find((item) => item.command === "npm test")?.content).toContain("tail");
  });

  it("reorders persisted history the same way as live events", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;
    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { sendPrompt: () => true } as any,
      randomId: (p: string) => `${p}-mock`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    handler({
      type: "history",
      items: [
        { role: "user", kind: "text", text: "Replay this turn" },
        { role: "status", kind: "execute", text: "$ npm test\nall passed" },
        { role: "thought", kind: "thought", text: "[tool] Inspecting" },
        { role: "ai", kind: "text", text: "Done" },
      ],
    });

    expect(rt.messages.value.map((item) => item.kind)).toEqual(["text", "thought", "execute", "text"]);
  });
});
