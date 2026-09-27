import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";

import {
  createAppContext,
  createAppController,
  type AppContext,
  type ChatItem,
  type ProjectRuntime,
} from "../app/controller";
import { createChatActions } from "../app/chat";
import { createStreamingActions } from "../app/chatStreaming";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import { createExecuteActions } from "../app/chatExecute";
import { normalizeTurnSemanticOrder, getSemanticCardRank } from "../lib/chat_sync";
import MainChat from "../components/MainChat.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import type { ChatMessage } from "../components/mainChat/types";

// Shared harness: app context + chat actions + ws message handler for a
// single "default" project runtime (used by the issue-129/141 suites).
function createWsHarness() {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = ctx.activeRuntime.value;
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: () => true, sendPrompt: () => true } as any,
    randomId: (p: string) => `${p}-mock`,
    maxTurnCommands: 5,
    updateProject: () => {},
    ...chat,
  });
  return { ctx, chat, rt, handler };
}

// --- Issue #143 reconnect harness (module-level ws mock) ---

let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory: () => void;
} | null = null;

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "advisor") return;
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {}
    close(): void {}
    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
  }

  return { AdsWebSocket };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

async function mountReconnectHarness() {
  let controller: ReturnType<typeof createAppController> | null = null;
  const Harness = defineComponent({
    name: "ReconnectHarness",
    setup() {
      controller = createAppController();
      return {};
    },
    template: "<div />",
  });

  const wrapper = mount(Harness);
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  if (!controller) {
    throw new Error("controller not created");
  }

  controller.loggedIn.value = true;
  controller.currentUser.value = { id: "u-1", username: "admin" } as any;
  await controller.connectWs("default");
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  expect(lastWs).toBeTruthy();
  return { wrapper, controller, rt: controller.getRuntime("default") };
}

// --- Issue #168 message-list helpers ---

function message(id: string, content = `message ${id}`): ChatMessage {
  return {
    id,
    role: "assistant",
    kind: "text",
    content,
  };
}

function messageListProps(messages: ChatMessage[]) {
  return {
    messages,
    copiedMessageId: null,
    formatMessageTs: () => "",
    liveStepExpanded: false,
    liveStepHasOverflow: false,
    liveStepCanToggleExpanded: false,
    liveStepOutlineItems: [],
    liveStepOutlineHiddenCount: 0,
    liveStepCollapsedTrivialOutline: false,
  };
}

describe("Issue #129: Visible execution contract, command ordering, and lane parity", () => {
  it("issue-129: drops hidden reasoning and legacy live-step text", () => {
    const { chat, rt, handler } = createWsHarness();

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Solve bug" }, rt);

    // Reasoning is an internal provider event and must not become a chat item.
    handler({ type: "delta", source: "thought", delta: "First thinking step... " });
    handler({ type: "delta", source: "thought", delta: "Analyzing files..." });

    expect(rt.messages.value.some((m) => m.kind === "thought")).toBe(false);

    handler({ type: "delta", source: "step", delta: "I will update file.ts after checking the current contents.\n" });
    expect(rt.messages.value.some((m) => m.id === "live-step")).toBe(false);

    chat.clearStepLive(rt);
    expect(rt.messages.value.some((m) => m.kind === "thought" || m.kind === "plan")).toBe(false);
  });

  it("issue-129: keeps structured execution separate from the final assistant response", () => {
    const { chat, rt, handler } = createWsHarness();

    chat.pushMessageBeforeLive({ id: "u-1", role: "user", kind: "text", content: "Run tests" }, rt);

    handler({ type: "delta", source: "step", delta: "I will run the test command now.\n" });
    expect(rt.messages.value.some((m) => m.id === "live-step")).toBe(false);

    // Actual execute block arrives
    handler({
      type: "command",
      command: { id: "c-1", command: "npm test", outputDelta: "$ npm test\nPASS\n" },
    });

    const executeItem = rt.messages.value.find((m) => m.kind === "execute");
    expect(executeItem).toBeDefined();
    expect(executeItem?.command).toBe("npm test");
    expect(executeItem?.streaming).toBe(true);
    handler({ type: "delta", delta: "Tests passed." });
    expect(rt.messages.value.some((m) => m.role === "assistant" && m.content === "Tests passed.")).toBe(true);
  });

  it("issue-129: strictly enforces natural hierarchy: User -> Plan -> Thought -> Execute -> Patch -> Assistant", () => {
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

  it("issue-129: follows the output tail in compact execute preview instead of locking to the first 3 lines", () => {
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

  it("issue-129: renders running spinner on execute card while streaming and removes it on completion", async () => {
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

    const loadingDots = wrapper.find(".executeLoadingDots");
    expect(loadingDots.exists()).toBe(true);
    expect(loadingDots.findAll(".executeLoadingDot")).toHaveLength(3);

    // When command completes streaming
    await wrapper.setProps({
      messages: [
        { id: "u-1", role: "user", kind: "text", content: "build" },
        { id: "exec-1", role: "system", kind: "execute", content: "Compiling... Done.", command: "npm run build", streaming: false },
      ],
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".executeLoadingDots").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("Issue #141: Interleaved turn streaming and elimination of monolithic bubble concatenation", () => {
  it("issue-141: interleaves explanations and commands chronologically without monolithic bubble concatenation", () => {
    const { chat, rt, handler } = createWsHarness();

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

    // The visible contract retains assistant phase text and only the newest
    // execute block for the active turn. Superseded command blocks are removed.
    const sequence = messages.map((m) => {
      if (m.role === "user") return "User";
      if (m.kind === "execute") return `Cmd:${m.command}`;
      return `Text:${String(m.content).slice(0, 6)}`;
    });
    expect(sequence).toEqual([
      "User",
      "Text:Step 1",
      "Text:Step 2",
      "Cmd:npm test",
      "Text:Final ",
    ]);
    expect(messages.find((m) => m.kind === "execute" && m.command === "ls -la")).toBeUndefined();
    expect(messages.filter((m) => m.kind === "execute")).toHaveLength(1);
  });

  it("issue-141: does not render retired planCard in MainChat even if legacy plan messages exist", async () => {
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

  it("issue-141: seals assistant streaming bubble and creates separate cards on phase_complete without commands", () => {
    const { chat, rt, handler } = createWsHarness();

    chat.pushMessageBeforeLive({ id: "user-1", role: "user", kind: "text", content: "Explain concept" }, rt);

    // Phase 1 begins and streams
    handler({ type: "delta", delta: "First part of explanation." });
    let messages = rt.messages.value;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("First part of explanation.");
    expect(messages[1]?.streaming).toBe(true);

    // Phase 1 completes (e.g. raw agent_message item completed without any command)
    handler({ type: "phase_complete", phase: "assistant" });
    messages = rt.messages.value;
    expect(messages[1]?.streaming).toBe(false);

    // Phase 2 streams next message
    handler({ type: "delta", delta: "Second part of explanation." });
    messages = rt.messages.value;
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toBe("First part of explanation.");
    expect(messages[1]?.streaming).toBe(false);
    expect(messages[2]?.content).toBe("Second part of explanation.");
    expect(messages[2]?.streaming).toBe(true);
  });

  it("issue-141: phase_complete with no active assistant text is completely harmless", () => {
    const { chat, rt, handler } = createWsHarness();

    chat.pushMessageBeforeLive({ id: "user-1", role: "user", kind: "text", content: "Wait for something" }, rt);
    expect(rt.messages.value).toHaveLength(1);

    // Emit phase_complete when no assistant card is active or streaming
    handler({ type: "phase_complete", phase: "assistant" });
    expect(rt.messages.value).toHaveLength(1);
    expect(rt.messages.value[0]?.content).toBe("Wait for something");
  });
});

describe("Issue #143 follow-up: Reconnect correctness and visible block contract", () => {
  beforeEach(() => {
    lastWs = null;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    lastWs = null;
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("issue-143: preserves user prompt and active command across reconnect", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [
            {
              seq: 2,
              type: "command",
              revision: 1,
              ts: 5000,
              payload: {
                type: "command",
                seq: 2,
                ts: 5000,
                command: {
                  id: "cmd-in-flight",
                  command: "npm test",
                  outputDelta: "PASS tests/web.test.ts\n",
                  status: "running",
                },
              },
            },
          ],
          latestSeq: 2,
          minAvailableSeq: 1,
          hasMore: false,
          truncated: false,
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { wrapper, rt } = await mountReconnectHarness();

      // Initial state: user sent a prompt
      rt.messages.value = [
        { id: "u-1", role: "user", kind: "text", content: "Run the test suite", ts: 1000 },
      ];
      rt.busy.value = true;
      rt.turnInFlight = true;

      // Disconnect while turn is still running
      lastWs!.onClose?.({ code: 1006, reason: "" });
      await settleUi(wrapper);

      // Reconnect begins
      lastWs!.onOpen?.();
      lastWs!.onMessage?.({
        type: "welcome",
        inFlight: true,
        latestSeq: 2,
        bootstrapHistory: true,
      });

      // Bootstrap history arrives carrying only the durable user prompt
      lastWs!.onMessage?.({
        type: "history",
        items: [
          { role: "user", text: "Run the test suite", ts: 1000, kind: "client_message_id:u-1" },
        ],
      });
      await settleUi(wrapper);

      // Verify user message did not disappear and active command is rendered
      await vi.waitFor(() => {
        expect(rt.messages.value.some((m) => m.role === "user" && m.content === "Run the test suite")).toBe(true);
        expect(rt.messages.value.some((m) => m.kind === "execute" && m.command === "npm test")).toBe(true);
      });

      const execMsg = rt.messages.value.find((m) => m.kind === "execute");
      expect(execMsg?.ts).toBe(5000);
      expect(execMsg?.content).toContain("PASS tests/web.test.ts");

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("issue-143: creates a fresh execute block when a command is emitted after reconnect", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    // User prompt in flight
    rt.messages.value = [
      { id: "u-1", role: "user", kind: "text", content: "Build project", ts: 1000 },
    ];
    rt.busy.value = true;
    rt.turnInFlight = true;

    // Disconnect
    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    // Reconnect
    lastWs!.onOpen?.();
    lastWs!.onMessage?.({
      type: "welcome",
      inFlight: true,
      latestSeq: 0,
      bootstrapHistory: false,
    });
    await settleUi(wrapper);

    // Backend later starts a new command after reconnect
    lastWs!.onMessage?.({
      type: "command",
      ts: 7500,
      command: {
        id: "cmd-new-1",
        command: "npm run build",
        outputDelta: "$ npm run build\nBuilding assets...\n",
        status: "running",
      },
    });
    await settleUi(wrapper);

    const executeBlocks = rt.messages.value.filter((m) => m.kind === "execute");
    expect(executeBlocks).toHaveLength(1);
    expect(executeBlocks[0]!.command).toBe("npm run build");
    expect(executeBlocks[0]!.content).toContain("Building assets...");
    expect(executeBlocks[0]!.ts).toBe(7500);

    // User message is still present and precedes the execute block
    expect(rt.messages.value[0]?.role).toBe("user");
    expect(rt.messages.value[0]?.content).toBe("Build project");

    wrapper.unmount();
  });

  it("issue-143: duplicate/reordered catch-up does not duplicate blocks", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    // Catch-up replay emits user prompt and command event
    lastWs!.onOpen?.();
    lastWs!.onMessage?.({
      type: "user",
      clientMessageId: "msg-user-1",
      text: "Deploy service",
      ts: 1000,
      seq: 1,
    });
    lastWs!.onMessage?.({
      type: "command",
      seq: 2,
      ts: 1200,
      command: {
        id: "c-deploy",
        command: "deploy.sh",
        outputDelta: "$ deploy.sh\nDeploying...\n",
      },
    });
    await settleUi(wrapper);

    expect(rt.messages.value.filter((m) => m.role === "user")).toHaveLength(1);
    expect(rt.messages.value.filter((m) => m.kind === "execute")).toHaveLength(1);

    // Replayed duplicate user event with same clientMessageId or text
    lastWs!.onMessage?.({
      type: "user",
      clientMessageId: "msg-user-1",
      text: "Deploy service",
      ts: 1000,
      seq: 1,
    });
    // Duplicate command event with same key/id
    lastWs!.onMessage?.({
      type: "command",
      seq: 2,
      ts: 1200,
      command: {
        id: "c-deploy",
        command: "deploy.sh",
        outputDelta: "$ deploy.sh\nDeploying...\n",
      },
    });
    await settleUi(wrapper);

    // Blocks MUST NOT be duplicated
    expect(rt.messages.value.filter((m) => m.role === "user")).toHaveLength(1);
    expect(rt.messages.value.filter((m) => m.kind === "execute")).toHaveLength(1);
    expect(rt.messages.value.find((m) => m.kind === "execute")?.content).toBe("Deploying...");

    wrapper.unmount();
  });

  it("issue-143: thought/plan/patch do not render as standalone visible cards and patch folds into explanation", async () => {
    const messages = ref([
      { id: "u-1", role: "user" as const, kind: "text" as const, content: "Update app" },
      {
        id: "th-1",
        role: "assistant" as const,
        kind: "thought" as const,
        content: "Internal reasoning about files",
      },
      {
        id: "plan-1",
        role: "system" as const,
        kind: "plan" as const,
        content: "[ ] Step 1",
        plan: { planId: "p1", status: "in_progress" as const, items: [{ text: "Step 1", status: "in_progress" as const }] },
      },
      {
        id: "exec-1",
        role: "system" as const,
        kind: "execute" as const,
        command: "git status",
        content: "M index.ts",
      },
      {
        id: "patch-1",
        role: "system" as const,
        kind: "patch" as const,
        content: "diff --git a/index.ts b/index.ts\n+const x = 1;\n",
        patch: {
          files: [{ path: "index.ts", added: 1, removed: 0 }],
          diff: "diff --git a/index.ts b/index.ts\n+const x = 1;\n",
        },
      },
      {
        id: "a-1",
        role: "assistant" as const,
        kind: "text" as const,
        content: "I have updated index.ts with the required change.",
      },
    ]);

    const wrapper = mount(MainChat, {
      props: {
        messages: messages.value as any,
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    // 1. thought and plan MUST NOT render as standalone cards
    expect(wrapper.find(".thoughtCard").exists()).toBe(false);
    expect(wrapper.find(".planCard").exists()).toBe(false);
    expect(wrapper.findAll('.msg[data-kind="thought"]')).toHaveLength(0);
    expect(wrapper.findAll('.msg[data-kind="plan"]')).toHaveLength(0);

    // 2. patch MUST NOT render as a standalone visible card
    expect(wrapper.findAll('.msg[data-kind="patch"]')).toHaveLength(0);

    // 3. patch info is folded into the surrounding assistant explanation
    expect(wrapper.find(".foldedPatch").exists()).toBe(true);
    expect(wrapper.find(".patchCardTitle").text()).toContain("index.ts");
    expect(wrapper.find(".patchCardMeta").text()).toContain("(+1 -0)");

    // 4. The only visible conversational blocks are: user, execute block, and assistant
    const renderedMsgs = wrapper.findAll(".msg");
    // User message, execute block, and assistant explanation
    expect(renderedMsgs).toHaveLength(3);
    expect(renderedMsgs[0]!.attributes("data-role")).toBe("user");
    expect(renderedMsgs[1]!.attributes("data-kind")).toBe("execute");
    expect(renderedMsgs[2]!.attributes("data-role")).toBe("assistant");

    wrapper.unmount();
  });

  it("issue-143: does not set busy=true or lock input on stale/terminal command snapshot replay during idle bootstrap (Issue #152)", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    // Initial state: idle session
    expect(rt.busy.value).toBe(false);
    expect(rt.inputLocked.value).toBe(false);

    // Reconnect on idle session (inFlight: false)
    lastWs!.onOpen?.();
    lastWs!.onMessage?.({
      type: "welcome",
      inFlight: false,
      latestSeq: 0,
      bootstrapHistory: true,
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    expect(rt.inputLocked.value).toBe(false);

    // Stale completed/failed command snapshot arrives with bootstrap: true
    lastWs!.onMessage?.({
      type: "command_snapshot",
      bootstrap: true,
      seq: 2,
      command: {
        id: "cmd-stale",
        command: "npm test",
        output: "PASS tests/stale.test.ts",
        status: "completed",
      },
    });
    await settleUi(wrapper);

    // Must NOT become busy or lock input
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.inputLocked.value).toBe(false);

    // Terminal command snapshot without bootstrap flag also must not mark turn busy
    lastWs!.onMessage?.({
      type: "command_snapshot",
      seq: 3,
      command: {
        id: "cmd-completed-late",
        command: "git status",
        output: "nothing to commit",
        status: "completed",
      },
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.inputLocked.value).toBe(false);

    // Genuine running command outside bootstrap sets busy=true
    lastWs!.onMessage?.({
      type: "command",
      seq: 4,
      command: {
        id: "cmd-active",
        command: "cargo build",
        outputDelta: "Compiling...",
        status: "running",
      },
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);

    wrapper.unmount();
  });
});

describe("Issue #168 chat rendering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("issue-168: loads recent history first and appends earlier rows without shrinking the window", async () => {
    const messages = Array.from({ length: 65 }, (_, index) => message(`m-${index}`));
    const host = document.createElement("div");
    host.className = "chat";
    document.body.appendChild(host);

    const wrapper = mount(MainChatMessageList, {
      props: messageListProps(messages),
      attachTo: host,
    });

    const height = 10;
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(host, "scrollHeight", {
      configurable: true,
      get: () => wrapper.findAll(".msg").length * height + 1,
    });
    host.scrollTop = 40;

    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.find('.msg[data-id="m-35"]').exists()).toBe(true);
    expect(wrapper.find('.msg[data-id="m-34"]').exists()).toBe(false);
    expect(wrapper.find('.msg[data-id="m-64"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="load-earlier-sentinel"]').exists()).toBe(true);
    expect(host.scrollTop).toBe(40);

    host.scrollTop = 0;
    await (wrapper.vm as unknown as { loadEarlierMessages: () => Promise<void> }).loadEarlierMessages();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(wrapper.find('.msg[data-id="m-15"]').exists()).toBe(true);
    expect(wrapper.find('.msg[data-id="m-14"]').exists()).toBe(false);

    host.scrollTop = 2000;
    await wrapper.setProps({
      messages: [...messages, message("m-65"), message("m-66")],
    });
    await nextTick();
    expect(wrapper.findAll(".msg")).toHaveLength(52);
    expect(wrapper.find('.msg[data-id="m-15"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("issue-168: keeps the complete message history in application state while rendering a bounded initial window", async () => {
    const chat = createChatActions(createAppContext());
    const stateItems = Array.from({ length: 240 }, (_, index) => ({
      id: `m-${index}`,
      role: "assistant" as const,
      kind: "text" as const,
      content: `message ${index}`,
    }));
    expect(chat.trimChatItems(stateItems)).toHaveLength(240);

    const messages = Array.from({ length: 100 }, (_, index) => message(`m-${index}`));
    const wrapper = mount(MainChatMessageList, {
      props: messageListProps(messages),
    });

    await nextTick();
    expect(messages).toHaveLength(100);
    expect(wrapper.find('[data-total-messages="100"]').exists()).toBe(true);
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.find('.msg[data-id="m-70"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("issue-168: clamps long ordinary code blocks and toggles their full content", async () => {
    const code = Array.from({ length: 31 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const wrapper = mount(MarkdownContent, {
      props: { content: `\`\`\`ts\n${code}\n\`\`\`` },
    });

    const block = wrapper.find(".md-codeblock");
    expect(block.classes()).toContain("md-codeblock--clamped");
    expect(block.attributes("data-expanded")).toBe("false");
    expect(block.find(".md-code-toggle").text()).toBe("Show full code");

    await block.find(".md-code-toggle").trigger("click");

    expect(block.classes()).toContain("md-codeblock--expanded");
    expect(block.classes()).not.toContain("md-codeblock--clamped");
    expect(block.attributes("data-expanded")).toBe("true");
    expect(block.find(".md-code-toggle").text()).toBe("Collapse");

    wrapper.unmount();
  });

  it("issue-168: batches streaming deltas into one animation-frame commit", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    let callback: FrameRequestCallback | null = null;
    let commitCount = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      callback = cb;
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const messages = ref<ChatItem[]>([]);
      const runtime = {
        messages,
        liveActivity: { head: 0, tail: 0, size: 0, capacity: 10, totalRecorded: 0, buffer: [] },
        liveActivityTtlTimer: null,
      } as unknown as ProjectRuntime;
      const streaming = createStreamingActions({
        liveActivityId: "live-activity",
        runtimeOrActive: () => runtime,
        setMessages: (items) => {
          commitCount += 1;
          messages.value = items;
        },
        dropEmptyAssistantPlaceholder: () => {},
        isLiveMessageId: (id) => id === "live-step" || id === "live-activity",
        randomId: (prefix) => `${prefix}-1`,
      });

      streaming.upsertStreamingDelta("first ", runtime);
      streaming.upsertStreamingDelta("second", runtime);

      expect(messages.value[0]?.content).toBe("first second");
      expect(commitCount).toBe(0);
      expect(callback).not.toBeNull();

      callback?.(0);

      expect(commitCount).toBe(1);
      expect(messages.value[0]?.content).toBe("first second");
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});
