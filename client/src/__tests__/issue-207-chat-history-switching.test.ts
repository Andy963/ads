import { defineComponent, nextTick, type PropType } from "vue";
import { mount, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../api/types";
import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type GetImpl = (url: string) => Promise<unknown>;
type ChatMessage = { id: string; content: string };

let getImpl: GetImpl | null = null;
const resolveProjectBIdentities: Array<(value: unknown) => void> = [];

const sockets: Array<{
  sessionId: string;
  chatSessionId: string;
  closed: boolean;
  onOpen?: () => void;
  onMessage?: (message: unknown) => void;
}> = [];

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      return {} as T;
    }

    async patch<T>(): Promise<T> {
      return {} as T;
    }

    async delete<T>(): Promise<T> {
      return {} as T;
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (event: { code: number; reason?: string }) => void;
    onError?: () => void;

    private readonly record: (typeof sockets)[number];
    private messageHandler?: (message: unknown) => void;

    get onMessage(): ((message: unknown) => void) | undefined {
      return this.messageHandler;
    }

    set onMessage(handler: ((message: unknown) => void) | undefined) {
      this.messageHandler = handler;
      this.record.onMessage = handler;
    }

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      this.record = {
        sessionId: options.sessionId,
        chatSessionId: String(options.chatSessionId ?? "main"),
        closed: false,
      };
      sockets.push(this.record);
    }

    connect(): void {
      queueMicrotask(() => this.onOpen?.());
    }

    close(): void {
      this.record.closed = true;
    }

    send(): boolean {
      return true;
    }

    sendPrompt(): boolean {
      return true;
    }

    interrupt(): boolean {
      return true;
    }

    clearHistory(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => ({
  default: defineComponent({
    name: "LoginGate",
    emits: ["logged-in"],
    mounted() {
      void nextTick(() => this.$emit("logged-in", { id: "u-1", username: "admin" }));
    },
    template: "<div />",
  }),
}));

const MainChatViewStub = defineComponent({
  name: "MainChatView",
  props: {
    messages: { type: Array as PropType<ChatMessage[]>, default: () => [] },
  },
  template: `
    <div class="main-chat-stub">
      <span v-for="message in messages" :key="message.id" class="stub-message">{{ message.content }}</span>
    </div>
  `,
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await wrapper.vm.$nextTick();
    await nextTick();
    await Promise.resolve();
  }
}

function emitHistory(socket: (typeof sockets)[number], content: string): void {
  socket.onMessage?.({
    type: "history",
    items: [{ role: "assistant", text: content, ts: Date.now() }],
  });
  socket.onMessage?.({ type: "welcome", inFlight: false });
}

function emitCompletedWorkerTurn(socket: (typeof sockets)[number]): void {
  socket.onMessage?.({
    type: "user",
    clientMessageId: "worker-user-1",
    text: "Run the worker task",
    ts: Date.now(),
  });
  socket.onMessage?.({ type: "delta", source: "step", delta: "Inspecting the workspace" });
  socket.onMessage?.({
    type: "command",
    command: {
      id: "worker-command-1",
      command: "npm test",
      outputDelta: "$ npm test\npassed\n",
      status: "completed",
    },
  });
  socket.onMessage?.({
    type: "patch",
    patch: {
      files: [{ path: "src/example.ts", added: 1, removed: 0 }],
      diff: "diff --git a/src/example.ts b/src/example.ts\n+const value = 1;\n",
    },
  });
  socket.onMessage?.({ type: "delta", delta: "Worker answer is complete." });
  socket.onMessage?.({ type: "phase_complete" });
  socket.onMessage?.({ type: "result", ok: true, output: "Worker answer is complete." });
}

function emitObjectShapedExecuteResult(socket: (typeof sockets)[number]): void {
  socket.onMessage?.({
    type: "result",
    ok: true,
    kind: "execute",
    command: { id: "worker-command-result-1", command: "npm test", output: "private output" },
    output: "passed\n",
  });
}

describe("Issue #207 visible chat context switching", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sockets.length = 0;
    resolveProjectBIdentities.length = 0;

    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "sess-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "sess-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "sess-a");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") {
        return {
          projects: [
            { id: "sess-a", workspaceRoot: "/tmp/project-a", name: "A", chatSessionId: "chat-a" },
            { id: "sess-b", workspaceRoot: "/tmp/project-b", name: "B", chatSessionId: "chat-b" },
          ],
          activeProjectId: "sess-a",
        };
      }
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: ["/tmp"] };
      if (url.includes("path=%2Ftmp%2Fproject-b")) {
        return await new Promise((resolve) => {
          resolveProjectBIdentities.push(resolve);
        });
      }
      if (url.includes("path=%2Ftmp%2Fproject-a")) {
        return { ok: true, resolvedPath: "/tmp/project-a", workspaceRoot: "/tmp/project-a", projectSessionId: "sess-a" };
      }
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    resolveProjectBIdentities.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("rejects a late history frame from the previous project after switching", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatView: MainChatViewStub,
          ModelManager: true,
          DraggableModal: true,
          SessionResumePicker: true,
        },
      },
    });
    await settleUi(wrapper);

    const oldAdvisorSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "advisor",
    );
    const oldWorkerSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "chat-a",
    );
    expect(oldAdvisorSocket).toBeTruthy();
    expect(oldWorkerSocket).toBeTruthy();
    emitHistory(oldAdvisorSocket!, "Project A history");
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-advisor"]').text()).toContain("Project A history");

    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(projectB).toBeTruthy();
    await projectB!.trigger("click");
    await nextTick();

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(oldWorkerSocket!.closed).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Project A history");

    oldWorkerSocket!.onMessage?.({
      type: "history",
      items: [{ role: "assistant", text: "Late Project A history", ts: Date.now() }],
    });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Late Project A history");

    const projectBIdentity = {
      ok: true,
      resolvedPath: "/tmp/project-b",
      workspaceRoot: "/tmp/project-b",
      projectSessionId: "sess-b",
    };
    for (const resolve of resolveProjectBIdentities.splice(0)) resolve(projectBIdentity);
    await settleUi(wrapper);

    const newWorkerSocket = sockets.find(
      (socket) => socket.sessionId === "sess-b" && socket.chatSessionId === "chat-b" && !socket.closed,
    );
    expect(newWorkerSocket).toBeTruthy();
    expect(newWorkerSocket!.onMessage).toBeTypeOf("function");
    emitHistory(newWorkerSocket!, "Project B history");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeRuntime.messages.value.map((message: ChatMessage) => message.content)).toContain("Project B history");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).toContain("Project B history");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Project A history");
    wrapper.unmount();
  });

  it("keeps real lane and project DOM contexts isolated after a completed worker turn", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = mount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatModelSelectors: true,
          ModelManager: true,
          DraggableModal: true,
          SessionResumePicker: true,
        },
      },
    });
    await settleUi(wrapper);

    const advisorSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "advisor",
    );
    const workerSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "chat-a",
    );
    expect(advisorSocket).toBeTruthy();
    expect(workerSocket).toBeTruthy();

    emitHistory(advisorSocket!, "Advisor history");
    emitCompletedWorkerTurn(workerSocket!);
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').text()).toContain("Advisor history");
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').text()).not.toContain("Worker answer is complete.");

    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);
    emitObjectShapedExecuteResult(workerSocket!);
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).toContain("Worker answer is complete.");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).toContain("npm test");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("[object Object]");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Advisor history");

    await wrapper.find('[data-testid="lane-tab-advisor"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').text()).toContain("Advisor history");
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').text()).not.toContain("Worker answer is complete.");

    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(projectB).toBeTruthy();
    await projectB!.trigger("click");
    await settleUi(wrapper);
    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Worker answer is complete.");

    wrapper.unmount();
  });

  it("normalizes object-shaped execute results at the WebSocket boundary", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx);
    const rt = ctx.activeRuntime.value;
    const handler = createWsMessageHandler({
      projects: ctx.projects,
      pid: "default",
      rt,
      wsInstance: { send: vi.fn() },
      maxTurnCommands: 64,
      randomId: (prefix: string) => `${prefix}-test`,
      updateProject: () => {},
      ...chat,
    });

    handler({ type: "user", clientMessageId: "worker-user-1", text: "Run checks", ts: 1 });
    handler({ type: "delta", source: "step", delta: "Inspecting" });
    handler({
      type: "command",
      command: { id: "worker-command-1", command: "npm test", outputDelta: "passed\n" },
    });
    handler({
      type: "patch",
      patch: {
        files: [{ path: "src/example.ts", added: 1, removed: 0 }],
        diff: "diff --git a/src/example.ts b/src/example.ts\n+const value = 1;\n",
      },
    });
    handler({ type: "delta", delta: "Worker answer is complete." });
    handler({ type: "phase_complete" });
    handler({
      type: "result",
      ok: true,
      kind: "execute",
      command: { id: "worker-command-result-1", command: "npm test" },
      output: "passed\n",
    });

    const execute = rt.messages.value.find((message) => message.kind === "execute");
    expect(execute).toMatchObject({ kind: "execute", command: "npm test", content: "passed" });
    expect(execute?.command).not.toBe("[object Object]");
  });
});
