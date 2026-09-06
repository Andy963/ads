import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import { createExecuteActions } from "../app/chatExecute";
import { normalizeTurnSemanticOrder, getSemanticCardRank } from "../lib/chat_sync";
import type { ChatItem, ProjectRuntime } from "../app/controller";
import MainChat from "../components/MainChat.vue";

describe("Issue #129: Visible execution contract, command ordering, and lane parity", () => {
  it("drops hidden reasoning and keeps provider-authored live-step text", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { send: () => true } as any,
      randomId: (p: string) => `${p}-1`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Solve bug" }, rt);

    // Reasoning is an internal provider event and must not become a chat item.
    handler({ type: "delta", source: "thought", delta: "First thinking step... " });
    handler({ type: "delta", source: "thought", delta: "Analyzing files..." });

    expect(rt.messages.value.some((m) => m.kind === "thought")).toBe(false);

    // Provider-authored explanation is represented by one replaceable live-step block.
    handler({ type: "delta", source: "step", delta: "I will update file.ts after checking the current contents.\n" });
    expect(rt.messages.value.filter((m) => m.id === "live-step")).toHaveLength(1);
    expect(rt.messages.value.find((m) => m.id === "live-step")?.content).toBe(
      "I will update file.ts after checking the current contents.\n",
    );

    // When the turn completes, the transient live-step is removed.
    chat.clearStepLive(rt);
    expect(rt.messages.value.some((m) => m.kind === "thought" || m.kind === "plan")).toBe(false);
    expect(rt.messages.value.find((m) => m.id === "live-step")).toBeUndefined();
  });

  it("keeps provider explanation separate from the execute block", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { send: () => true } as any,
      randomId: (p: string) => `${p}-1`,
      maxTurnCommands: 5,
      updateProject: () => {},
      ...chat,
    });

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Run tests" }, rt);

    handler({ type: "delta", source: "step", delta: "I will run the test command now.\n" });
    expect(rt.messages.value.find((m) => m.id === "live-step")?.content).toBe(
      "I will run the test command now.\n",
    );

    // Actual execute block arrives
    handler({
      type: "command",
      command: { id: "c-1", command: "npm test", outputDelta: "$ npm test\nPASS\n" },
    });

    const executeItem = rt.messages.value.find((m) => m.kind === "execute");
    expect(executeItem).toBeDefined();
    expect(executeItem?.command).toBe("npm test");
    expect(executeItem?.streaming).toBe(true);
    // The provider explanation remains above the execute block.
    expect(rt.messages.value.filter((m) => m.id === "live-step")).toHaveLength(1);
  });

  it("strictly enforces natural hierarchy: User -> Plan -> Thought -> Execute -> Patch -> Assistant", () => {
    const user: ChatItem = { id: "u1", role: "user", kind: "text", content: "prompt" };
    const plan: ChatItem = { id: "pl1", role: "system", kind: "plan", content: "plan" };
    const thought: ChatItem = { id: "th1", role: "assistant", kind: "thought", content: "reasoning" };
    const exec: ChatItem = { id: "ex1", role: "system", kind: "execute", content: "output", command: "ls" };
    const patch: ChatItem = { id: "pa1", role: "system", kind: "patch", content: "diff" };
    const assistant: ChatItem = { id: "as1", role: "assistant", kind: "text", content: "answer" };

    expect(getSemanticCardRank(user)).toBe(0);
    expect(getSemanticCardRank(plan)).toBe(1);
    expect(getSemanticCardRank(thought)).toBe(2);
    // Action & dialogue items share rank 3 to preserve chronological interleaving (Issue #141)
    expect(getSemanticCardRank(exec)).toBe(3);
    expect(getSemanticCardRank(patch)).toBe(3);
    expect(getSemanticCardRank(assistant)).toBe(3);

    // Cognitive tier (User -> Plan -> Thought) precedes the action/dialogue stream:
    const randomOrder: ChatItem[] = [user, exec, patch, assistant, thought, plan];
    const sorted = normalizeTurnSemanticOrder(randomOrder);
    expect(sorted.map((m) => m.id)).toEqual(["u1", "pl1", "th1", "ex1", "pa1", "as1"]);
  });

  it("follows the output tail in compact execute preview instead of locking to the first 3 lines", () => {
    const rt = {
      messages: ref([] as ChatItem[]),
      executePreviewByKey: new Map<string, any>(),
      executeOrder: [] as string[],
      recentCommands: ref([] as string[]),
      turnCommands: [] as string[],
      seenCommandIds: new Set<string>(),
      turnCommandCount: 0,
    } as unknown as ProjectRuntime;

    const { upsertExecuteBlock } = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: (items) => {
        rt.messages.value = items;
      },
      pushRecentCommand: () => {},
      randomId: () => "id",
      maxExecutePreviewLines: 3,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
    });

    // Stream 6 lines of output
    upsertExecuteBlock("k1", "npm test", "$ npm test\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\n", rt);

    const execMsg = rt.messages.value.find((m) => m.kind === "execute");
    expect(execMsg).toBeDefined();
    expect(execMsg?.content).toBe("line 1\nline 2\nline 3");
    expect(execMsg?.hiddenLineCount).toBe(3);
    expect(execMsg?.fullContent).toContain("line 1");
    expect(execMsg?.fullContent).toContain("line 6");
  });

  it("renders running spinner on execute card while streaming and removes it on completion", async () => {
    const messages = ref<ChatItem[]>([
      { id: "u-1", role: "user", kind: "text", content: "build" },
      { id: "exec-1", role: "system", kind: "execute", content: "Compiling...", command: "npm run build", streaming: true },
    ]);

    const wrapper = mount(MainChat, {
      props: {
        messages: messages.value,
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    const spinner = wrapper.find(".executeSpinner");
    expect(spinner.exists()).toBe(true);

    // When command completes streaming
    await wrapper.setProps({
      messages: [
        { id: "u-1", role: "user", kind: "text", content: "build" },
        { id: "exec-1", role: "system", kind: "execute", content: "Compiling... Done.", command: "npm run build", streaming: false },
      ],
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".executeSpinner").exists()).toBe(false);
    wrapper.unmount();
  });
});
