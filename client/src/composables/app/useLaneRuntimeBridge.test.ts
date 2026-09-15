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
  it("defaults the visible lane to planner", () => {
    const plannerRuntime = createRuntime();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.activeChatLane.value).toBe("planner");
  });

  it("keeps the worker latest-prompt key stable across chat sessions", async () => {
    const plannerRuntime = createRuntime();
    const activeProject = ref({ chatSessionId: "session-1" });

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject,
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
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
    const plannerRuntime = createRuntime();
    const activeProjectId = ref("p1");

    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "planner";
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.activeChatLane.value).toBe("planner");
  });

  it("keeps the panel key stable across lane switches so panels stay mounted", () => {
    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialWorkerPanelKey = bridge.workerPanelKey.value;
    const initialPlannerPanelKey = bridge.plannerPanelKey.value;
    bridge.setActiveChatLane("worker");

    expect(bridge.workerPanelKey.value).toBe(initialWorkerPanelKey);
    expect(bridge.plannerPanelKey.value).toBe(initialPlannerPanelKey);
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");
  });

  it("bumps the panel key when the active project changes", async () => {
    const activeProjectId = ref("p1");
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    const initialPanelKey = bridge.plannerPanelKey.value;
    activeProjectId.value = "p3";
    await nextTick();
    await flushRemountBarrier();
    expect(bridge.plannerPanelKey.value).not.toBe(initialPanelKey);
  });

  it("defers the remount barrier while a lane is busy and applies it once idle", async () => {
    const activeProjectId = ref("p1");
    const agentBusy = ref(false);
    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy,
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
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
      activePlannerRuntime: shallowRef(createRuntime()),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
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

  it("blocks disconnected planner lane resets but keeps worker new-session available", () => {
    const clearPlannerChat = vi.fn();
    const startNewChatSession = vi.fn();

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(false),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat,
      startNewChatSession,
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    bridge.activeChatLane.value = "planner";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(true);
    bridge.handleLaneNewSession();
    expect(clearPlannerChat).not.toHaveBeenCalled();

    bridge.activeChatLane.value = "worker";
    expect(bridge.activeLaneNewSessionBlocked.value).toBe(false);
    bridge.handleLaneNewSession();
    expect(startNewChatSession).toHaveBeenCalledTimes(1);
  });

  it("allows planner lane resets again once its websocket reconnects", () => {
    const clearPlannerChat = vi.fn();
    const startNewPlannerSession = vi.fn();

    const plannerBridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(true),
      }),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat,
      startNewPlannerSession,
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    plannerBridge.activeChatLane.value = "planner";
    expect(plannerBridge.activeLaneNewSessionBlocked.value).toBe(false);
    plannerBridge.handleLaneNewSession();
    expect(startNewPlannerSession).toHaveBeenCalledTimes(1);
    expect(clearPlannerChat).not.toHaveBeenCalled();
  });
});
