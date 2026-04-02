import { computed, ref, watch, type Ref } from "vue";

export type ChatLane = "planner" | "worker" | "reviewer";

type RuntimePrompt = { id: string; text: string; images: unknown[] };
type AgentOption = { id: string; name: string; ready: boolean; error?: string };
type RuntimeShape = {
  messages: Ref<unknown[]>;
  queuedPrompts: Ref<RuntimePrompt[]>;
  pendingImages: Ref<unknown[]>;
  connected: Ref<boolean>;
  busy: Ref<boolean>;
  delegationsInFlight: Ref<unknown[]>;
  composerDraft: Ref<string>;
  availableAgents: Ref<AgentOption[]>;
  activeAgentId: Ref<string>;
  threadWarning: Ref<string | null>;
};
type PlannerRuntimeShape = RuntimeShape & {
  taskBundleDrafts: Ref<unknown[]>;
  taskBundleDraftsBusy: Ref<boolean>;
  taskBundleDraftsError: Ref<string | null>;
};

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
  activeReviewerRuntime: Ref<unknown>;
  queueStatus: Ref<{ running?: boolean } | null>;
  tasks: Ref<Array<{ status: string }>>;
  queuedPrompts: Ref<Array<{ id: string; text: string; images: unknown[] }>>;
  pendingImages: Ref<unknown[]>;
  agentBusy: Ref<boolean>;
  clearPlannerChat: () => void;
  startNewChatSession: () => void;
  startNewReviewerSession: () => void;
  resumePlannerThread: () => void;
  resumeTaskThread: () => void;
}) {
  const activeChatLane = ref<ChatLane>("worker");
  watch(
    () => params.activeProjectId.value,
    (nextProjectId, prevProjectId) => {
      if (!prevProjectId || nextProjectId === prevProjectId) return;
      if (activeChatLane.value === "planner" || activeChatLane.value === "reviewer") {
        activeChatLane.value = "worker";
      }
    },
  );
  const plannerRuntime = computed(() => asPlannerRuntimeShape(params.activePlannerRuntime.value));
  const workerRuntime = computed(() => asRuntimeShape(params.activeRuntime.value));
  const reviewerRuntime = computed(() => asRuntimeShape(params.activeReviewerRuntime.value));

  const plannerMessages = computed(() => plannerRuntime.value.messages.value);
  const plannerQueuedPrompts = computed(() =>
    mapQueuedPrompts(plannerRuntime.value.queuedPrompts.value),
  );
  const plannerPendingImages = computed(() => plannerRuntime.value.pendingImages.value);
  const plannerConnected = computed(() => plannerRuntime.value.connected.value);
  const plannerBusy = computed(() => plannerRuntime.value.busy.value);
  const plannerAgentDelegations = computed(() => plannerRuntime.value.delegationsInFlight.value);
  const plannerDrafts = computed(() => plannerRuntime.value.taskBundleDrafts.value);
  const plannerDraftsBusy = computed(() => plannerRuntime.value.taskBundleDraftsBusy.value);
  const plannerDraftsError = computed(() => plannerRuntime.value.taskBundleDraftsError.value);
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
  const workerActiveAgentId = computed(() => workerRuntime.value.activeAgentId.value);
  const workerComposerDraft = computed({
    get: () => workerRuntime.value.composerDraft.value,
    set: (value: string) => {
      workerRuntime.value.composerDraft.value = value;
    },
  });
  const workerThreadWarning = computed(() => workerRuntime.value.threadWarning.value);
  const workerChatKey = computed(
    () => `${params.activeProjectId.value}:${params.activeProject.value?.chatSessionId ?? "main"}`,
  );
  const workerQueuedPrompts = computed(() => mapQueuedPrompts(params.queuedPrompts.value));

  const resumeThreadBlocked = computed(
    () =>
      Boolean(params.queueStatus.value?.running) ||
      params.tasks.value.some((task) => task.status === "planning" || task.status === "running"),
  );

  const reviewerMessages = computed(() => reviewerRuntime.value.messages.value);
  const reviewerConnected = computed(() => reviewerRuntime.value.connected.value);
  const reviewerQueuedPrompts = computed(() =>
    mapQueuedPrompts(reviewerRuntime.value.queuedPrompts.value),
  );
  const reviewerPendingImages = computed(() => reviewerRuntime.value.pendingImages.value);
  const reviewerBusy = computed(() => reviewerRuntime.value.busy.value);
  const reviewerThreadWarning = computed(() => reviewerRuntime.value.threadWarning.value);
  const reviewerAgents = computed(() => reviewerRuntime.value.availableAgents.value);
  const reviewerActiveAgentId = computed(() => reviewerRuntime.value.activeAgentId.value);
  const reviewerAgentDelegations = computed(() => reviewerRuntime.value.delegationsInFlight.value);
  const reviewerComposerDraft = computed({
    get: () => reviewerRuntime.value.composerDraft.value,
    set: (value: string) => {
      reviewerRuntime.value.composerDraft.value = value;
    },
  });
  const reviewerChatKey = computed(() => `${params.activeProjectId.value}:reviewer`);

  const activeLaneBusy = computed(() => {
    if (activeChatLane.value === "planner") return plannerBusy.value;
    if (activeChatLane.value === "reviewer") return reviewerBusy.value;
    return params.agentBusy.value;
  });

  const activeLaneThreadWarning = computed(() => {
    if (activeChatLane.value === "planner") return plannerThreadWarning.value;
    if (activeChatLane.value === "worker") return workerThreadWarning.value;
    return reviewerThreadWarning.value;
  });

  const activeLaneHasResume = computed(() => activeChatLane.value !== "reviewer");

  function handleLaneNewSession(): void {
    if (activeChatLane.value === "planner") params.clearPlannerChat();
    else if (activeChatLane.value === "worker") params.startNewChatSession();
    else params.startNewReviewerSession();
  }

  function handleLaneResumeThread(): void {
    if (activeChatLane.value === "planner") params.resumePlannerThread();
    else if (activeChatLane.value === "worker") params.resumeTaskThread();
  }

  return {
    activeChatLane,
    plannerMessages,
    plannerQueuedPrompts,
    plannerPendingImages,
    plannerConnected,
    plannerBusy,
    plannerAgentDelegations,
    plannerDrafts,
    plannerDraftsBusy,
    plannerDraftsError,
    plannerComposerDraft,
    plannerAgents,
    plannerActiveAgentId,
    plannerThreadWarning,
    plannerChatKey,
    workerAgents,
    workerActiveAgentId,
    workerComposerDraft,
    workerThreadWarning,
    workerChatKey,
    workerQueuedPrompts,
    resumeThreadBlocked,
    reviewerMessages,
    reviewerConnected,
    reviewerQueuedPrompts,
    reviewerPendingImages,
    reviewerBusy,
    reviewerThreadWarning,
    reviewerAgents,
    reviewerActiveAgentId,
    reviewerAgentDelegations,
    reviewerComposerDraft,
    reviewerChatKey,
    activeLaneBusy,
    activeLaneThreadWarning,
    activeLaneHasResume,
    handleLaneNewSession,
    handleLaneResumeThread,
  };
}
