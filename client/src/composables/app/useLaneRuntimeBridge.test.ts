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
    delegationsInFlight: ref([]),
    composerDraft: ref(""),
    availableAgents: ref([]),
    activeAgentId: ref(""),
    threadWarning: ref<string | null>(null),
  };
}

describe("useLaneRuntimeBridge", () => {
  it("defaults the visible lane to worker so existing worker context stays visible", () => {
    const plannerRuntime = {
      ...createRuntime(),
      taskBundleDrafts: ref([]),
      taskBundleDraftsBusy: ref(false),
      taskBundleDraftsError: ref<string | null>(null),
    };

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queueStatus: ref(null),
      tasks: ref([]),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.activeChatLane.value).toBe("worker");
  });

  it("keeps the worker latest-prompt key stable across chat sessions", () => {
    const plannerRuntime = {
      ...createRuntime(),
      taskBundleDrafts: ref([]),
      taskBundleDraftsBusy: ref(false),
      taskBundleDraftsError: ref<string | null>(null),
    };
    const activeProject = ref({ chatSessionId: "session-1" });

    const bridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject,
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queueStatus: ref(null),
      tasks: ref([]),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat: () => {},
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    expect(bridge.workerChatKey.value).toBe("p1:session-1");
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");

    activeProject.value = { chatSessionId: "session-2" };

    expect(bridge.workerChatKey.value).toBe("p1:session-2");
    expect(bridge.workerLatestPromptKey.value).toBe("p1:worker");
  });

  it("returns planner lane to worker when the active project changes", async () => {
    const plannerRuntime = {
      ...createRuntime(),
      taskBundleDrafts: ref([]),
      taskBundleDraftsBusy: ref(false),
      taskBundleDraftsError: ref<string | null>(null),
    };
    const activeProjectId = ref("p1");

    const bridge = useLaneRuntimeBridge({
      activeProjectId,
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef(plannerRuntime),
      queueStatus: ref(null),
      tasks: ref([]),
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
    expect(bridge.activeChatLane.value).toBe("worker");
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
        taskBundleDrafts: ref([]),
        taskBundleDraftsBusy: ref(false),
        taskBundleDraftsError: ref<string | null>(null),
      }),
      queueStatus: ref(null),
      tasks: ref([]),
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

    const plannerBridge = useLaneRuntimeBridge({
      activeProjectId: ref("p1"),
      activeProject: ref({ chatSessionId: "main" }),
      activeRuntime: shallowRef(createRuntime()),
      activePlannerRuntime: shallowRef({
        ...createRuntime(),
        connected: ref(true),
        taskBundleDrafts: ref([]),
        taskBundleDraftsBusy: ref(false),
        taskBundleDraftsError: ref<string | null>(null),
      }),
      queueStatus: ref(null),
      tasks: ref([]),
      queuedPrompts: ref([]),
      pendingImages: ref([]),
      agentBusy: ref(false),
      clearPlannerChat,
      startNewChatSession: () => {},
      resumePlannerThread: () => {},
      resumeTaskThread: () => {},
    });

    plannerBridge.activeChatLane.value = "planner";
    expect(plannerBridge.activeLaneNewSessionBlocked.value).toBe(false);
    plannerBridge.handleLaneNewSession();
    expect(clearPlannerChat).toHaveBeenCalledTimes(1);
  });
});
