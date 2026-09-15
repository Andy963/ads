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
  it("defaults the visible lane to advisor", () => {
    const advisorRuntime = createRuntime();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(advisorRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.activeChatLane.value).toBe("advisor");
  });

  it("keeps the worker latest-prompt key stable across chat sessions", async () => {
    const advisorRuntime = createRuntime();
    const activeProject = ref({ chatSessionId: "session-1" });

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject,
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(advisorRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.workerChatKey.value).toBe("p1:session-1");
    expect(bridge.workerPanelKey.value).toBe("p1:session-1:0:worker");
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");

    activeProject.value = { chatSessionId: "session-2" };
    await nextTick();
    await flushRemountBarrier();

    expect(bridge.workerChatKey.value).toBe("p1:session-2");
    expect(bridge.workerPanelKey.value).toBe("p1:session-2:1:worker");
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");
  });

  it("does not change the selected lane when the active project changes", async () => {
    const advisorRuntime = createRuntime();
    const activeProjectId = ref("p1");

    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(advisorRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "advisor";
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.activeChatLane.value).toBe("advisor");
  });

  it("keeps the panel key stable across lane switches so panels stay mounted", () => {
    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialWorkerPanelKey = bridge.workerPanelKey.value;
    const initialAdvisorPanelKey = bridge.advisorPanelKey.value;
    bridge.setActiveChatLane("worker");

    expect(bridge.workerPanelKey.value).toBe(initialWorkerPanelKey);
    expect(bridge.advisorPanelKey.value).toBe(initialAdvisorPanelKey);
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");
  });

  it("bumps the panel key when the active project changes", async () => {
    const activeProjectId = ref("p1");
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.advisorPanelKey.value;
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.advisorPanelKey.value).not.toBe(initialPanelKey);
  });

  it("defers the remount barrier while a lane is busy and applies it once idle", async () => {
    const activeProjectId = ref("p1");
    const agentBusy = ref(false);
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy,
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.workerPanelKey.value;
    expect(initialPanelKey).toBe("p1:main:0:worker");
    agentBusy.value = true;
    activeProjectId.value = "p3";
    await nextTick();
    expect(bridge.workerPanelKey.value).toBe(initialPanelKey);

    agentBusy.value = false;
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.workerPanelKey.value).toBe("p3:main:1:worker");
  });

  it("retries the remount barrier when only turnInFlight changes to idle", async () => {
    const activeProjectId = ref("p1");
    const activeRuntime = createRuntime();
    activeRuntime.turnInFlight = true;
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(activeRuntime),
      activeAdvisorRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat: () => {},
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.workerPanelKey.value;
    activeProjectId.value = "p3";
    await nextTick();
    expect(bridge.workerPanelKey.value).toBe(initialPanelKey);

    activeRuntime.turnInFlight = false;
    await flushRemountBarrier();
    expect(bridge.workerPanelKey.value).toBe("p3:main:1:worker");
  });

  it("blocks disconnected advisor lane resets but keeps worker new-session available", () => {
    const clearAdvisorChat = vi.fn();
    const startNewChatSession = vi.fn();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(false),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat,
      startNewChatSession,
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "advisor";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(true);
    bridge.handleLaneNewSession();
    expect(clearAdvisorChat).not.toHaveBeenCalled();

    bridge.activeChatLane.value = "worker";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(false);
    bridge.handleLaneNewSession();
    expect(startNewChatSession).toHaveBeenCalledTimes(1);
  });

  it("allows advisor lane resets again once its websocket reconnects", () => {
    const clearAdvisorChat = vi.fn();
    const startNewAdvisorSession = vi.fn();

    const advisorBridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activeAdvisorRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(true),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearAdvisorChat,
      startNewAdvisorSession,
      startNewChatSession: () => {},
      resumeAdvisorThread: () => {},
      resumeTaskThread: () => {},
    });

    advisorBridge.activeChatLane.value = "advisor";
    expect(advisorBridge.activeLaneNewSessionBlocked.value).toBe(false);
    advisorBridge.handleLaneNewSession();
    expect(startNewAdvisorSession).toHaveBeenCalledTimes(1);
    expect(clearAdvisorChat).not.toHaveBeenCalled();
  });
});
