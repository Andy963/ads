import { computed, ref, watch, type Ref } from "vue";

export type ChatLane = "planner" | "worker";

type RuntimePrompt = { id: string; text: string; images: unknown[] };
type AgentOption = { id: string; name: string; ready: boolean; error?: string };
type LaneStatus = { kind: "info" | "progress" | "disconnected" | "error"; message: string };
type ResumableSessionShape = { sessionId: string; updatedAt: number };
type ResumableSessionsHiddenShape = { singleTurn: number; duplicates: number; forks: number };
type RuntimeShape = {
  messages: Ref<unknown[]>;
  queuedPrompts: Ref<RuntimePrompt[]>;
  pendingImages: Ref<unknown[]>;
  connected: Ref<boolean>;
  busy: Ref<boolean>;
  inputLocked: Ref<boolean>;
  laneStatus: Ref<LaneStatus | null>;
  composerDraft: Ref<string>;
  availableAgents: Ref<AgentOption[]>;
  activeAgentId: Ref<string>;
  threadWarning: Ref<string | null>;
  resumableSessions: Ref<ResumableSessionShape[]>;
  resumableSessionsBusy: Ref<boolean>;
  resumableSessionsError: Ref<string | null>;
  resumableSessionsHidden: Ref<ResumableSessionsHiddenShape | null>;
  resumableSessionsNextCursor: Ref<string | null>;
};
type PlannerRuntimeShape = RuntimeShape;

function asRuntimeShape(value: unknown): RuntimeShape {
  return value as RuntimeShape;
}

function asPlannerRuntimeShape(value: unknown): PlannerRuntimeShape {
  return value as PlannerRuntimeShape;
}

function mapQueuedPrompts(
  items: Array<{ id: string; text: string; images: unknown[] }>,
): Array<{ id: string; text: string; imagesCount: number }> {
  return items.map((item) => ({
    id: item.id,
    text: item.text,
    imagesCount: item.images.length,
  }));
}

export function useLaneRuntimeBridge(params: {
  activeProjectId: Ref<string>;
  activeProject: Ref<{ chatSessionId?: string } | null>;
  activeRuntime: Ref<unknown>;
  activePlannerRuntime: Ref<unknown>;
  queueStatus?: Ref<{ running?: boolean } | null>;
  tasks?: Ref<Array<{ status: string }>>;
  queuedPrompts: Ref<Array<{ id: string; text: string; images: unknown[] }>>;
  pendingImages: Ref<unknown[]>;
  agentBusy: Ref<boolean>;
  clearActiveChat?: () => void;
  clearPlannerChat: () => void;
  startNewChatSession: () => void;
  resumePlannerThread: () => void;
  resumeTaskThread: (projectId?: string, options?: { sessionId?: string }) => void;
  listResumableSessions: (
    projectId?: string,
    options?: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean; cursor?: string },
  ) => void;
}) {
  const activeChatLane = ref<ChatLane>("planner");
  watch(
    () => params.activeProjectId.value,
    (nextProjectId, prevProjectId) => {
      if (!prevProjectId || nextProjectId === prevProjectId) return;
      if (activeChatLane.value === "planner") {
        activeChatLane.value = "worker";
      }
    },
  );
  const plannerRuntime = computed(() => asPlannerRuntimeShape(params.activePlannerRuntime.value));
  const workerRuntime = computed(() => asRuntimeShape(params.activeRuntime.value));

  const plannerMessages = computed(() => plannerRuntime.value.messages.value);
  const plannerQueuedPrompts = computed(() =>
    mapQueuedPrompts(plannerRuntime.value.queuedPrompts.value),
  );
  const plannerPendingImages = computed(() => plannerRuntime.value.pendingImages.value);
  const plannerConnected = computed(() => plannerRuntime.value.connected.value);
  const plannerBusy = computed(() => plannerRuntime.value.busy.value);
  const plannerInputLocked = computed(() => plannerRuntime.value.inputLocked.value);
  const plannerLaneStatus = computed(() => plannerRuntime.value.laneStatus.value);
  const plannerComposerDraft = computed({
    get: () => plannerRuntime.value.composerDraft.value,
    set: (value: string) => {
      plannerRuntime.value.composerDraft.value = value;
    },
  });
  const plannerAgents = computed(() => plannerRuntime.value.availableAgents.value);
  const plannerActiveAgentId = computed(() => plannerRuntime.value.activeAgentId.value);
  const plannerThreadWarning = computed(() => plannerRuntime.value.threadWarning.value);
  const plannerChatKey = computed(() => `${params.activeProjectId.value}:planner`);

  const workerAgents = computed(() => workerRuntime.value.availableAgents.value);
  const workerInputLocked = computed(() => workerRuntime.value.inputLocked.value);
  const workerLaneStatus = computed(() => workerRuntime.value.laneStatus.value);
  const workerActiveAgentId = computed(() => workerRuntime.value.activeAgentId.value);
  const workerComposerDraft = computed({
    get: () => workerRuntime.value.composerDraft.value,
    set: (value: string) => {
      workerRuntime.value.composerDraft.value = value;
    },
  });
  const workerThreadWarning = computed(() => workerRuntime.value.threadWarning.value);
  const workerLatestPromptKey = computed(() => `${params.activeProjectId.value}:worker`);
  const workerChatKey = computed(
    () => `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`,
  );
  const workerQueuedPrompts = computed(() => mapQueuedPrompts(params.queuedPrompts.value));
  const resumableSessions = computed(() => workerRuntime.value.resumableSessions.value);
  const resumableSessionsBusy = computed(() => workerRuntime.value.resumableSessionsBusy.value);
  const resumableSessionsError = computed(() => workerRuntime.value.resumableSessionsError.value);
  const resumableSessionsHidden = computed(() => workerRuntime.value.resumableSessionsHidden.value);
  const resumableSessionsNextCursor = computed(() => workerRuntime.value.resumableSessionsNextCursor.value);

  const resumeThreadBlocked = computed(() => false);

  const activeLaneBusy = computed(() => {
    if (activeChatLane.value === "planner") return plannerBusy.value;
    return params.agentBusy.value;
  });

  const activeLaneThreadWarning = computed(() => {
    if (activeChatLane.value === "planner") return plannerThreadWarning.value;
    return workerThreadWarning.value;
  });

  const activeLaneHasResume = computed(() => true);
  const activeLaneNewSessionBlocked = computed(() => {
    if (activeChatLane.value === "planner") return !plannerConnected.value;
    return false;
  });

  function handleLaneNewSession(): void {
    if (activeLaneNewSessionBlocked.value) return;
    if (activeChatLane.value === "planner") params.clearPlannerChat();
    else params.startNewChatSession();
  }

  function handleLaneClearChat(): void {
    if (activeLaneBusy.value) return;
    if (activeChatLane.value === "planner") params.clearPlannerChat();
    else params.clearActiveChat?.();
  }

  function handleLaneResumeThread(): void {
    if (activeChatLane.value === "planner") params.resumePlannerThread();
    else if (activeChatLane.value === "worker") params.resumeTaskThread();
  }

  /**
   * The picker only backs the worker lane, where provider sessions are tracked.
   * The planner lane keeps the original one-click resume.
   */
  const sessionPickerOpen = ref(false);
  const sessionPickerSupported = computed(() => activeChatLane.value === "worker");
  let lastSessionQuery: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean } = {};

  function openSessionPicker(): void {
    if (!sessionPickerSupported.value) {
      params.resumePlannerThread();
      return;
    }
    sessionPickerOpen.value = true;
  }

  function closeSessionPicker(): void {
    sessionPickerOpen.value = false;
  }

  function refreshResumableSessions(options: {
    search?: string;
    includeAllCwds: boolean;
    includeNoise?: boolean;
  }): void {
    lastSessionQuery = { ...options };
    params.listResumableSessions(undefined, options);
  }

  /**
   * Continue the current listing. The filters are replayed from the last refresh
   * so a page boundary cannot silently change what is being listed.
   */
  function loadMoreResumableSessions(): void {
    const cursor = resumableSessionsNextCursor.value;
    if (!cursor || resumableSessionsBusy.value) return;
    params.listResumableSessions(undefined, { ...lastSessionQuery, cursor });
  }

  function resumeSelectedSession(sessionId: string | undefined): void {
    sessionPickerOpen.value = false;
    params.resumeTaskThread(undefined, sessionId ? { sessionId } : undefined);
  }

  return {
    activeChatLane,
    plannerMessages,
    plannerQueuedPrompts,
    plannerPendingImages,
    plannerConnected,
    plannerBusy,
    plannerInputLocked,
    plannerLaneStatus,
    plannerComposerDraft,
    plannerAgents,
    plannerActiveAgentId,
    plannerThreadWarning,
    plannerChatKey,
    workerAgents,
    workerInputLocked,
    workerLaneStatus,
    workerActiveAgentId,
    workerComposerDraft,
    workerThreadWarning,
    workerLatestPromptKey,
    workerChatKey,
    workerQueuedPrompts,
    resumableSessions,
    resumableSessionsBusy,
    resumableSessionsError,
    resumableSessionsHidden,
    resumableSessionsNextCursor,
    resumeThreadBlocked,
    activeLaneBusy,
    activeLaneThreadWarning,
    activeLaneHasResume,
    activeLaneNewSessionBlocked,
    handleLaneNewSession,
    handleLaneClearChat,
    handleLaneResumeThread,
    sessionPickerOpen,
    sessionPickerSupported,
    openSessionPicker,
    closeSessionPicker,
    refreshResumableSessions,
    loadMoreResumableSessions,
    resumeSelectedSession,
  };
}
