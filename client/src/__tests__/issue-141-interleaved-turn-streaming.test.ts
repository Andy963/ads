import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import MainChat from "../components/MainChat.vue";

describe("Issue #141: Interleaved turn streaming and elimination of monolithic bubble concatenation", () => {
  it("interleaves explanations and commands chronologically without monolithic bubble concatenation", () => {
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

    // 1. User initiates prompt
    chat.pushMessageBeforeLive({ id: "user-1", role: "user", kind: "text", content: "Implement feature X" }, rt);

    // 2. Model streams Step 1 explanation
    handler({ type: "delta", delta: "Step 1: Inspecting the workspace." });
    handler({ type: "delta", delta: " Looking for package configuration..." });

    let messages = rt.messages.value;
    const step1Bubble = messages.find((m) => m.role === "assistant" && m.kind === "text");
    expect(step1Bubble).toBeDefined();
    expect(step1Bubble?.content).toBe("Step 1: Inspecting the workspace. Looking for package configuration...");
    expect(step1Bubble?.streaming).toBe(true);

    // 3. Command 1 begins executing
    handler({
      type: "command",
      command: { id: "cmd-1", command: "ls -la", outputDelta: "$ ls -la\nfile1.ts\nfile2.ts\n" },
    });

    messages = rt.messages.value;
    // Step 1 explanation must now be sealed (streaming: false)
    expect(messages[1]?.id).toBe(step1Bubble?.id);
    expect(messages[1]?.streaming).toBe(false);

    // Command 1 execute card must follow Step 1 explanation
    const cmd1Card = messages.find((m) => m.kind === "execute" && m.command === "ls -la");
    expect(cmd1Card).toBeDefined();
    expect(cmd1Card?.streaming).toBe(true);
    expect(messages.indexOf(cmd1Card!)).toBeGreaterThan(messages.indexOf(step1Bubble!));

    // 4. Step 1 command finishes, agent streams Step 2 explanation
    handler({ type: "delta", delta: "Step 2: Modifying configuration files..." });

    messages = rt.messages.value;
    // Step 2 must be an independent bubble, NOT concatenated onto Step 1
    const textBubbles = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(textBubbles).toHaveLength(2);
    expect(textBubbles[0]?.content).toBe("Step 1: Inspecting the workspace. Looking for package configuration...");
    expect(textBubbles[1]?.content).toBe("Step 2: Modifying configuration files...");
    expect(textBubbles[1]?.streaming).toBe(true);

    // Step 2 bubble must be placed AFTER Command 1
    expect(messages.indexOf(textBubbles[1]!)).toBeGreaterThan(messages.indexOf(cmd1Card!));

    // 5. Command 2 begins executing
    handler({
      type: "command",
      command: { id: "cmd-2", command: "npm test", outputDelta: "$ npm test\nPASS\n" },
    });

    messages = rt.messages.value;
    // Step 2 bubble is now sealed
    const updatedBubbles = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(updatedBubbles[1]?.streaming).toBe(false);

    const cmd2Card = messages.find((m) => m.kind === "execute" && m.command === "npm test");
    expect(cmd2Card).toBeDefined();
    expect(messages.indexOf(cmd2Card!)).toBeGreaterThan(messages.indexOf(textBubbles[1]!));

    // 6. Agent streams final delivery summary
    handler({ type: "delta", delta: "Final delivery summary: All tests passed successfully." });

    messages = rt.messages.value;
    const allTextBubbles = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(allTextBubbles).toHaveLength(3);
    expect(allTextBubbles[2]?.content).toBe("Final delivery summary: All tests passed successfully.");

    // Verify complete chronological narrative interleaving
    // User -> Step 1 -> Command 1 -> Step 2 -> Command 2 -> Summary
    const sequence = messages.map((m) => {
      if (m.role === "user") return "User";
      if (m.kind === "execute") return `Cmd:${m.command}`;
      return `Text:${String(m.content).slice(0, 6)}`;
    });
    expect(sequence).toEqual([
      "User",
      "Text:Step 1",
      "Cmd:ls -la",
      "Text:Step 2",
      "Cmd:npm test",
      "Text:Final ",
    ]);
  });

  it("does not render retired planCard in MainChat even if legacy plan messages exist", async () => {
    const messages = [
      { id: "u-1", role: "user" as const, kind: "text" as const, content: "Build project" },
      {
        id: "plan-1",
        role: "system" as const,
        kind: "plan" as const,
        content: "Plan text",
        plan: {
          planId: "p1",
          status: "in_progress" as const,
          items: [{ text: "Item 1", status: "completed" as const }],
        },
      },
    ];

    const wrapper = mount(MainChat, {
      props: {
        messages: messages as any,
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    // The dedicated planCard element and its checkbox markers must not exist (ADR 0002)
    expect(wrapper.find(".planCard").exists()).toBe(false);
    expect(wrapper.find(".planCardCheckbox").exists()).toBe(false);
    expect(wrapper.find(".planCardHeader").exists()).toBe(false);

    wrapper.unmount();
  });
});
