import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";

import type { CanonicalLaneId } from "../../../shared/terminology.js";

export type ChatLane = CanonicalLaneId;

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
type AcopilotRuntimeShape = RuntimeShape;

function asRuntimeShape(value: unknown): RuntimeShape {
  return value as RuntimeShape;
}

function asAcopilotRuntimeShape(value: unknown): AcopilotRuntimeShape {
  return value as AcopilotRuntimeShape;
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
  activeAcopilotRuntime: Ref<unknown>;
  queuedPrompts: Ref<Array<{ id: string; text: string; images: unknown[] }>>;
  pendingImages: Ref<unknown[]>;
  agentBusy: Ref<boolean>;
  clearActiveChat?: () => void;
  clearAcopilotChat: () => void;
  startNewAcopilotSession?: () => void;
  startNewChatSession: () => void;
  resumeAcopilotThread: () => void;
  resumeTaskThread: (projectId?: string, options?: { sessionId?: string }) => void;
  listResumableSessions: (
    projectId?: string,
    options?: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean; cursor?: string },
  ) => void;
}) {
  const activeChatLane = ref<ChatLane>("acopilot");
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
    Boolean(asAcopilotRuntimeShape(params.activeAcopilotRuntime.value).busy.value) ||
    Boolean(params.activeRuntime.value && (params.activeRuntime.value as RuntimeShape).turnInFlight) ||
    Boolean(asAcopilotRuntimeShape(params.activeAcopilotRuntime.value).turnInFlight);

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

  const acopilotRuntime = computed(() => asAcopilotRuntimeShape(params.activeAcopilotRuntime.value));
  const actionsRuntime = computed(() => asRuntimeShape(params.activeRuntime.value));

  const acopilotMessages = computed(() => acopilotRuntime.value.messages.value);
  const acopilotQueuedPrompts = computed(() =>
    mapQueuedPrompts(acopilotRuntime.value.queuedPrompts.value),
  );
  const acopilotPendingImages = computed(() => acopilotRuntime.value.pendingImages.value);
  const acopilotConnected = computed(() => acopilotRuntime.value.connected.value);
  const acopilotBusy = computed(() => acopilotRuntime.value.busy.value);
  const acopilotInputLocked = computed(() => acopilotRuntime.value.inputLocked.value);
  const acopilotLaneStatus = computed(() => acopilotRuntime.value.laneStatus.value);
  const acopilotComposerDraft = computed({
    get: () => acopilotRuntime.value.composerDraft.value,
    set: (value: string) => {
      acopilotRuntime.value.composerDraft.value = value;
    },
  });
  const acopilotAgents = computed(() => acopilotRuntime.value.availableAgents.value);
  const acopilotActiveAgentId = computed(() => acopilotRuntime.value.activeAgentId.value);
  const acopilotThreadWarning = computed(() => acopilotRuntime.value.threadWarning.value);
  const acopilotChatKey = computed(
    () => `${params.activeProjectId.value}:acopilot`,
  );
  const acopilotPanelKey = computed(
    () => `${panelContextKey.value}:${projectContextGeneration.value}:acopilot`,
  );

  const actionsAgents = computed(() => actionsRuntime.value.availableAgents.value);
  const actionsInputLocked = computed(() => actionsRuntime.value.inputLocked.value);
  const actionsLaneStatus = computed(() => actionsRuntime.value.laneStatus.value);
  const actionsActiveAgentId = computed(() => actionsRuntime.value.activeAgentId.value);
  const actionsComposerDraft = computed({
    get: () => actionsRuntime.value.composerDraft.value,
    set: (value: string) => {
      actionsRuntime.value.composerDraft.value = value;
    },
  });
  const actionsThreadWarning = computed(() => actionsRuntime.value.threadWarning.value);
  const actionsLatestPromptKey = computed(
    () => `${params.activeProjectId.value}:actions`,
  );
  const actionsChatKey = computed(
    () => `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`,
  );
  const actionsPanelKey = computed(
    () => `${panelContextKey.value}:${projectContextGeneration.value}:actions`,
  );
  const actionsQueuedPrompts = computed(() => mapQueuedPrompts(params.queuedPrompts.value));
  const resumableSessions = computed(() => actionsRuntime.value.resumableSessions.value);
  const resumableSessionsBusy = computed(() => actionsRuntime.value.resumableSessionsBusy.value);
  const resumableSessionsError = computed(() => actionsRuntime.value.resumableSessionsError.value);
  const resumableSessionsHidden = computed(() => actionsRuntime.value.resumableSessionsHidden.value);
  const resumableSessionsNextCursor = computed(() => actionsRuntime.value.resumableSessionsNextCursor.value);

  const resumeThreadBlocked = computed(() => false);

  const activeLaneBusy = computed(() => {
    if (activeChatLane.value === "acopilot") return acopilotBusy.value;
    return params.agentBusy.value;
  });

  const activeLaneThreadWarning = computed(() => {
    if (activeChatLane.value === "acopilot") return acopilotThreadWarning.value;
    return actionsThreadWarning.value;
  });

  const activeLaneHasResume = computed(() => true);
  const activeLaneNewSessionBlocked = computed(() => {
    if (activeChatLane.value === "acopilot") return !acopilotConnected.value;
    return false;
  });

  function handleLaneNewSession(): void {
    if (activeLaneNewSessionBlocked.value) return;
    if (activeChatLane.value === "acopilot") {
      if (params.startNewAcopilotSession) {
        params.startNewAcopilotSession();
      } else {
        params.clearAcopilotChat();
      }
    } else {
      params.startNewChatSession();
    }
  }

  function handleLaneClearChat(): void {
    if (activeLaneBusy.value) return;
    if (activeChatLane.value === "acopilot") params.clearAcopilotChat();
    else params.clearActiveChat?.();
  }

  function handleLaneResumeThread(): void {
    if (activeChatLane.value === "acopilot") params.resumeAcopilotThread();
    else if (activeChatLane.value === "actions") params.resumeTaskThread();
  }

  /**
   * The picker only backs the Actions lane, where provider sessions are tracked.
   * The Acopilot lane keeps the original one-click resume.
   */
  const sessionPickerOpen = ref(false);
  const sessionPickerSupported = computed(() => activeChatLane.value === "actions");
  let lastSessionQuery: { search?: string; includeAllCwds?: boolean; includeNoise?: boolean } = {};

  function openSessionPicker(): void {
    if (!sessionPickerSupported.value) {
      params.resumeAcopilotThread();
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
    acopilotMessages,
    acopilotQueuedPrompts,
    acopilotPendingImages,
    acopilotConnected,
    acopilotBusy,
    acopilotInputLocked,
    acopilotLaneStatus,
    acopilotComposerDraft,
    acopilotAgents,
    acopilotActiveAgentId,
    acopilotThreadWarning,
    acopilotChatKey,
    acopilotPanelKey,
    actionsAgents,
    actionsInputLocked,
    actionsLaneStatus,
    actionsActiveAgentId,
    actionsComposerDraft,
    actionsThreadWarning,
    actionsLatestPromptKey,
    actionsChatKey,
    actionsPanelKey,
    actionsQueuedPrompts,
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
