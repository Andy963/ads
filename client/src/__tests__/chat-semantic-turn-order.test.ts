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
});
