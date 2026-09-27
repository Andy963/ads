import { enableAutoUnmount, mount, shallowMount } from "@vue/test-utils";
import { defineComponent, nextTick, type PropType } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelConfig } from "../api/types";
import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import MainChat from "../components/MainChat.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import type { ChatMessage } from "../components/mainChat/types";
import {
  buildTranscriptViewportScopeKey,
  isTranscriptViewportScopeCurrent,
} from "../lib/transcriptViewportScope";

enableAutoUnmount(afterEach);

type GetImpl = (url: string) => Promise<unknown>;
type StubMessage = { id: string; content: string };

let getImpl: GetImpl | null = null;
const refreshAfterVisibility = vi.fn().mockResolvedValue(undefined);
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
      queueMicrotask(() => this.$emit("logged-in", { id: "u-1", username: "admin" }));
    },
    template: "<div />",
  }),
}));

const MainChatViewStub = defineComponent({
  name: "MainChatView",
  props: {
    messages: { type: Array as PropType<StubMessage[]>, default: () => [] },
  },
  setup(_, { expose }) {
    expose({ refreshAfterVisibility });
    return {};
  },
  template: `
    <div class="main-chat-stub">
      <span
        v-for="message in messages"
        :key="message.id"
        class="stub-message"
        :data-message-id="message.id"
      >{{ message.content }}</span>
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

function message(id: string, content: string) {
  return { id, role: "assistant", kind: "text", content };
}

function isPanelDisplayed(panel: { exists: () => boolean; attributes?: (name: string) => string | undefined }): boolean {
  if (!panel.exists()) return false;
  return !String(panel.attributes?.("style") ?? "").includes("display: none");
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

describe("Issue #198 lane conversation switching", () => {
  beforeEach(() => {
    localStorage.clear();
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") {
        return {
          projects: [],
          activeProjectId: null,
        };
      }
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: [] };
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    refreshAfterVisibility.mockClear();
    localStorage.clear();
  });

  it("commits a touch lane switch only on release and ignores a cancelled gesture", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: MainChatViewStub } },
    });
    await settleUi(wrapper);
    const workerTab = wrapper.get('[data-testid="lane-tab-actions"]');
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true };

    await workerTab.trigger("pointerdown", pointer);
    expect(wrapper.get('[data-testid="lane-tab-acopilot"]').attributes("aria-selected")).toBe("true");
    await workerTab.trigger("pointercancel", pointer);
    await workerTab.trigger("pointerup", pointer);
    expect(workerTab.attributes("aria-selected")).toBe("false");

    await workerTab.trigger("pointerdown", pointer);
    await workerTab.trigger("pointerup", pointer);
    await settleUi(wrapper);
    expect(workerTab.attributes("aria-selected")).toBe("true");
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-actions"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-acopilot"]'))).toBe(false);
    wrapper.unmount();
  });

  it("switches the visible conversation and refreshes only the selected lane", async () => {
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

    const acopilotRuntime = (wrapper.vm as any).activeAcopilotRuntime;
    const actionsRuntime = (wrapper.vm as any).activeRuntime;
    acopilotRuntime.messages.value = [message("advisor-1", "Advisor response")];
    actionsRuntime.messages.value = [message("worker-1", "Worker response")];
    await settleUi(wrapper);

    expect(wrapper.findAll(".main-chat-stub")).toHaveLength(2);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-acopilot"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-actions"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).toContain("Advisor response");

    await wrapper.find('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);

    expect(wrapper.findAll(".main-chat-stub")).toHaveLength(2);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-actions"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-acopilot"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).toContain("Worker response");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Advisor response");

    await wrapper.find('[data-testid="lane-tab-acopilot"]').trigger("click");
    await settleUi(wrapper);

    expect(wrapper.findAll(".main-chat-stub")).toHaveLength(2);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-acopilot"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-actions"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).toContain("Advisor response");
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).not.toContain("Worker response");

    await wrapper.find('[data-testid="lane-tab-actions"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-acopilot"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeChatLane).toBe("actions");
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-actions"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-acopilot"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).toContain("Worker response");

    wrapper.unmount();
  });
});

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
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "acopilot",
    );
    const oldWorkerSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "chat-a",
    );
    expect(oldAdvisorSocket).toBeTruthy();
    expect(oldWorkerSocket).toBeTruthy();
    emitHistory(oldAdvisorSocket!, "Project A history");
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).toContain("Project A history");

    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(projectB).toBeTruthy();
    await projectB!.trigger("click");
    await nextTick();

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(oldWorkerSocket!.closed).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Project A history");

    oldWorkerSocket!.onMessage?.({
      type: "history",
      items: [{ role: "assistant", text: "Late Project A history", ts: Date.now() }],
    });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Late Project A history");

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

    expect((wrapper.vm as any).activeRuntime.messages.value.map((entry: StubMessage) => entry.content)).toContain("Project B history");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).toContain("Project B history");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Project A history");
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
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "acopilot",
    );
    const workerSocket = sockets.find(
      (socket) => socket.sessionId === "sess-a" && socket.chatSessionId === "chat-a",
    );
    expect(advisorSocket).toBeTruthy();
    expect(workerSocket).toBeTruthy();

    emitHistory(advisorSocket!, "Advisor history");
    emitCompletedWorkerTurn(workerSocket!);
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).toContain("Advisor history");
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).not.toContain("Worker answer is complete.");

    await wrapper.find('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);
    emitObjectShapedExecuteResult(workerSocket!);
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).toContain("Worker answer is complete.");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).toContain("npm test");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("[object Object]");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Advisor history");

    await wrapper.find('[data-testid="lane-tab-acopilot"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).toContain("Advisor history");
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').text()).not.toContain("Worker answer is complete.");

    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(projectB).toBeTruthy();
    await projectB!.trigger("click");
    await settleUi(wrapper);
    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(wrapper.find('[data-testid="lane-panel-actions"]').text()).not.toContain("Worker answer is complete.");

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

    const execute = rt.messages.value.find((entry) => entry.kind === "execute");
    expect(execute).toMatchObject({ kind: "execute", command: "npm test", content: "passed" });
    expect(execute?.command).not.toBe("[object Object]");
  });
});

function historyMessages(count: number, prefix = "m"): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: "assistant",
    kind: "text",
    content: `Message ${prefix}-${index}`,
  }));
}

function mountList(items: ChatMessage[], host?: HTMLElement) {
  return mount(MainChatMessageList, {
    props: {
      messages: items,
      copiedMessageId: null,
      formatMessageTs: () => "",
      liveStepExpanded: false,
      liveStepHasOverflow: false,
      liveStepCanToggleExpanded: false,
      liveStepOutlineItems: [],
      liveStepOutlineHiddenCount: 0,
      liveStepCollapsedTrivialOutline: false,
    },
    global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
    attachTo: host,
  });
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
  await nextTick();
}

describe("Issue #228 monotonic history window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("retains all initially loaded rows when tail messages arrive before the first expansion", async () => {
    const wrapper = mountList(historyMessages(65));
    const initialRows = wrapper.findAll(".msg").map((row) => row.element);
    expect(initialRows).toHaveLength(30);

    await wrapper.setProps({ messages: historyMessages(67) });
    expect(wrapper.findAll(".msg")).toHaveLength(32);
    initialRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index].element).toBe(row));
  });

  it("keeps the loaded boundary stable across backfill, replay, and content updates", async () => {
    const original = historyMessages(100);
    const wrapper = mountList(original);
    const firstRow = wrapper.get('.msg[data-id="m-70"]').element;
    const backfilled = [...historyMessages(20, "older"), ...original];

    await wrapper.setProps({ messages: backfilled });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.get('.msg[data-id="m-70"]').element).toBe(firstRow);

    await wrapper.setProps({ messages: backfilled.map((entry) => ({ ...entry, content: `${entry.content}!` })) });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.get('.msg[data-id="m-70"]').element).toBe(firstRow);
  });

  it("preserves surviving loaded rows when a transient boundary row disappears", async () => {
    const original = historyMessages(65);
    const wrapper = mountList(original);
    const survivingRows = wrapper.findAll(".msg").slice(1).map((row) => row.element);

    await wrapper.setProps({ messages: original.filter((entry) => entry.id !== "m-35") });
    expect(wrapper.findAll(".msg")).toHaveLength(survivingRows.length);
    survivingRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index].element).toBe(row));
  });

  it("resets the initial window only when the transcript is replaced or cleared", async () => {
    const wrapper = mountList(historyMessages(65));
    await wrapper.vm.loadEarlierMessages();
    expect(wrapper.findAll(".msg")).toHaveLength(50);

    await wrapper.setProps({ messages: historyMessages(80, "other") });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.findAll(".msg")[0].attributes("data-id")).toBe("other-50");

    await wrapper.setProps({ messages: [] });
    expect(wrapper.findAll(".msg")).toHaveLength(0);
    await wrapper.setProps({ messages: historyMessages(90) });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.findAll(".msg")[0].attributes("data-id")).toBe("m-60");
  });

  it("loads one page per intersection without rearming the observer or writing scrollTop", async () => {
    let callback: IntersectionObserverCallback = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    class Observer {
      constructor(onIntersection: IntersectionObserverCallback) {
        callback = onIntersection;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const host = document.createElement("div");
    host.className = "chat";
    document.body.append(host);
    const writeScrollTop = vi.fn();
    Object.defineProperty(host, "scrollTop", { get: () => 120, set: writeScrollTop });
    const wrapper = mountList(historyMessages(85), host);
    const initialRows = wrapper.findAll(".msg").map((row) => row.element);
    const intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

    intersect();
    intersect();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(writeScrollTop).not.toHaveBeenCalled();
    initialRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index + 20].element).toBe(row));

    intersect();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(70);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(writeScrollTop).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(disconnect).toHaveBeenCalled();
    intersect();
    expect(writeScrollTop).not.toHaveBeenCalled();
  });
});

describe("Issue #228 bottom-following intent", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mountChat() {
    const wrapper = mount(MainChat, {
      props: {
        messages: historyMessages(65),
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        readOnly: true,
      },
      global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
      attachTo: document.body,
    });
    const host = wrapper.get(".chat").element as HTMLElement;
    let top = 0;
    let height = 1000;
    const writeScrollTop = vi.fn((value: number) => { top = Math.max(0, Math.min(value, height - 200)); });
    Object.defineProperties(host, {
      clientHeight: { get: () => 200 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: writeScrollTop },
    });
    const scrollAway = () => {
      top = 400;
      host.dispatchEvent(new Event("scroll"));
    };
    return { wrapper, host, writeScrollTop, scrollAway, grow: (value: number) => { height = value; } };
  }

  it("cancels a pending initial bottom scroll before older rows are prepended", async () => {
    const { wrapper, writeScrollTop } = mountChat();
    await wrapper.getComponent(MainChatMessageList).vm.loadEarlierMessages();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(writeScrollTop).not.toHaveBeenCalled();
  });

  it("rechecks user intent after a tail update commits and before its queued scroll write", async () => {
    const { wrapper, host, writeScrollTop, scrollAway } = mountChat();
    await settle();
    expect(writeScrollTop).toHaveBeenCalledWith(1000);
    writeScrollTop.mockClear();

    const stopWatching = wrapper.vm.$watch("messages", scrollAway, { flush: "post" });
    await wrapper.setProps({ messages: historyMessages(67) });
    await settle();
    stopWatching();
    expect(host.scrollTop).toBe(400);
    expect(writeScrollTop).not.toHaveBeenCalled();

    await wrapper.get(".scrollToBottom").trigger("click");
    await settle();
    expect(writeScrollTop).toHaveBeenCalledWith(1000);
  });

  it("settles an explicit jump after a delayed layout without disabling following (Issue #236)", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const tick = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const { wrapper, host, grow, scrollAway } = mountChat();
    await settle();
    scrollAway();
    await settle();
    const button = wrapper.get(".scrollToBottom");
    expect(button.element.parentElement).toBe(host.parentElement);
    await button.trigger("click");
    await settle();
    grow(1600);
    host.dispatchEvent(new Event("scroll"));
    for (let frame = 0; frame < 10; frame += 1) tick();
    await settle();
    expect(host.scrollTop).toBe(1400);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);
    grow(1800);
    await wrapper.setProps({ messages: historyMessages(67) });
    await settle();
    expect(host.scrollTop).toBe(1600);
    wrapper.unmount();
    expect(frames.size).toBe(0);
  });

  it("cancels pending bottom correction as soon as the user scrolls away", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const { wrapper, host, grow, scrollAway, writeScrollTop } = mountChat();
    await settle();
    scrollAway();
    await settle();
    await wrapper.get(".scrollToBottom").trigger("click");
    await settle();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    scrollAway();
    grow(1600);
    writeScrollTop.mockClear();
    [...frames.values()].forEach((callback) => callback(0));
    await settle();
    expect(host.scrollTop).toBe(400);
    expect(writeScrollTop).not.toHaveBeenCalled();
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);
  });
});

function readUtf8(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relativePath), "utf8");
}

describe("Issue #385 transcript viewport scope", () => {
  it("accepts only the current account, panel, and session scope", () => {
    const current = buildTranscriptViewportScopeKey({ panelKey: "worker:session-a", errorRecoveryGeneration: 0, accountGeneration: 2 });
    const oldSession = buildTranscriptViewportScopeKey({ panelKey: "worker:session-old", errorRecoveryGeneration: 0, accountGeneration: 2 });
    const oldAccount = buildTranscriptViewportScopeKey({ panelKey: "worker:session-a", errorRecoveryGeneration: 0, accountGeneration: 1 });

    expect(isTranscriptViewportScopeCurrent(current, current)).toBe(true);
    expect(isTranscriptViewportScopeCurrent(oldSession, current)).toBe(false);
    expect(isTranscriptViewportScopeCurrent(oldAccount, current)).toBe(false);
  });

  it("emits the scope before the viewport when a keyed chat panel unmounts", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        viewportScopeKey: "worker:session-a:0:2",
      },
      global: { stubs: { MarkdownContent: true } },
    });
    const host = wrapper.get(".chat").element as HTMLElement;
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 240 });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 240));

    wrapper.unmount();

    expect(wrapper.emitted("update:viewportScope")?.[0]).toEqual(["worker:session-a:0:2"]);
    expect(wrapper.emitted("update:viewport")).toHaveLength(1);
  });

  it("fences viewport events from a panel belonging to an old session scope", () => {
    const app = readUtf8("../App.vue");
    const mainChat = readUtf8("../components/MainChat.vue");

    expect(mainChat).toMatch(/viewportScopeKey\?:\s*string\s*;/);
    expect(mainChat).toMatch(/emit\("update:viewportScope", props\.viewportScopeKey\)/);
    expect(mainChat.indexOf('emit("update:viewportScope"')).toBeLessThan(mainChat.indexOf('emit("update:viewport", viewport)'));
    expect(app).toMatch(/:viewport-scope-key="acopilotViewportScopeKey"/);
    expect(app).toMatch(/:viewport-scope-key="actionsViewportScopeKey"/);
    expect(app).toMatch(/accountGeneration\.value/);
    expect(app).toMatch(/isTranscriptViewportScopeCurrent\(acopilotViewportScope\.value, acopilotViewportScopeKey\.value\)/);
    expect(app).toMatch(/isTranscriptViewportScopeCurrent\(actionsViewportScope\.value, actionsViewportScopeKey\.value\)/);
  });
});
