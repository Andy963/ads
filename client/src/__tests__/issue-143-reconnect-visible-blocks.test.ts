import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import { createAppController } from "../app/controller";
import MainChat from "../components/MainChat.vue";

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
      if (chatSessionId === "planner") return;
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

  it("1. preserves user prompt and active command across reconnect", async () => {
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

  it("2. creates a fresh execute block when a command is emitted after reconnect", async () => {
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

  it("3. duplicate/reordered catch-up does not duplicate blocks", async () => {
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

  it("4. thought/plan/patch do not render as standalone visible cards and patch folds into explanation", async () => {
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
});
