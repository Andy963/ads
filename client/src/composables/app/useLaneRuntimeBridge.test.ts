import { describe, expect, it, vi } from "vitest";
import { nextTick, ref, shallowRef } from "vue";

import { useLaneRuntimeBridge } from "./useLaneRuntimeBridge";

function createRuntime() {
  return {
    messages: ref([]),
    queuedPrompts: ref([]),
    pendingImages: ref([]),
    connected: ref(false),
    busy: ref(false),
    turnInFlight: false,
    composerDraft: ref(""),
    availableAgents: ref([]),
    activeAgentId: ref(""),
    threadWarning: ref<string | null>(null),
  };
}

async function flushRemountBarrier(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await nextTick();
}

describe("useLaneRuntimeBridge", () => {
  it("defaults the visible lane to acopilot", () => {
    const acopilotRuntime = createRuntime();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(acopilotRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.activeChatLane.value).toBe("acopilot");
  });

  it("keeps the actions latest-prompt key stable across chat sessions", async () => {
    const acopilotRuntime = createRuntime();
    const activeProject = ref({ chatSessionId: "session-1" });

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject,
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(acopilotRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.actionsChatKey.value).toBe("p1:session-1");
    expect(bridge.actionsPanelKey.value).toBe("p1:session-1:0:actions");
    expect(bridge.actionsLatestPromptKey.value).toBe("p1:actions");

    activeProject.value = { chatSessionId: "session-2" };
    await nextTick();
    await flushRemountBarrier();

    expect(bridge.actionsChatKey.value).toBe("p1:session-2");
    expect(bridge.actionsPanelKey.value).toBe("p1:session-2:1:actions");
    expect(bridge.actionsLatestPromptKey.value).toBe("p1:actions");
  });

  it("does not change the selected lane when the active project changes", async () => {
    const acopilotRuntime = createRuntime();
    const activeProjectId = ref("p1");

    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(acopilotRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "acopilot";
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.activeChatLane.value).toBe("acopilot");
  });

  it("keeps the panel key stable across lane switches so panels stay mounted", () => {
    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialWorkerPanelKey = bridge.actionsPanelKey.value;
    const initialAdvisorPanelKey = bridge.acopilotPanelKey.value;
    bridge.setActiveChatLane("actions");

    expect(bridge.actionsPanelKey.value).toBe(initialWorkerPanelKey);
    expect(bridge.acopilotPanelKey.value).toBe(initialAdvisorPanelKey);
    expect(bridge.actionsLatestPromptKey.value).toBe("p1:actions");
  });

  it("bumps the panel key when the active project changes", async () => {
    const activeProjectId = ref("p1");
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.acopilotPanelKey.value;
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.acopilotPanelKey.value).not.toBe(initialPanelKey);
  });

  it("defers the remount barrier while a lane is busy and applies it once idle", async () => {
    const activeProjectId = ref("p1");
    const agentBusy = ref(false);
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy,
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.actionsPanelKey.value;
    expect(initialPanelKey).toBe("p1:main:0:actions");
    agentBusy.value = true;
    activeProjectId.value = "p3";
    await nextTick();
    expect(bridge.actionsPanelKey.value).toBe(initialPanelKey);

    agentBusy.value = false;
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.actionsPanelKey.value).toBe("p3:main:1:actions");
  });

  it("retries the remount barrier when only turnInFlight changes to idle", async () => {
    const activeProjectId = ref("p1");
    const activeRuntime = createRuntime();
    activeRuntime.turnInFlight = true;
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(activeRuntime),
      activeAcopilotRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat: () => {},
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.actionsPanelKey.value;
    activeProjectId.value = "p3";
    await nextTick();
    expect(bridge.actionsPanelKey.value).toBe(initialPanelKey);

    activeRuntime.turnInFlight = false;
    await flushRemountBarrier();
    expect(bridge.actionsPanelKey.value).toBe("p3:main:1:actions");
  });

  it("blocks disconnected acopilot lane resets but keeps actions new-session available", () => {
    const clearAcopilotChat = vi.fn();
    const startNewChatSession = vi.fn();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(false),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat,
      startNewChatSession,
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "acopilot";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(true);
    bridge.handleLaneNewSession();
    expect(clearAcopilotChat).not.toHaveBeenCalled();

    bridge.activeChatLane.value = "actions";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(false);
    bridge.handleLaneNewSession();
    expect(startNewChatSession).toHaveBeenCalledTimes(1);
  });

  it("allows acopilot lane resets again once its websocket reconnects", () => {
    const clearAcopilotChat = vi.fn();
    const startNewAcopilotSession = vi.fn();

    const acopilotBridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAcopilotRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(true),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAcopilotChat,
      startNewAcopilotSession,
      startNewChatSession: () => {},
      resumeAcopilotThread: () => {},
      resumeTaskThread: () => {},
    });

    acopilotBridge.activeChatLane.value = "acopilot";
    expect(acopilotBridge.activeLaneNewSessionBlocked.value).toBe(false);
    acopilotBridge.handleLaneNewSession();
    expect(startNewAcopilotSession).toHaveBeenCalledTimes(1);
    expect(clearAcopilotChat).not.toHaveBeenCalled();
  });
});
