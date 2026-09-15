import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";

export type ChatLane = "advisor" | "worker";

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
  turnInFlight?: boolean;
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
type AdvisorRuntimeShape = RuntimeShape;

function asRuntimeShape(value: unknown): RuntimeShape {
  return value as RuntimeShape;
}

function asAdvisorRuntimeShape(value: unknown): AdvisorRuntimeShape {
  return value as AdvisorRuntimeShape;
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
  activeAdvisorRuntime: Ref<unknown>;
  queuedPrompts: Ref<Array<{ id: string; text: string; images: unknown[] }>>;
  pendingImages: Ref<unknown[]>;
  agentBusy: Ref<boolean>;
  clearActiveChat?: () => void;
  clearAdvisorChat: () => void;
  startNewAdvisorSession?: () => void;
  startNewChatSession: () => void;
  resumeAdvisorThread: () => void;
  resumeTaskThread: (projectId?: string, options?: { sessionId?: string }) => void;
  listResumableSessions: (
    projectId?: string,
    options?: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean; cursor?: string },
  ) => void;
}) {
  const activeChatLane = ref<ChatLane>("advisor");
  const projectContextGeneration = ref(0);
  // Latched panel context: while a turn is streaming, the panel key must stay
  // frozen even if the project identity is rewritten in the background. The
  // latched value catches up (and remounts once) when both lanes go idle.
  const panelContextKey = ref(
    `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`,
  );
  let remountBarrierPending = false;
  let remountBarrierTimer: ReturnType<typeof setTimeout> | null = null;
  let remountBarrierToken = 0;
  const REMOUNT_BARRIER_RETRY_MS = 16;

  const lanesBusy = (): boolean =>
    Boolean(params.agentBusy.value) ||
    Boolean(asAdvisorRuntimeShape(params.activeAdvisorRuntime.value).busy.value) ||
    Boolean(params.activeRuntime.value && (params.activeRuntime.value as RuntimeShape).turnInFlight) ||
    Boolean(asAdvisorRuntimeShape(params.activeAdvisorRuntime.value).turnInFlight);

  /**
   * Re-keying a lane panel unmounts+remounts the entire chat tree. Triggering
   * that while a turn is streaming raced with in-flight patches and crashed the
   * renderer on iOS (stack overflow mid-patch, then null-el fallout). Panel
   * content follows the runtime reactively, so deferring the structural
   * remount until idle loses nothing.
   */
  const applyRemountBarrier = (): void => {
    const next = `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`;
    if (next === panelContextKey.value) return;
    panelContextKey.value = next;
    projectContextGeneration.value += 1;
  };

  const cancelRemountBarrierTimer = (): void => {
    remountBarrierToken += 1;
    if (remountBarrierTimer === null) return;
    clearTimeout(remountBarrierTimer);
    remountBarrierTimer = null;
  };

  const scheduleRemountBarrier = (delayMs = 0): void => {
    if (!remountBarrierPending || remountBarrierTimer !== null) return;
    const token = ++remountBarrierToken;
    remountBarrierTimer = setTimeout(() => {
      remountBarrierTimer = null;
      if (token !== remountBarrierToken || !remountBarrierPending) return;
      if (lanesBusy()) {
        scheduleRemountBarrier(REMOUNT_BARRIER_RETRY_MS);
        return;
      }
      remountBarrierPending = false;
      applyRemountBarrier();
    }, delayMs);
  };

  const requestPanelRemountBarrier = (): void => {
    remountBarrierPending = true;
    scheduleRemountBarrier();
  };

  watch(
    () => params.activeProjectId.value,
    (projectId, previousProjectId) => {
      if (!String(projectId ?? "").trim() || projectId === previousProjectId) return;
      // The project id normally changes with the context, but a server-side
      // identity resolution can reuse an id. Keep a local generation as an
      // explicit remount barrier for the visible chat panels.
      requestPanelRemountBarrier();
    },
  );

  watch(
    () => params.activeProject.value?.chatSessionId,
    (chatSessionId, previousChatSessionId) => {
      if (!chatSessionId || chatSessionId === previousChatSessionId) return;
      requestPanelRemountBarrier();
    },
  );

  watch(
    () => lanesBusy(),
    (busy) => {
      if (!busy) scheduleRemountBarrier();
    },
  );

  onBeforeUnmount(() => {
    cancelRemountBarrierTimer();
  });

  function setActiveChatLane(lane: ChatLane): void {
    if (activeChatLane.value === lane) return;
    // Lane switches do not change the panel identity. App keeps only the
    // selected lane mounted, so inactive composers cannot patch in the
    // background or leave Teleport nodes behind in document.body.
    activeChatLane.value = lane;
  }

  const advisorRuntime = computed(() => asAdvisorRuntimeShape(params.activeAdvisorRuntime.value));
  const workerRuntime = computed(() => asRuntimeShape(params.activeRuntime.value));

  const advisorMessages = computed(() => advisorRuntime.value.messages.value);
  const advisorQueuedPrompts = computed(() =>
    mapQueuedPrompts(advisorRuntime.value.queuedPrompts.value),
  );
  const advisorPendingImages = computed(() => advisorRuntime.value.pendingImages.value);
  const advisorConnected = computed(() => advisorRuntime.value.connected.value);
  const advisorBusy = computed(() => advisorRuntime.value.busy.value);
  const advisorInputLocked = computed(() => advisorRuntime.value.inputLocked.value);
  const advisorLaneStatus = computed(() => advisorRuntime.value.laneStatus.value);
  const advisorComposerDraft = computed({
    get: () => advisorRuntime.value.composerDraft.value,
    set: (value: string) => {
      advisorRuntime.value.composerDraft.value = value;
    },
  });
  const advisorAgents = computed(() => advisorRuntime.value.availableAgents.value);
  const advisorActiveAgentId = computed(() => advisorRuntime.value.activeAgentId.value);
  const advisorThreadWarning = computed(() => advisorRuntime.value.threadWarning.value);
  const advisorChatKey = computed(
    () => `${params.activeProjectId.value}:advisor`,
  );
  const advisorPanelKey = computed(
    () => `${panelContextKey.value}:${projectContextGeneration.value}:advisor`,
  );

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
  const workerLatestPromptKey = computed(
    () => `${params.activeProjectId.value}:worker`,
  );
  const workerChatKey = computed(
    () => `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`,
  );
  const workerPanelKey = computed(
    () => `${panelContextKey.value}:${projectContextGeneration.value}:worker`,
  );
  const workerQueuedPrompts = computed(() => mapQueuedPrompts(params.queuedPrompts.value));
  const resumableSessions = computed(() => workerRuntime.value.resumableSessions.value);
  const resumableSessionsBusy = computed(() => workerRuntime.value.resumableSessionsBusy.value);
  const resumableSessionsError = computed(() => workerRuntime.value.resumableSessionsError.value);
  const resumableSessionsHidden = computed(() => workerRuntime.value.resumableSessionsHidden.value);
  const resumableSessionsNextCursor = computed(() => workerRuntime.value.resumableSessionsNextCursor.value);

  const resumeThreadBlocked = computed(() => false);

  const activeLaneBusy = computed(() => {
    if (activeChatLane.value === "advisor") return advisorBusy.value;
    return params.agentBusy.value;
  });

  const activeLaneThreadWarning = computed(() => {
    if (activeChatLane.value === "advisor") return advisorThreadWarning.value;
    return workerThreadWarning.value;
  });

  const activeLaneHasResume = computed(() => true);
  const activeLaneNewSessionBlocked = computed(() => {
    if (activeChatLane.value === "advisor") return !advisorConnected.value;
    return false;
  });

  function handleLaneNewSession(): void {
    if (activeLaneNewSessionBlocked.value) return;
    if (activeChatLane.value === "advisor") {
      if (params.startNewAdvisorSession) {
        params.startNewAdvisorSession();
      } else {
        params.clearAdvisorChat();
      }
    } else {
      params.startNewChatSession();
    }
  }

  function handleLaneClearChat(): void {
    if (activeLaneBusy.value) return;
    if (activeChatLane.value === "advisor") params.clearAdvisorChat();
    else params.clearActiveChat?.();
  }

  function handleLaneResumeThread(): void {
    if (activeChatLane.value === "advisor") params.resumeAdvisorThread();
    else if (activeChatLane.value === "worker") params.resumeTaskThread();
  }

  /**
   * The picker only backs the worker lane, where provider sessions are tracked.
   * The advisor lane keeps the original one-click resume.
   */
  const sessionPickerOpen = ref(false);
  const sessionPickerSupported = computed(() => activeChatLane.value === "worker");
  let lastSessionQuery: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean } = {};

  function openSessionPicker(): void {
    if (!sessionPickerSupported.value) {
      params.resumeAdvisorThread();
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
    setActiveChatLane,
    advisorMessages,
    advisorQueuedPrompts,
    advisorPendingImages,
    advisorConnected,
    advisorBusy,
    advisorInputLocked,
    advisorLaneStatus,
    advisorComposerDraft,
    advisorAgents,
    advisorActiveAgentId,
    advisorThreadWarning,
    advisorChatKey,
    advisorPanelKey,
    workerAgents,
    workerInputLocked,
    workerLaneStatus,
    workerActiveAgentId,
    workerComposerDraft,
    workerThreadWarning,
    workerLatestPromptKey,
    workerChatKey,
    workerPanelKey,
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
