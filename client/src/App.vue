<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

declare const __APP_VERSION__: string | undefined;
const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.1";

import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import MainChatView from "./components/MainChat.vue";
import MainChatModelSelectors from "./components/MainChatModelSelectors.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import ModelManager from "./components/ModelManager.vue";
import SessionResumePicker from "./components/SessionResumePicker.vue";

import { createAppController } from "./app/controller";
import { useLaneRuntimeBridge, type ChatLane } from "./composables/app/useLaneRuntimeBridge";
import { useProjectSidebar } from "./composables/app/useProjectSidebar";
import { createTapActivation } from "./lib/tapActivation";
import { crumb } from "./lib/diagBreadcrumbs";
import { errorRecoveryGeneration } from "./lib/errorRecovery";
import {
  readMobileWorkspaceTab,
  writeMobileWorkspaceTab,
  type MobileWorkspaceTab,
} from "./lib/mobileWorkspacePreferences";
import { purgeLatestPromptPreferences } from "./lib/preferencesStore";
import type { TranscriptViewport } from "./app/transcriptCache";
import {
  buildTranscriptViewportScopeKey,
  isTranscriptViewportScopeCurrent,
} from "./lib/transcriptViewportScope";
import {
  ArrowRight,
  CirclePlus,
  ChatDotRound,
  Delete,
  Document,
  MoreFilled,
  Setting,
  Clock,
} from "@element-plus/icons-vue";
import { isLaneConnected } from "./lib/laneConnectionStatus";
const {
  isExecuteBlockFixture,
  loggedIn,
  cachedTranscriptAvailable,
  handleAuthRequired,
  accountGeneration,
  handleLoggedIn,
  isMobile,
  api,
  models,
  loadModels,
  connected,
  openProjectDialog,
  projects,
  activeProjectId,
  activeProject,
  requestProjectSwitch,
  reorderProjects,
  removeProject,
  getRuntime,
  getAdvisorRuntime,
  connectWs,
  runtimeProjectInProgress,
  formatProjectBranch,
  apiError,
  wsError,
  apiAuthorized,
  resumeTaskThread,
  listResumableSessions,
  resumeAdvisorThread,
  clearActiveChat,
  clearAdvisorChat,
  startNewAdvisorSession,
  startNewChatSession,
  messages,
  activeRuntime,
  activeAdvisorRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  sendMainPrompt,
  sendAdvisorPrompt,
  retryPrompt,
  setMainModelId,
  setAdvisorModelId,
  setMainModelReasoningEffort,
  setAdvisorModelReasoningEffort,
  switchMainAgent,
  switchAdvisorAgent,
  interruptActive,
  interruptAdvisor,
  addPendingImages,
  clearPendingImages,
  removePendingImage,
  addAdvisorPendingImages,
  clearAdvisorPendingImages,
  removeAdvisorPendingImage,
  removeQueuedPrompt,
  removeAdvisorQueuedPrompt,
  retryQueuedPrompt,
  retryAdvisorQueuedPrompt,
  apiNotice,
  resolveActiveWorkspaceRoot,
  projectDialogOpen,
  projectDialogPath,
  projectDialogName,
  projectDialogError,
  projectDialogPathStatus,
  projectDialogPathMessage,
  projectDialogSubdirs,
  workspacePath,
  projectPathEl,
  projectNameEl,
  closeProjectDialog,
  validateProjectDialogPath,
  onProjectDialogPathInput,
  focusProjectName,
  useCurrentWorkspacePath,
  submitProjectDialog,
  switchConfirmOpen,
  cancelProjectSwitch,
  confirmProjectSwitch,
} = createAppController();

const settingsOpen = ref(false);

type MobileDrawerSection = "projects" | "settings";
type MobileContextActionId =
  | "resume"
  | "new-session"
  | "create-model"
  | "refresh-models";
type MobileContextAction = {
  id: MobileContextActionId;
  label: string;
  disabled?: boolean;
};
type MobileManagerHandle = {
  refresh: () => Promise<void>;
  create: () => void;
};

const mobileDrawerOpen = ref(false);
const mobileDrawerSection = ref<MobileDrawerSection>("projects");
const mobileContextMenuOpen = ref(false);
const mobileSettingsRef = ref<MobileManagerHandle | null>(null);

const chatLanes: Array<{ id: ChatLane; label: string }> = [
  { id: "advisor", label: "Acopilot" },
  { id: "worker", label: "Actions" },
];
const workspaceTabs = computed<Array<{ id: ChatLane; label: string }>>(() => chatLanes);

const {
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
  activeLaneHasResume,
  activeLaneNewSessionBlocked,
  handleLaneNewSession,
  handleLaneClearChat,
  handleLaneResumeThread,
  sessionPickerOpen,
  openSessionPicker,
  closeSessionPicker,
  refreshResumableSessions,
  loadMoreResumableSessions,
  resumeSelectedSession,
} = useLaneRuntimeBridge({
  activeProjectId,
  activeProject,
  activeRuntime,
  activeAdvisorRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  clearActiveChat,
  clearAdvisorChat,
  startNewAdvisorSession,
  startNewChatSession,
  resumeAdvisorThread,
  resumeTaskThread,
  listResumableSessions,
});

const advisorViewportScopeKey = computed(() => buildTranscriptViewportScopeKey({
  panelKey: advisorPanelKey.value,
  errorRecoveryGeneration: errorRecoveryGeneration.value,
  accountGeneration: accountGeneration.value,
}));
const workerViewportScopeKey = computed(() => buildTranscriptViewportScopeKey({
  panelKey: workerPanelKey.value,
  errorRecoveryGeneration: errorRecoveryGeneration.value,
  accountGeneration: accountGeneration.value,
}));
const advisorViewportScope = ref<string | undefined>();
const workerViewportScope = ref<string | undefined>();

function handleAdvisorViewportScope(scope: string | undefined): void {
  advisorViewportScope.value = scope;
}

function handleWorkerViewportScope(scope: string | undefined): void {
  workerViewportScope.value = scope;
}

function handleAdvisorViewport(viewport: TranscriptViewport): void {
  if (!isTranscriptViewportScopeCurrent(advisorViewportScope.value, advisorViewportScopeKey.value)) return;
  if (activeAdvisorRuntime.value.transcriptViewport) activeAdvisorRuntime.value.transcriptViewport.value = viewport;
}

function handleWorkerViewport(viewport: TranscriptViewport): void {
  if (!isTranscriptViewportScopeCurrent(workerViewportScope.value, workerViewportScopeKey.value)) return;
  if (activeRuntime.value.transcriptViewport) activeRuntime.value.transcriptViewport.value = viewport;
}

const activeWorkspaceTab = computed<ChatLane>(() => activeChatLane.value);

type MainChatHandle = {
  refreshAfterVisibility?: () => void | Promise<void>;
};

const advisorChatRef = ref<MainChatHandle | null>(null);
const workerChatRef = ref<MainChatHandle | null>(null);

const activeLaneConnected = computed(() =>
  activeWorkspaceTab.value === "advisor" ? Boolean(advisorConnected.value) : Boolean(connected.value),
);
const activeLaneInputLocked = computed(() =>
  activeWorkspaceTab.value === "advisor" ? Boolean(advisorInputLocked.value) : Boolean(workerInputLocked.value),
);
const activeLaneAgents = computed(() =>
  activeWorkspaceTab.value === "advisor" ? advisorAgents.value : workerAgents.value,
);
const activeLaneActiveAgentId = computed(() =>
  activeWorkspaceTab.value === "advisor" ? advisorActiveAgentId.value : workerActiveAgentId.value,
);
const activeLaneModelId = computed(() =>
  activeWorkspaceTab.value === "advisor"
    ? activeAdvisorRuntime.value.modelId.value
    : activeRuntime.value.modelId.value,
);
const activeLaneModelReasoningEffort = computed(() =>
  activeWorkspaceTab.value === "advisor"
    ? activeAdvisorRuntime.value.modelReasoningEffort.value
    : activeRuntime.value.modelReasoningEffort.value,
);

function handleActiveLaneSwitchAgent(agentId: string): void {
  if (activeWorkspaceTab.value === "advisor") {
    switchAdvisorAgent(agentId);
  } else {
    switchMainAgent(agentId);
  }
}

function handleActiveLaneSetModel(modelId: string): void {
  if (activeWorkspaceTab.value === "advisor") {
    setAdvisorModelId(modelId);
  } else {
    setMainModelId(modelId);
  }
}

function handleActiveLaneSetReasoningEffort(effort: string): void {
  if (activeWorkspaceTab.value === "advisor") {
    setAdvisorModelReasoningEffort(effort);
  } else {
    setMainModelReasoningEffort(effort);
  }
}

type ProjectBusyState = "idle" | "advisor" | "worker" | "both";

function projectBusyState(projectId: string): ProjectBusyState {
  const advisorBusy = runtimeProjectInProgress(getAdvisorRuntime(projectId));
  const workerBusy = runtimeProjectInProgress(getRuntime(projectId));
  if (advisorBusy && workerBusy) return "both";
  if (advisorBusy) return "advisor";
  if (workerBusy) return "worker";
  return "idle";
}

function projectStatusClass(projectId: string): string {
  const state = projectBusyState(projectId);
  return state === "idle" ? "" : `spinning spinning--${state}`;
}

function projectStatusTitle(projectId: string): string | undefined {
  const state = projectBusyState(projectId);
  if (state === "advisor") return "Advisor 正在规划…";
  if (state === "worker") return "Worker 正在执行…";
  if (state === "both") return "Advisor 与 Worker 均在运行中…";
  return undefined;
}

/**
 * Browsing the list is read-only and always allowed; only the resume action is
 * gated. Saying why beats a row that is silently unclickable.
 */
const sessionResumeDisabledReason = computed(() => {
  if (activeLaneBusy.value) return "当前对话正在生成，结束后才能恢复其它会话";
  if (resumeThreadBlocked.value) return "有任务正在运行，结束后才能恢复其它会话";
  return "";
});

const mobileContextTitle = computed(() => {
  if (mobileDrawerSection.value === "settings") return mobileSettingsTab.value === "models" ? "模型配置" : "角色指令";
  return activeProject.value?.name?.trim() || "项目";
});

const mobileContextMenuTitle = computed(() => {
  if (mobileDrawerSection.value === "settings") return mobileSettingsTab.value === "models" ? "模型配置操作" : "角色指令操作";
  return "项目操作";
});

const mobileContextActions = computed<MobileContextAction[]>(() => {
  if (mobileDrawerSection.value === "settings") {
    return [];
  }
  return [
    {
      id: "resume",
      label: "恢复会话",
      disabled: activeLaneBusy.value || resumeThreadBlocked.value,
    },
    {
      id: "new-session",
      label: "新建会话",
      disabled: activeLaneBusy.value || activeLaneNewSessionBlocked.value,
    },
  ];
});

function closeMobileContextMenu(): void {
  mobileContextMenuOpen.value = false;
}

const projectSwipeOpenId = ref<string | null>(null);
const activeProjectSwipeId = ref<string | null>(null);
const activeProjectSwipeOffset = ref(0);

function closeProjectSwipe(): void {
  projectSwipeOpenId.value = null;
  activeProjectSwipeId.value = null;
  activeProjectSwipeOffset.value = 0;
}

function closeMobileDrawer(): void {
  cancelDrawerGesture();
  closeProjectSwipe();
  mobileDrawerOpen.value = false;
  mobileContextMenuOpen.value = false;
}

function openMobileDrawer(section?: MobileDrawerSection): void {
  if (!isMobile.value) return;
  cancelDrawerGesture();
  if (section) {
    mobileDrawerSection.value = section;
  }
  mobileDrawerOpen.value = true;
  mobileContextMenuOpen.value = false;
}

function toggleMobileDrawer(): void {
  if (mobileDrawerOpen.value) closeMobileDrawer();
  else openMobileDrawer();
}

const drawerActivation = createTapActivation<boolean>(toggleMobileDrawer, { name: "mobile-drawer" });

function selectWorkspaceTab(tab: ChatLane): void {
  if (activeWorkspaceTab.value === tab) {
    closeMobileContextMenu();
    return;
  }
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  setActiveChatLane(tab);
  crumb(`lane:${activeWorkspaceTab.value}->${tab}`);
  if (isMobile.value) writeMobileWorkspaceTab(activeProjectId.value, tab);
  closeMobileContextMenu();
}

const laneActivation = createTapActivation(selectWorkspaceTab, { preserveFocus: true, name: "lane-tab" });

function restoreMobileWorkspaceTab(): void {
  const projectId = activeProjectId.value.trim();
  const tab = readMobileWorkspaceTab(projectId);
  setActiveChatLane(tab);
}

async function refreshVisibleLaneChat(lane: ChatLane): Promise<void> {
  await nextTick();
  if (activeWorkspaceTab.value !== lane) return;
  const chat = lane === "advisor" ? advisorChatRef.value : workerChatRef.value;
  await chat?.refreshAfterVisibility?.();
}

function selectMobileDrawerSection(section: MobileDrawerSection): void {
  mobileDrawerSection.value = section;
  mobileContextMenuOpen.value = false;
  if (section === "settings") closeMobileDrawer();
}

const mobileSettingsTab = ref<"lane-prompts" | "models">("lane-prompts");

function selectMobileDrawerSettings(tab: "lane-prompts" | "models"): void {
  if (!loggedIn.value) return;
  mobileSettingsTab.value = tab;
  selectMobileDrawerSection("settings");
}

type ActionJobItem = {
  id: string;
  project_id: string;
  issue_id: number | null;
  issue_title: string;
  status: "queued" | "running" | "verifying" | "reviewing" | "waiting_merge" | "completed" | "failed" | "blocked" | "cancelled";
  current_step: string | null;
  pr_number: number | null;
  pr_url: string | null;
  error_message: string | null;
  rework_count: number;
  created_at?: number;
  updated_at?: number;
};

type QueueStartResponse = {
  allowed?: boolean;
  reason?: string;
  dequeuedJobId?: string;
};

const actionJobs = ref<ActionJobItem[]>([]);

const actionQueueStatusOrder: Record<ActionJobItem["status"], number> = {
  queued: 50,
  running: 10,
  verifying: 20,
  reviewing: 30,
  waiting_merge: 40,
  completed: 60,
  failed: 70,
  blocked: 45,
  cancelled: 80,
};

const actionQueueJobs = computed(() => {
  return actionJobs.value
    .filter((job) => ["running", "verifying", "reviewing", "waiting_merge", "blocked", "queued"].includes(job.status))
    .slice()
    .sort((left, right) => {
      const statusDelta = actionQueueStatusOrder[left.status] - actionQueueStatusOrder[right.status];
      if (statusDelta !== 0) return statusDelta;
      return (left.created_at ?? 0) - (right.created_at ?? 0);
    });
});

const activeActionJob = computed(() => {
  return actionQueueJobs.value.find((job) => job.status !== "queued") ?? actionQueueJobs.value[0] ?? null;
});

const queuedActionJobsCount = computed(() => {
  return actionJobs.value.filter((j) => j.status === "queued").length;
});

function showActionNotice(message: string): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  apiNotice.value = text;
  window.setTimeout(() => {
    if (apiNotice.value === text) apiNotice.value = null;
  }, 3000);
}

let actionJobsPollTimer: number | null = null;

function ensureActionJobsPolling(): void {
  if (actionJobsPollTimer != null) return;
  const hasActiveJob = actionJobs.value.some((j) =>
    ["running", "verifying", "reviewing", "waiting_merge", "queued"].includes(j.status),
  );
  if (!hasActiveJob) return;
  actionJobsPollTimer = window.setInterval(async () => {
    await loadActionJobs();
    const stillActive = actionJobs.value.some((j) =>
      ["running", "verifying", "reviewing", "waiting_merge", "queued"].includes(j.status),
    );
    if (!stillActive && actionJobsPollTimer != null) {
      clearInterval(actionJobsPollTimer);
      actionJobsPollTimer = null;
    }
  }, 2000);
}

async function loadActionJobs(): Promise<void> {
  const pid = activeProjectId.value.trim();
  if (!pid) return;
  try {
    const list = await api.get<ActionJobItem[]>(`/api/actions/jobs?projectId=${encodeURIComponent(pid)}`);
    if (Array.isArray(list)) {
      actionJobs.value = list;
      ensureActionJobsPolling();
    }
  } catch {
    // best-effort
  }
}

const isStartingQueue = ref(false);

async function triggerStartActionQueue(): Promise<void> {
  const pid = activeProjectId.value.trim();
  if (!pid || isStartingQueue.value) return;
  const activeRunningJob = actionJobs.value.find((j) =>
    ["running", "verifying", "reviewing", "waiting_merge", "blocked"].includes(j.status),
  );
  if (activeRunningJob) {
    const reason = activeRunningJob.status === "blocked"
      ? activeRunningJob.error_message || "任务需要人工处理"
      : "已有活跃任务正在执行中";
    showActionNotice(`启动执行被阻止：${reason} (${activeRunningJob.issue_title || activeRunningJob.id})`);
    return;
  }
  isStartingQueue.value = true;
  const repoPath = resolveActiveWorkspaceRoot() || activeProject.value?.path || "";
  try {
    const res = await api.post<QueueStartResponse>("/api/actions/queue/start", { projectId: pid, repoPath });
    if (res.allowed === false) {
      showActionNotice(`启动执行被阻止：${res.reason || "三点门禁未通过"}`);
    } else if (res.dequeuedJobId) {
      showActionNotice("已启动执行，详细进度将在 Actions 面板中显示。");
    } else {
      showActionNotice("当前没有可启动的排队任务。");
    }
    await loadActionJobs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showActionNotice(`启动执行失败：${message}`);
  } finally {
    isStartingQueue.value = false;
  }
}

async function cancelActionJob(jobId: string): Promise<void> {
  if (!jobId) return;
  const pid = activeProjectId.value.trim();
  const repoPath = resolveActiveWorkspaceRoot() || activeProject.value?.path || "";
  try {
    await api.post(`/api/actions/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId: pid, repoPath });
    await loadActionJobs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showActionNotice(`取消任务失败：${message}`);
  }
}

function toggleMobileContextMenu(): void {
  if (!isMobile.value) return;
  mobileContextMenuOpen.value = !mobileContextMenuOpen.value;
}

function handleMobileContextAction(actionId: MobileContextActionId): void {
  const action = mobileContextActions.value.find((item) => item.id === actionId);
  if (action?.disabled) {
    closeMobileContextMenu();
    return;
  }
  closeMobileContextMenu();
  if (actionId === "resume") {
    closeMobileDrawer();
    openSessionPicker();
    return;
  }
  if (actionId === "new-session") {
    closeMobileDrawer();
    handleLaneNewSession();
    return;
  }
  if (actionId === "create-model") {
    mobileSettingsRef.value?.create();
    return;
  }
  if (actionId === "refresh-models") {
    void mobileSettingsRef.value?.refresh();
    return;
  }
}

function requestProjectSwitchFromMobile(projectId: string): void {
  requestProjectSwitch(projectId);
  if (isMobile.value) closeMobileDrawer();
}

function openProjectDialogFromDrawer(): void {
  if (isMobile.value) closeMobileDrawer();
  openProjectDialog();
}

function closeMobileModule(): void {
  mobileDrawerSection.value = "projects";
  closeMobileDrawer();
}

function onMobileKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  if (mobileContextMenuOpen.value) {
    closeMobileContextMenu();
    return;
  }
  if (mobileDrawerOpen.value) {
    closeMobileDrawer();
  }
}

const mobileDrawerToggleRef = ref<HTMLButtonElement | null>(null);
const mobileDrawerRef = ref<HTMLElement | null>(null);

const DRAWER_SWIPE_EDGE_PX = 28;
const DRAWER_SWIPE_RATIO = 1.4;
// Horizontal travel that takes the axis lock and starts 1:1 tracking.
const DRAWER_DRAG_LOCK_PX = 10;
// Releasing past this share of the drawer width snaps to the far end.
const DRAWER_SNAP_RATIO = 0.35;
// Release velocity (px/ms, i.e. ~500px/s) that snaps regardless of distance.
const DRAWER_FLICK_VELOCITY_PX_PER_MS = 0.5;
// A finger held still before release must not read as a flick.
const DRAWER_FLICK_STALE_MS = 100;
// Slightly longer than the 0.28s snap transition.
const DRAWER_SNAP_SETTLE_MS = 340;
// Lets the leave transition commit before gesture styles are dropped.
const DRAWER_SETTLE_CLEANUP_MS = 60;

type DrawerGesture = {
  mode: "open" | "close";
  startX: number;
  startY: number;
  startTime: number;
  width: number;
  tracking: boolean;
  prevX: number;
  prevTime: number;
  lastX: number;
  lastTime: number;
};

let drawerGesture: DrawerGesture | null = null;
let drawerSettleTimer: ReturnType<typeof setTimeout> | null = null;
let drawerCleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Progress of an in-flight drawer gesture: 0 is fully closed, 1 fully open.
// Non-null keeps the drawer and backdrop rendered under direct style control.
const drawerDragProgress = ref<number | null>(null);
const drawerGestureWidth = ref(0);
const drawerSnapSettling = ref(false);

const drawerGestureStyle = computed<Record<string, string> | undefined>(() => {
  const progress = drawerDragProgress.value;
  if (progress === null || !isMobile.value) return undefined;
  const offset = (progress - 1) * drawerGestureWidth.value;
  return {
    transform: `translateX(${offset}px)`,
    transition: drawerSnapSettling.value ? "transform 0.28s cubic-bezier(0.3, 0.8, 0.4, 1)" : "none",
  };
});

const drawerBackdropGestureStyle = computed<Record<string, string> | undefined>(() => {
  const progress = drawerDragProgress.value;
  if (progress === null || !isMobile.value) return undefined;
  return {
    opacity: String(progress),
    transition: drawerSnapSettling.value ? "opacity 0.28s ease" : "none",
    ...(progress <= 0 ? { pointerEvents: "none" } : {}),
  };
});

function drawerWidthPx(): number {
  const measured = mobileDrawerRef.value?.getBoundingClientRect().width ?? 0;
  if (measured > 0) return measured;
  // .left.mobileDrawer is width: min(360px, 84vw) capped by calc(100vw - 24px).
  const viewportWidth = window.innerWidth;
  return Math.min(360, viewportWidth * 0.84, Math.max(viewportWidth - 24, 1));
}

function clampDrawerProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function resetDrawerGestureStyles(): void {
  drawerDragProgress.value = null;
  drawerSnapSettling.value = false;
  drawerGestureWidth.value = 0;
}

function cancelDrawerGesture(): void {
  drawerGesture = null;
  if (drawerSettleTimer !== null) {
    clearTimeout(drawerSettleTimer);
    drawerSettleTimer = null;
  }
  if (drawerCleanupTimer !== null) {
    clearTimeout(drawerCleanupTimer);
    drawerCleanupTimer = null;
  }
  resetDrawerGestureStyles();
}

function settleDrawerGesture(targetOpen: boolean): void {
  drawerSnapSettling.value = true;
  drawerDragProgress.value = targetOpen ? 1 : 0;
  drawerSettleTimer = setTimeout(() => {
    drawerSettleTimer = null;
    drawerSnapSettling.value = false;
    if (targetOpen) {
      // The open end state matches the stylesheet default, so dropping the
      // inline transform here cannot move the drawer.
      mobileDrawerOpen.value = true;
      resetDrawerGestureStyles();
      return;
    }
    mobileDrawerOpen.value = false;
    // Keep the off-screen inline transform until the leave transition has
    // committed; clearing it in the same frame would flash the drawer open.
    drawerCleanupTimer = setTimeout(() => {
      drawerCleanupTimer = null;
      resetDrawerGestureStyles();
    }, DRAWER_SETTLE_CLEANUP_MS);
  }, DRAWER_SNAP_SETTLE_MS);
}

function readSwipeTouch(ev: TouchEvent): { x: number; y: number } | null {
  if (ev.touches.length !== 1) return null;
  return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
}

function startDrawerGesture(ev: TouchEvent, mode: "open" | "close"): void {
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  drawerGesture = {
    mode,
    startX: touch.x,
    startY: touch.y,
    startTime: ev.timeStamp,
    width: 0,
    tracking: false,
    prevX: touch.x,
    prevTime: ev.timeStamp,
    lastX: touch.x,
    lastTime: ev.timeStamp,
  };
}

function trackDrawerGesture(ev: TouchEvent, direction: 1 | -1): void {
  const gesture = drawerGesture;
  if (!gesture) return;
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  const dx = touch.x - gesture.startX;
  const dy = touch.y - gesture.startY;
  if (!gesture.tracking) {
    // Vertical scrolling always wins over the drawer gesture.
    if (Math.abs(dy) > DRAWER_DRAG_LOCK_PX && Math.abs(dy) > Math.abs(dx) * DRAWER_SWIPE_RATIO) {
      drawerGesture = null;
      return;
    }
    if (!(dx * direction > DRAWER_DRAG_LOCK_PX && Math.abs(dx) > Math.abs(dy) * DRAWER_SWIPE_RATIO)) return;
    gesture.tracking = true;
    gesture.width = drawerWidthPx();
    drawerGestureWidth.value = gesture.width;
  }
  gesture.prevX = gesture.lastX;
  gesture.prevTime = gesture.lastTime;
  gesture.lastX = touch.x;
  gesture.lastTime = ev.timeStamp;
  const progress = gesture.mode === "open" ? dx / gesture.width : 1 + dx / gesture.width;
  drawerDragProgress.value = clampDrawerProgress(progress);
}

function resolveDrawerSnapTarget(mode: "open" | "close", progress: number, velocity: number): boolean {
  if (velocity >= DRAWER_FLICK_VELOCITY_PX_PER_MS) return true;
  if (velocity <= -DRAWER_FLICK_VELOCITY_PX_PER_MS) return false;
  return mode === "open" ? progress >= DRAWER_SNAP_RATIO : progress > 1 - DRAWER_SNAP_RATIO;
}

function finishDrawerGesture(ev: TouchEvent, cancelled: boolean): void {
  const gesture = drawerGesture;
  drawerGesture = null;
  if (!gesture || !gesture.tracking) return;
  if (cancelled) {
    // touchcancel always springs back to the state the drag started from.
    settleDrawerGesture(gesture.mode === "close");
    return;
  }
  const dx = gesture.lastX - gesture.startX;
  const progress = clampDrawerProgress(gesture.mode === "open" ? dx / gesture.width : 1 + dx / gesture.width);
  const trailDt = gesture.lastTime - gesture.prevTime;
  const stale = ev.timeStamp - gesture.lastTime > DRAWER_FLICK_STALE_MS;
  const velocity = stale || trailDt <= 0 ? 0 : (gesture.lastX - gesture.prevX) / trailDt;
  settleDrawerGesture(resolveDrawerSnapTarget(gesture.mode, progress, velocity));
}

function onDrawerEdgeTouchStart(ev: TouchEvent): void {
  if (drawerGesture || drawerSnapSettling.value) return;
  if (!isMobile.value || mobileDrawerOpen.value) return;
  // SVG descendants are Elements too; button taps must not start a competing
  // edge swipe or be interpreted as navigation drags by the parent container.
  if (ev.target instanceof Element && ev.target.closest(".topbar, button, a, input, textarea, select, [role='button']")) return;
  const touch = readSwipeTouch(ev);
  if (!touch || touch.x > DRAWER_SWIPE_EDGE_PX) return;
  startDrawerGesture(ev, "open");
}

function onDrawerEdgeTouchMove(ev: TouchEvent): void {
  if (drawerGesture?.mode !== "open") return;
  trackDrawerGesture(ev, 1);
}

function onDrawerSwipeTouchStart(ev: TouchEvent): void {
  if (drawerGesture || drawerSnapSettling.value) return;
  if (!isMobile.value) return;
  if (projectSwipeOpenId.value !== null) {
    projectSwipeOpenId.value = null;
  }
  if (ev.target instanceof Element && ev.target.closest(".projectNode, .projectSwipeActions")) return;
  startDrawerGesture(ev, "close");
}

function onDrawerSwipeTouchMove(ev: TouchEvent): void {
  if (drawerGesture?.mode !== "close") return;
  trackDrawerGesture(ev, -1);
}

function onDrawerGestureTouchEnd(ev: TouchEvent): void {
  finishDrawerGesture(ev, false);
}

function onDrawerGestureTouchCancel(ev: TouchEvent): void {
  finishDrawerGesture(ev, true);
}

const LANE_SWIPE_RATIO = 1.1;
// Horizontal travel that takes the axis lock and starts 1:1 tracking.
const LANE_DRAG_LOCK_PX = 8;
// Releasing past this share of the viewport width switches to the other lane.
const LANE_SNAP_RATIO = 0.3;
// Release velocity (px/ms, i.e. ~400px/s) that switches regardless of distance.
const LANE_FLICK_VELOCITY_PX_PER_MS = 0.4;
// A finger held still before release must not read as a flick.
const LANE_FLICK_STALE_MS = 100;
// Slightly longer than the 0.36s snap transition.
const LANE_SNAP_SETTLE_MS = 380;
// Touches starting inside horizontally scrollable or editable children keep
// their native behavior instead of switching lanes.
const LANE_SWIPE_IGNORE_SELECTOR = "pre, code, table, input, textarea, select, button, a, [contenteditable]";

type TouchSample = { x: number; time: number };

type LaneGesture = {
  startX: number;
  startY: number;
  startTime: number;
  startLane: ChatLane;
  width: number;
  tracking: boolean;
  samples: TouchSample[];
  lastX: number;
  lastTime: number;
};

let laneGesture: LaneGesture | null = null;
let laneSettleTimer: ReturnType<typeof setTimeout> | null = null;

const lanePanelsRef = ref<HTMLElement | null>(null);
// Track translation in px while a gesture owns the panels; null falls back to
// the stylesheet position driven by the active lane.
const laneTrackOffset = ref<number | null>(null);
const laneDragTracking = ref(false);
const laneSnapSettling = ref(false);

const laneTrackStyle = computed<Record<string, string> | undefined>(() => {
  const offset = laneTrackOffset.value;
  if (offset === null || !isMobile.value) return undefined;
  return {
    transform: `translate3d(${offset}px, 0, 0)`,
    transition: laneSnapSettling.value ? "transform 0.36s cubic-bezier(0.25, 1, 0.5, 1)" : "none",
  };
});

const laneTabGroupStyle = computed<Record<string, string> | undefined>(() => {
  if (!isMobile.value || laneTrackOffset.value === null) return undefined;
  const width = laneGesture?.width || lanePanelWidthPx() || 1;
  const progress = Math.min(1, Math.max(0, -laneTrackOffset.value / width));
  return {
    "--lane-pill-progress": String(progress),
    "--lane-pill-transition": laneSnapSettling.value
      ? "transform 0.36s cubic-bezier(0.25, 1, 0.5, 1)"
      : "none",
  };
});

function lanePanelWidthPx(): number {
  const measured = lanePanelsRef.value?.clientWidth ?? 0;
  if (measured > 0) return measured;
  return window.innerWidth;
}

function clampLaneOffsetWithResistance(offset: number, width: number): number {
  if (offset > 0) {
    // Rubber-band resistance past left edge (Advisor)
    return offset * 0.35;
  }
  if (offset < -width) {
    // Rubber-band resistance past right edge (Worker)
    return -width + (offset + width) * 0.35;
  }
  return offset;
}

function cancelLaneGesture(): void {
  laneGesture = null;
  laneDragTracking.value = false;
  laneSnapSettling.value = false;
  laneTrackOffset.value = null;
  if (laneSettleTimer !== null) {
    clearTimeout(laneSettleTimer);
    laneSettleTimer = null;
  }
}

function settleLaneGesture(target: ChatLane, width: number): void {
  laneSnapSettling.value = true;
  laneTrackOffset.value = target === "worker" ? -width : 0;
  laneSettleTimer = setTimeout(() => {
    laneSettleTimer = null;
    laneSnapSettling.value = false;
    // The stylesheet position matches the settle target, so dropping the
    // inline transform cannot move the track.
    laneTrackOffset.value = null;
    if (target !== activeWorkspaceTab.value) selectWorkspaceTab(target);
  }, LANE_SNAP_SETTLE_MS);
}

function onLaneSwipeTouchStart(ev: TouchEvent): void {
  if (laneGesture || laneSnapSettling.value) return;
  if (!isMobile.value || mobileDrawerOpen.value) return;
  // An in-flight drawer gesture owns the touch sequence.
  if (drawerDragProgress.value !== null || drawerSnapSettling.value) return;
  if (ev.target instanceof Element && ev.target.closest(LANE_SWIPE_IGNORE_SELECTOR)) return;
  const touch = readSwipeTouch(ev);
  // The left edge stays reserved for the drawer edge swipe.
  if (!touch || touch.x <= DRAWER_SWIPE_EDGE_PX) return;
  laneGesture = {
    startX: touch.x,
    startY: touch.y,
    startTime: ev.timeStamp,
    startLane: activeWorkspaceTab.value,
    width: 0,
    tracking: false,
    samples: [{ x: touch.x, time: ev.timeStamp }],
    lastX: touch.x,
    lastTime: ev.timeStamp,
  };
}

function onLaneSwipeTouchMove(ev: TouchEvent): void {
  const gesture = laneGesture;
  if (!gesture) return;
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  const dx = touch.x - gesture.startX;
  const dy = touch.y - gesture.startY;
  if (!gesture.tracking) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX >= LANE_DRAG_LOCK_PX || absY >= LANE_DRAG_LOCK_PX) {
      if (absX >= absY * LANE_SWIPE_RATIO) {
        gesture.tracking = true;
        gesture.width = lanePanelWidthPx();
        laneDragTracking.value = true;
      } else {
        laneGesture = null;
        return;
      }
    } else {
      return;
    }
  }
  gesture.lastX = touch.x;
  gesture.lastTime = ev.timeStamp;
  gesture.samples.push({ x: touch.x, time: ev.timeStamp });
  if (gesture.samples.length > 5) gesture.samples.shift();
  const base = gesture.startLane === "worker" ? -gesture.width : 0;
  laneTrackOffset.value = clampLaneOffsetWithResistance(base + dx, gesture.width);
}

function finishLaneGesture(ev: TouchEvent, cancelled: boolean): void {
  const gesture = laneGesture;
  laneGesture = null;
  laneDragTracking.value = false;
  if (!gesture || !gesture.tracking) return;
  const width = gesture.width;
  if (cancelled) {
    // touchcancel always springs back to the lane the drag started from.
    settleLaneGesture(gesture.startLane, width);
    return;
  }
  const base = gesture.startLane === "worker" ? -width : 0;
  const position = clampLaneOffsetWithResistance(base + (gesture.lastX - gesture.startX), width);
  // Calculate flick velocity over a rolling window (up to ~80ms) to avoid single-frame noise
  let velocity = 0;
  const stale = ev.timeStamp - gesture.lastTime > LANE_FLICK_STALE_MS;
  if (!stale && gesture.samples.length >= 2) {
    const newest = gesture.samples[gesture.samples.length - 1]!;
    const earliest = gesture.samples[0]!;
    const dt = newest.time - earliest.time;
    if (dt > 0) {
      velocity = (newest.x - earliest.x) / dt;
    }
  }
  let target: ChatLane;
  if (velocity <= -LANE_FLICK_VELOCITY_PX_PER_MS) {
    target = "worker";
  } else if (velocity >= LANE_FLICK_VELOCITY_PX_PER_MS) {
    target = "advisor";
  } else if (position > 0) {
    target = "advisor";
  } else if (position < -width) {
    target = "worker";
  } else {
    const moved = gesture.startLane === "advisor" ? -position / width : (position + width) / width;
    const otherLane: ChatLane = gesture.startLane === "advisor" ? "worker" : "advisor";
    target = moved > LANE_SNAP_RATIO ? otherLane : gesture.startLane;
  }
  settleLaneGesture(target, width);
}

function onLaneSwipeTouchEnd(ev: TouchEvent): void {
  finishLaneGesture(ev, false);
}

function onLaneSwipeTouchCancel(ev: TouchEvent): void {
  finishLaneGesture(ev, true);
}

function onDrawerKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Tab") return;
  const drawer = mobileDrawerRef.value;
  if (!drawer) return;
  const focusable = Array.from(
    drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !drawer.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !drawer.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}

watch(mobileDrawerOpen, async (open) => {
  if (typeof document === "undefined") return;
  document.body.style.overflow = open && isMobile.value ? "hidden" : "";
  if (!isMobile.value) return;
  await nextTick();
  if (open) {
    mobileDrawerRef.value
      ?.querySelector<HTMLElement>('[data-testid="mobile-drawer-section-projects"]')
      ?.focus();
  } else {
    mobileDrawerToggleRef.value?.focus();
  }
});

watch(isMobile, (mobile) => {
  if (mobile) {
    if (activeProjectId.value.trim()) restoreMobileWorkspaceTab();
    return;
  }
  closeMobileDrawer();
  cancelLaneGesture();
}, { immediate: true });

watch(activeProjectId, (projectId, previousProjectId) => {
  if (!projectId.trim() || projectId === previousProjectId) return;
  if (isMobile.value) {
    restoreMobileWorkspaceTab();
    return;
  }
  if (previousProjectId?.trim()) setActiveChatLane("worker");
});

watch(activeWorkspaceTab, (lane) => {
  void refreshVisibleLaneChat(lane);
}, { flush: "post" });

// Drafts live only in memory; iOS can kill the PWA (and the crash recovery
// reload drops them too). Stash on pagehide and restore on next mount.
const DRAFT_STASH_KEY = "ADS_WEB_DRAFT_STASH";

watch(accountGeneration, () => {
  settingsOpen.value = false;
  mobileDrawerSection.value = "projects";
  closeMobileDrawer();
  try {
    sessionStorage.removeItem(DRAFT_STASH_KEY);
    purgeLatestPromptPreferences();
  } catch { /* Private input must not be restored across accounts. */ }
}, { flush: "sync" });

function stashComposerDrafts(): void {
  try {
    const worker = String(workerComposerDraft.value ?? "");
    const advisor = String(advisorComposerDraft.value ?? "");
    if (!worker && !advisor) {
      sessionStorage.removeItem(DRAFT_STASH_KEY);
      return;
    }
    sessionStorage.setItem(
      DRAFT_STASH_KEY,
      JSON.stringify({ projectId: activeProjectId.value, worker, advisor }),
    );
  } catch {
    // ignore
  }
}

function restoreStashedComposerDrafts(): void {
  try {
    const raw = sessionStorage.getItem(DRAFT_STASH_KEY);
    if (!raw) return;
    sessionStorage.removeItem(DRAFT_STASH_KEY);
    const stash = JSON.parse(raw) as { projectId?: unknown; worker?: unknown; advisor?: unknown };
    if (String(stash.projectId ?? "") !== activeProjectId.value) return;
    const worker = String(stash.worker ?? "");
    const advisor = String(stash.advisor ?? "");
    if (worker && !workerComposerDraft.value) workerComposerDraft.value = worker;
    if (advisor && !advisorComposerDraft.value) advisorComposerDraft.value = advisor;
  } catch {
    // ignore
  }
}

onMounted(() => {
  window.addEventListener("keydown", onMobileKeydown);
  window.addEventListener("pagehide", stashComposerDrafts);
  restoreStashedComposerDrafts();
  (window as any).__ADS_ON_ACTION_JOB_UPDATED__ = () => {
    void loadActionJobs();
  };
  void loadActionJobs();
});

watch(activeProjectId, () => {
  void loadActionJobs();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onMobileKeydown);
  window.removeEventListener("pagehide", stashComposerDrafts);
  if (actionJobsPollTimer != null) {
    clearInterval(actionJobsPollTimer);
    actionJobsPollTimer = null;
  }
  if ((window as any).__ADS_ON_ACTION_JOB_UPDATED__) {
    delete (window as any).__ADS_ON_ACTION_JOB_UPDATED__;
  }
  cancelDrawerGesture();
  cancelLaneGesture();
  cancelProjectLongPress();
  if (projectSwipeClickResetTimer !== null) clearTimeout(projectSwipeClickResetTimer);
  document.body.style.overflow = "";
});

const {
  draggingProjectId,
  dropTargetProjectId,
  dropTargetPosition,
  projectRowKey,
  onProjectRowClick,
  onProjectRowPointerDown,
  onProjectRowPointerUp,
  onProjectRowPointerCancel,
  canRemoveProject,
  removeProject: handleRemoveProject,
  onProjectDragStart,
  onProjectDragEnd,
  onProjectDragOver,
  onProjectDrop,
} = useProjectSidebar({
  projects,
  getRuntime,
  getAdvisorRuntime,
  runtimeProjectInProgress,
  requestProjectSwitch: requestProjectSwitchFromMobile,
  reorderProjects,
  removeProject,
});

type ProjectLike = {
  id: string;
  name?: string;
  branch?: string;
  path?: string;
};

const PROJECT_ROW_ACTIONS_WIDTH_PX = 76;
const PROJECT_ROW_SWIPE_THRESHOLD_PX = 8;
const PROJECT_ROW_LONG_PRESS_MS = 500;

const actionSheetProjectId = ref<string | null>(null);

let projectTouchStartX = 0;
let projectTouchStartY = 0;
let projectTouchStartOffset = 0;
let projectTouchAxis: "horizontal" | "vertical" | null = null;
let projectTouchMoved = false;
let suppressNextProjectRowClick = false;
let projectSwipeClickResetTimer: ReturnType<typeof setTimeout> | null = null;
let projectLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let projectLongPressFired = false;

const actionSheetProject = computed(() => {
  const id = actionSheetProjectId.value;
  if (!id) return null;
  return projects.value.find((p) => p.id === id) ?? null;
});

function openProjectActionSheet(p: ProjectLike): void {
  projectSwipeOpenId.value = null;
  activeProjectSwipeId.value = null;
  actionSheetProjectId.value = p.id;
}

function closeProjectActionSheet(): void {
  actionSheetProjectId.value = null;
}

function cancelProjectLongPress(): void {
  if (projectLongPressTimer !== null) {
    clearTimeout(projectLongPressTimer);
    projectLongPressTimer = null;
  }
}

function projectSwipeOffset(projectId: string): number {
  if (activeProjectSwipeId.value === projectId) {
    return activeProjectSwipeOffset.value;
  }
  if (projectSwipeOpenId.value === projectId) {
    return -PROJECT_ROW_ACTIONS_WIDTH_PX;
  }
  return 0;
}

function isProjectSwipeActionVisible(projectId: string): boolean {
  return projectSwipeOffset(projectId) <= -PROJECT_ROW_ACTIONS_WIDTH_PX / 2;
}

function suppressRowClickAfterProjectSwipe(): void {
  suppressNextProjectRowClick = true;
  if (projectSwipeClickResetTimer !== null) clearTimeout(projectSwipeClickResetTimer);
  projectSwipeClickResetTimer = setTimeout(() => {
    suppressNextProjectRowClick = false;
    projectSwipeClickResetTimer = null;
  }, 0);
}

function handleProjectLongPress(p: ProjectLike): void {
  projectLongPressTimer = null;
  projectLongPressFired = true;
  projectTouchAxis = null;
  projectTouchMoved = false;
  activeProjectSwipeOffset.value = 0;
  openProjectActionSheet(p);
}

function handleProjectTouchStart(p: ProjectLike, event: TouchEvent): void {
  if (event.touches.length !== 1) return;
  if (projectSwipeOpenId.value !== null && projectSwipeOpenId.value !== p.id) {
    projectSwipeOpenId.value = null;
  }
  const touch = event.touches[0];
  if (!touch) return;
  projectTouchStartX = touch.clientX;
  projectTouchStartY = touch.clientY;
  projectTouchStartOffset = projectSwipeOpenId.value === p.id ? -PROJECT_ROW_ACTIONS_WIDTH_PX : 0;
  projectTouchAxis = null;
  projectTouchMoved = false;
  projectLongPressFired = false;
  cancelProjectLongPress();
  projectLongPressTimer = setTimeout(() => {
    handleProjectLongPress(p);
  }, PROJECT_ROW_LONG_PRESS_MS);
}

function handleProjectTouchMove(projectId: string, event: TouchEvent): void {
  if (projectLongPressFired || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - projectTouchStartX;
  const dy = touch.clientY - projectTouchStartY;
  if (Math.hypot(dx, dy) > PROJECT_ROW_SWIPE_THRESHOLD_PX) {
    cancelProjectLongPress();
  }
  if (projectTouchAxis === null) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX >= PROJECT_ROW_SWIPE_THRESHOLD_PX || absY >= PROJECT_ROW_SWIPE_THRESHOLD_PX) {
      if (absX >= absY && projectId !== "default") {
        projectTouchAxis = "horizontal";
        activeProjectSwipeId.value = projectId;
      } else {
        projectTouchAxis = "vertical";
        activeProjectSwipeId.value = null;
        activeProjectSwipeOffset.value = 0;
      }
    }
  }
  if (projectTouchAxis !== "horizontal") return;
  projectTouchMoved = true;
  event.preventDefault();
  const rawOffset = projectTouchStartOffset + dx;
  activeProjectSwipeOffset.value = Math.max(-PROJECT_ROW_ACTIONS_WIDTH_PX, Math.min(0, rawOffset));
}

function finishProjectTouch(projectId: string, event: TouchEvent, cancelled = false): void {
  cancelProjectLongPress();
  if (projectLongPressFired) {
    projectLongPressFired = false;
    return;
  }
  if (projectTouchAxis === "horizontal") {
    suppressRowClickAfterProjectSwipe();
    if (!cancelled && activeProjectSwipeOffset.value < -PROJECT_ROW_ACTIONS_WIDTH_PX / 2) {
      projectSwipeOpenId.value = projectId;
    } else {
      projectSwipeOpenId.value = null;
    }
  }
  activeProjectSwipeId.value = null;
  activeProjectSwipeOffset.value = 0;
  projectTouchAxis = null;
  projectTouchMoved = false;
}

function handleProjectRowContextMenu(p: ProjectLike, event: MouseEvent): void {
  if (isMobile.value) {
    event.preventDefault();
    openProjectActionSheet(p);
  }
}

function handleProjectRowClick(p: ProjectLike): void {
  if (suppressNextProjectRowClick) return;
  if (projectSwipeOpenId.value !== null) {
    closeProjectSwipe();
    return;
  }
  onProjectRowClick(p.id);
}

async function handleSwipeRemove(p: ProjectLike): Promise<void> {
  closeProjectSwipe();
  if (canRemoveProject(p.id)) {
    await handleRemoveProject(p.id);
  }
}

function handleActionSheetSwitch(): void {
  const p = actionSheetProject.value;
  closeProjectActionSheet();
  if (p) {
    requestProjectSwitchFromMobile(p.id);
  }
}

async function handleActionSheetRemove(): Promise<void> {
  const p = actionSheetProject.value;
  closeProjectActionSheet();
  if (p && canRemoveProject(p.id)) {
    await handleRemoveProject(p.id);
  }
}
function openSettings(): void {
  if (!loggedIn.value) return;
  if (isMobile.value) {
    openMobileDrawer("settings");
    return;
  }
  settingsOpen.value = true;
}

function closeSettings(): void {
  settingsOpen.value = false;
}

async function onSettingsChanged(): Promise<void> {
  try {
    await loadModels();
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
}

const runningTaskCount = computed(() => 0);

const disconnectedStatusMessage = "连接已断开，正在重连…";

const workerConnectionStatus = computed(() => {
  if (!loggedIn.value) return { kind: "info" as const, message: "Cached conversation: read-only until sign-in." };
  const laneStatus = workerLaneStatus.value;
  if (!connected.value && laneStatus?.kind === "progress") return laneStatus;
  const error = String(wsError.value ?? "").trim();
  if (error) return { kind: "error" as const, message: error };
  if (!connected.value) return { kind: "disconnected" as const, message: disconnectedStatusMessage };
  return laneStatus;
});

const advisorConnectionStatus = computed(() => {
  if (!loggedIn.value) return { kind: "info" as const, message: "Cached conversation: read-only until sign-in." };
  const laneStatus = advisorLaneStatus.value;
  if (!advisorConnected.value && laneStatus?.kind === "progress") return laneStatus;
  const error = String(activeAdvisorRuntime.value.wsError.value ?? "").trim();
  if (error) return { kind: "error" as const, message: error };
  if (!advisorConnected.value) return { kind: "disconnected" as const, message: disconnectedStatusMessage };
  return laneStatus;
});

</script>

<template>
  <ExecuteBlockFixture v-if="isExecuteBlockFixture" />
  <LoginGate
    v-if="!isExecuteBlockFixture && !loggedIn"
    v-show="!cachedTranscriptAvailable"
    @logged-in="handleLoggedIn"
    @auth-required="handleAuthRequired"
  />
  <div
    v-if="!isExecuteBlockFixture && (loggedIn || cachedTranscriptAvailable)"
    class="app"
    :data-cache-read-only="!loggedIn"
    :data-active-lane="activeWorkspaceTab"
    :data-project-id="activeProjectId"
    :data-worker-message-count="messages.length"
    :data-advisor-message-count="advisorMessages.length"
    :data-worker-panel-key="workerPanelKey"
    :data-advisor-panel-key="advisorPanelKey"
    @click="closeMobileContextMenu"
    @touchstart.passive="onDrawerEdgeTouchStart"
    @touchmove.passive="onDrawerEdgeTouchMove"
    @touchend="onDrawerGestureTouchEnd"
    @touchcancel="onDrawerGestureTouchCancel"
  >
    <header class="topbar">
      <button
        v-if="isMobile"
        ref="mobileDrawerToggleRef"
        type="button"
        class="mobileMenuBtn"
        :title="mobileDrawerOpen ? '关闭导航' : '打开导航'"
        :aria-label="mobileDrawerOpen ? '关闭导航' : '打开导航'"
        :aria-expanded="mobileDrawerOpen"
        data-testid="mobile-drawer-toggle"
        @pointerdown.stop="drawerActivation.onPointerDown($event, true)"
        @pointermove.stop="drawerActivation.onPointerMove"
        @pointercancel.stop="drawerActivation.onPointerCancel"
        @pointerup.stop="drawerActivation.onPointerUp"
        @click.stop="drawerActivation.onClick($event, true)"
      >
        <svg class="mobileMenuIcon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect x="2" y="5.5" width="16" height="2.2" rx="1.1" />
          <rect x="2" y="12.3" width="10" height="2.2" rx="1.1" />
        </svg>
      </button>
      <div class="topbarMain">
        <div v-if="isMobile" class="mobileContextTitle" :title="mobileContextTitle">
          {{ mobileContextTitle }}
        </div>
      </div>
      <div class="right">
        <div v-if="!isMobile" class="laneSessionActions">
          <button
            v-if="activeLaneHasResume && loggedIn"
            class="laneTabIconBtn"
            type="button"
            title="Resume session"
            data-testid="lane-resume-thread"
            @click.stop="openSessionPicker"
          >
            <el-icon :size="15" aria-hidden="true"><Clock /></el-icon>
          </button>
          <button
            class="laneTabIconBtn"
            type="button"
            title="New session"
            :disabled="!loggedIn || activeLaneBusy || activeLaneNewSessionBlocked"
            data-testid="lane-new-session"
            @click.stop="handleLaneNewSession"
          >
            <el-icon :size="16" aria-hidden="true"><ChatDotRound /></el-icon>
          </button>
          <button
            class="laneTabIconBtn"
            type="button"
            title="Clear session"
            :disabled="!loggedIn || activeLaneBusy"
            data-testid="lane-clear-chat"
            @click.stop="handleLaneClearChat"
          >
            <el-icon :size="15" aria-hidden="true"><Delete /></el-icon>
          </button>
        </div>
        <button
          v-if="!isMobile"
          type="button"
          class="topbarIconBtn"
          title="系统设置"
          aria-label="系统设置"
          data-testid="settings-open"
          :disabled="!loggedIn"
          @click="openSettings"
        >
          <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
        </button>
        <button
          v-if="isMobile && loggedIn && mobileContextActions.length"
          type="button"
          class="topbarIconBtn mobileContextMenuBtn"
          title="当前模块操作"
          aria-label="当前模块操作"
          :aria-expanded="mobileContextMenuOpen"
          data-testid="mobile-context-menu-toggle"
          @click.stop="toggleMobileContextMenu"
        >
          <el-icon :size="18" aria-hidden="true"><MoreFilled /></el-icon>
        </button>
      </div>
      <div
        v-if="isMobile && mobileContextMenuOpen"
        class="mobileContextMenu"
        role="menu"
        :aria-label="mobileContextMenuTitle"
        data-testid="mobile-context-menu"
        @click.stop
      >
        <button
          v-for="action in mobileContextActions"
          :key="action.id"
          type="button"
          class="mobileContextAction"
          role="menuitem"
          :disabled="action.disabled"
          :data-testid="`mobile-context-action-${action.id}`"
          @click="handleMobileContextAction(action.id)"
        >
          <span>{{ action.label }}</span>
        </button>
      </div>
    </header>

    <main class="layout">
      <Transition name="mobile-fade">
        <div
          v-if="isMobile && (mobileDrawerOpen || drawerDragProgress !== null)"
          class="mobileDrawerBackdrop"
          :style="drawerBackdropGestureStyle"
          data-testid="mobile-drawer-backdrop"
          @click="closeMobileDrawer"
        />
      </Transition>
      <Transition name="mobile-drawer">
        <aside
          v-if="!isMobile || mobileDrawerOpen || drawerDragProgress !== null"
          ref="mobileDrawerRef"
          class="left"
          :class="{ mobileDrawer: isMobile }"
          :style="drawerGestureStyle"
          data-testid="mobile-drawer"
          @touchstart.passive="onDrawerSwipeTouchStart"
          @touchmove.passive="onDrawerSwipeTouchMove"
          @keydown="onDrawerKeydown"
        >
        <nav v-if="isMobile" class="mobileDrawerNav" aria-label="导航模块">
          <button
            type="button"
            class="mobileDrawerNavItem"
            :class="{ active: mobileDrawerSection === 'projects' }"
            :aria-current="mobileDrawerSection === 'projects' ? 'page' : undefined"
            data-testid="mobile-drawer-section-projects"
            @click="selectMobileDrawerSection('projects')"
          >
            <el-icon :size="16" aria-hidden="true"><Document /></el-icon>
            <span>项目</span>
          </button>
          <button
            type="button"
            class="mobileDrawerNavItem mobileDrawerNavItem--link mobileDrawerNavItem--divider"
            :class="{ active: mobileDrawerSection === 'settings' && mobileSettingsTab === 'lane-prompts' }"
            data-testid="mobile-drawer-section-prompts"
            :disabled="!loggedIn"
            @click="selectMobileDrawerSettings('lane-prompts')"
          >
            <el-icon :size="16" aria-hidden="true"><ChatDotRound /></el-icon>
            <span>角色指令</span>
            <el-icon class="mobileDrawerNavChevron" :size="14" aria-hidden="true"><ArrowRight /></el-icon>
          </button>
          <button
            type="button"
            class="mobileDrawerNavItem mobileDrawerNavItem--link"
            :class="{ active: mobileDrawerSection === 'settings' && mobileSettingsTab === 'models' }"
            data-testid="mobile-drawer-section-models"
            :disabled="!loggedIn"
            @click="selectMobileDrawerSettings('models')"
          >
            <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
            <span>模型配置</span>
            <el-icon class="mobileDrawerNavChevron" :size="14" aria-hidden="true"><ArrowRight /></el-icon>
          </button>
        </nav>

        <div v-if="!isMobile || mobileDrawerSection === 'projects'" class="projectTree">
          <div class="projectTreeHeader">
            <div class="projectTreeTitle">项目</div>
            <div class="projectTreeHeaderActions">
              <button type="button" class="projectAdd" title="添加项目" :disabled="!loggedIn" @click="openProjectDialogFromDrawer"><el-icon :size="16" aria-hidden="true" class="icon"><CirclePlus /></el-icon></button>
            </div>
          </div>

          <div
            v-for="p in projects"
            :key="projectRowKey(p)"
            class="projectNode"
            :class="{
              active: p.id === activeProjectId,
              swiping: activeProjectSwipeId === p.id,
            }"
          >
            <div
              v-if="loggedIn && p.id !== 'default'"
              class="projectSwipeActions"
              :class="{ actionVisible: isProjectSwipeActionVisible(p.id) }"
            >
              <button
                type="button"
                class="projectSwipeAction delete"
                :disabled="!canRemoveProject(p.id)"
                :tabindex="projectSwipeOpenId === p.id ? 0 : -1"
                :data-testid="`project-swipe-remove-${p.id}`"
                aria-label="从列表移除"
                @click.stop.prevent="handleSwipeRemove(p)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <span>移除</span>
              </button>
            </div>
            <button
              type="button"
              class="projectRow"
              :class="{
                isDragging: draggingProjectId === p.id,
                dropBefore: dropTargetProjectId === p.id && dropTargetPosition === 'before',
                dropAfter: dropTargetProjectId === p.id && dropTargetPosition === 'after',
              }"
              :style="{ transform: `translateX(${projectSwipeOffset(p.id)}px)` }"
              :title="p.name"
              @pointerdown="(ev) => loggedIn && onProjectRowPointerDown(ev, p.id)"
              @pointerup="(ev) => onProjectRowPointerUp(ev, p.id)"
              @pointercancel="onProjectRowPointerCancel"
              @click="handleProjectRowClick(p)"
              @dragover="(ev) => onProjectDragOver(ev, p.id)"
              @drop="(ev) => loggedIn && onProjectDrop(ev, p.id)"
              @contextmenu="handleProjectRowContextMenu(p, $event)"
              @touchstart.passive="handleProjectTouchStart(p, $event)"
              @touchmove="handleProjectTouchMove(p.id, $event)"
              @touchend="finishProjectTouch(p.id, $event)"
              @touchcancel="finishProjectTouch(p.id, $event, true)"
            >
              <span
                class="projectStatus"
                :class="projectStatusClass(p.id)"
                :title="projectStatusTitle(p.id)"
                :data-testid="`project-status-${p.id}`"
              />
              <span class="projectText">
                <span class="projectName">{{ p.name }}</span>
                <span class="projectBranch">{{ formatProjectBranch(p.branch) }}</span>
              </span>
              <span class="projectRowActions">
                <span v-if="!isMobile && p.id === 'default'" class="projectDragSpacer" aria-hidden="true" />
                <span
                  v-else-if="!isMobile && loggedIn"
                  class="projectDragHandle"
                  draggable="true"
                  title="Drag to reorder"
                  @dragstart="(ev) => onProjectDragStart(ev, p.id)"
                  @dragend="onProjectDragEnd"
                  @click.stop.prevent
                  @mousedown.stop
                >
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M4 6h12v2H4V6zm0 5h12v2H4v-2zm0 5h12v2H4v-2z" />
                  </svg>
                </span>
              </span>
            </button>
            </div>
        </div>
        <footer class="drawerFooter" data-testid="drawer-footer">
          <span class="drawerBrandTitle">ADS</span>
          <span class="drawerBrandVersion">v{{ appVersion }}</span>
        </footer>
        </aside>
      </Transition>

      <section v-if="isMobile && mobileDrawerSection !== 'projects'" class="mobileMainPanel">
        <ModelManager
          v-if="mobileDrawerSection === 'settings'"
          :key="mobileSettingsTab"
          ref="mobileSettingsRef"
          :api="api"
          :initial-tab="mobileSettingsTab"
          :show-header="false"
          :show-tabs="false"
          @close="closeMobileModule"
          @changed="onSettingsChanged"
        />
      </section>

      <section v-if="!isMobile || mobileDrawerSection === 'projects'" class="chatShell">
        <div class="laneTabs" data-testid="chat-control-surface">
          <div class="laneTabGroup" :style="laneTabGroupStyle" role="tablist" aria-label="切换工作区">
            <template v-for="tab in workspaceTabs" :key="tab.id">
              <button
                :id="`lane-tab-${tab.id}`"
                type="button"
                class="laneTab"
                :class="{ active: activeWorkspaceTab === tab.id }"
                role="tab"
                :aria-selected="activeWorkspaceTab === tab.id"
                :aria-controls="`lane-panel-${tab.id}`"
                :data-testid="`lane-tab-${tab.id}`"
                @pointerdown="laneActivation.onPointerDown($event, tab.id)"
                @pointermove="laneActivation.onPointerMove"
                @pointercancel="laneActivation.onPointerCancel"
                @pointerup="laneActivation.onPointerUp"
                @click="laneActivation.onClick($event, tab.id)"
              >
              <span
                class="laneTabStatusDot"
                :class="[
                  isLaneConnected(tab.id, { advisor: advisorConnected, worker: connected })
                    ? 'laneTabStatusDot--connected'
                    : 'laneTabStatusDot--disconnected',
                  (tab.id === 'advisor' ? advisorBusy : agentBusy)
                    ? (tab.id === 'advisor' ? 'laneTabStatusDot--busy-advisor' : 'laneTabStatusDot--busy-worker')
                    : '',
                ]"
               :data-testid="`lane-tab-status-${tab.id}`"
                aria-hidden="true"
              />
              <span class="laneTabLabel">{{ tab.label }}</span>
              </button>
            </template>
          </div>
          <div class="laneModelControls" data-testid="lane-model-controls">
            <MainChatModelSelectors
              :connected="activeLaneConnected"
              :busy="activeLaneBusy"
              :input-locked="!loggedIn || activeLaneInputLocked"
              :agents="activeLaneAgents"
              :active-agent-id="activeLaneActiveAgentId"
              :models="models"
              :model-id="activeLaneModelId"
              :model-reasoning-effort="activeLaneModelReasoningEffort"
              @switch-agent="handleActiveLaneSwitchAgent"
              @set-model="handleActiveLaneSetModel"
              @set-reasoning-effort="handleActiveLaneSetReasoningEffort"
            />
          </div>
        </div>

        <div
          ref="lanePanelsRef"
          class="lanePanels"
          @touchstart.passive="onLaneSwipeTouchStart"
          @touchmove.passive="onLaneSwipeTouchMove"
          @touchend="onLaneSwipeTouchEnd"
          @touchcancel="onLaneSwipeTouchCancel"
        >
          <div
            class="lanePanelsTrack"
            :class="{ 'lanePanelsTrack--worker': activeWorkspaceTab === 'worker', 'lanePanelsTrack--dragging': laneDragTracking }"
            :style="laneTrackStyle"
          >
            <section
              id="lane-panel-advisor"
              class="lanePanel"
              :class="{ 'lanePanel--inactive': activeWorkspaceTab !== 'advisor' }"
              :style="!isMobile && activeWorkspaceTab !== 'advisor' ? { display: 'none' } : undefined"
              role="tabpanel"
              aria-labelledby="lane-tab-advisor"
              :aria-hidden="activeWorkspaceTab === 'advisor' ? undefined : 'true'"
              :inert="activeWorkspaceTab !== 'advisor' ? true : undefined"
              data-testid="lane-panel-advisor"
              :data-message-count="advisorMessages.length"
              :data-panel-key="`${advisorPanelKey}:${errorRecoveryGeneration}`"
            >
              <MainChatView
                ref="advisorChatRef"
                :key="`${advisorPanelKey}:${errorRecoveryGeneration}:${accountGeneration}`"
                class="chatHost chatHost--advisor"
                :messages="advisorMessages"
                :viewport="activeAdvisorRuntime.transcriptViewport?.value"
                :viewport-scope-key="advisorViewportScopeKey"
                :draft="advisorComposerDraft"
                :latest-prompt-key="advisorChatKey"
                :queued-prompts="advisorQueuedPrompts"
                :pending-images="advisorPendingImages"
                :connected="advisorConnected"
                :busy="advisorBusy"
                :input-locked="!loggedIn || advisorInputLocked"
                :workspace-root="resolveActiveWorkspaceRoot()"
                :connection-status-kind="advisorConnectionStatus?.kind ?? null"
                :connection-status-message="advisorConnectionStatus?.message ?? null"
                :thread-warning="advisorThreadWarning"
                @send="sendAdvisorPrompt"
                @update:draft="advisorComposerDraft = $event"
                @update:viewport-scope="handleAdvisorViewportScope"
                @update:viewport="handleAdvisorViewport"
                @interrupt="interruptAdvisor"
                @addImages="addAdvisorPendingImages"
                @clearImages="clearAdvisorPendingImages"
                @removeImage="removeAdvisorPendingImage"
                @removeQueued="removeAdvisorQueuedPrompt"
                @retryQueued="retryAdvisorQueuedPrompt"
              />
            </section>

            <section
              id="lane-panel-worker"
              class="lanePanel"
              :class="{ 'lanePanel--inactive': activeWorkspaceTab !== 'worker' }"
              :style="!isMobile && activeWorkspaceTab !== 'worker' ? { display: 'none' } : undefined"
              role="tabpanel"
              aria-labelledby="lane-tab-worker"
              :aria-hidden="activeWorkspaceTab === 'worker' ? undefined : 'true'"
              :inert="activeWorkspaceTab !== 'worker' ? true : undefined"
              data-testid="lane-panel-worker"
              :data-message-count="messages.length"
              :data-panel-key="`${workerPanelKey}:${errorRecoveryGeneration}`"
            >
              <div v-if="actionQueueJobs.length" class="actionsJobBanner actionsQueue" data-testid="actions-job-banner">
                <div class="actionsQueueHeader">
                  <span class="actionsQueueTitle">Actions 队列</span>
                  <span v-if="queuedActionJobsCount > 0" class="actionsJobQueueCountBadge" data-testid="actions-queue-count-badge">
                    队列中 {{ queuedActionJobsCount }} 个任务
                  </span>
                </div>
                <div class="actionsQueueRows">
                  <div
                    v-for="job in actionQueueJobs"
                    :key="job.id"
                    class="actionsQueueRow"
                    :class="{ 'actionsQueueRow--active': job.id === activeActionJob?.id }"
                    data-testid="actions-queue-row"
                  >
                    <span class="actionsJobBadge" :class="`actionsJobBadge--${job.status}`">
                      {{ job.status.toUpperCase() }}
                    </span>
                    <span class="actionsJobTitle">
                      {{ job.issue_id ? `#${job.issue_id}: ` : '' }}{{ job.issue_title }}
                    </span>
                  </div>
                </div>
                <div class="actionsJobActions">
                  <button
                    v-if="activeActionJob.status === 'queued'"
                    type="button"
                    class="btnActionStart"
                    :disabled="isStartingQueue"
                    data-testid="btn-action-start"
                    @click="triggerStartActionQueue"
                  >
                    {{ isStartingQueue ? '启动中...' : '▶ 启动执行' }}
                  </button>
                  <button
                    v-if="['queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'blocked'].includes(activeActionJob.status)"
                    type="button"
                    class="btnActionCancel"
                    data-testid="btn-action-cancel"
                    @click="cancelActionJob(activeActionJob.id)"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <MainChatView
                ref="workerChatRef"
                :key="`${workerPanelKey}:${errorRecoveryGeneration}:${accountGeneration}`"
                class="chatHost"
                :messages="messages"
                :viewport="activeRuntime.transcriptViewport?.value"
                :viewport-scope-key="workerViewportScopeKey"
                :draft="workerComposerDraft"
                :latest-prompt-key="workerLatestPromptKey"
                :queued-prompts="workerQueuedPrompts"
                :pending-images="pendingImages"
                :connected="connected"
                :busy="agentBusy"
                :input-locked="!loggedIn || workerInputLocked"
                :workspace-root="resolveActiveWorkspaceRoot()"
                :running-task-count="runningTaskCount"
                :connection-status-kind="workerConnectionStatus?.kind ?? null"
                :connection-status-message="workerConnectionStatus?.message ?? null"
                :thread-warning="workerThreadWarning"
                @send="sendMainPrompt"
                @retry-message="loggedIn && retryPrompt($event)"
                @update:draft="workerComposerDraft = $event"
                @update:viewport-scope="handleWorkerViewportScope"
                @update:viewport="handleWorkerViewport"
                @interrupt="interruptActive"
                @clear="clearActiveChat"
                @addImages="addPendingImages"
                @clearImages="clearPendingImages"
                @removeImage="removePendingImage"
                @removeQueued="removeQueuedPrompt"
                @retryQueued="retryQueuedPrompt"
              />
            </section>
          </div>
        </div>
      </section>
    </main>

    <div v-if="apiNotice" class="noticeToast" role="status" aria-live="polite">
      <span class="noticeToastText">{{ apiNotice }}</span>
    </div>

    <DraggableModal v-if="settingsOpen" card-variant="large" @close="closeSettings">
      <ModelManager
        :api="api"
        initial-tab="lane-prompts"
        @close="closeSettings"
        @changed="onSettingsChanged"
      />
    </DraggableModal>

    <DraggableModal v-if="sessionPickerOpen" card-variant="large" @close="closeSessionPicker">
      <SessionResumePicker
        :sessions="resumableSessions"
        :busy="resumableSessionsBusy"
        :error="resumableSessionsError"
        :hidden="resumableSessionsHidden"
        :next-cursor="resumableSessionsNextCursor"
        :agent-id="workerActiveAgentId"
        :disabled="activeLaneBusy || resumeThreadBlocked"
        :disabled-reason="sessionResumeDisabledReason"
        @close="closeSessionPicker"
        @refresh="refreshResumableSessions"
        @load-more="loadMoreResumableSessions"
        @resume="resumeSelectedSession"
      />
    </DraggableModal>

    <div v-if="projectDialogOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="closeProjectDialog">
      <div class="modalCard">
        <div class="modalTitle">添加项目</div>
        <div class="modalDesc">每个项目会对应一个独立会话（session），对话和工作目录互不串。</div>

        <div class="modalForm">
          <label class="modalLabel" for="project-path">项目目录（可输入名称或完整路径）</label>
          <input
            id="project-path"
            v-model="projectDialogPath"
            ref="projectPathEl"
            class="modalInput"
            placeholder="输入目录名或完整路径，如: ads"
            list="project-subdirs"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter.prevent="focusProjectName"
            @blur="validateProjectDialogPath()"
            @input="onProjectDialogPathInput"
          />
          <datalist id="project-subdirs">
            <option v-for="d in projectDialogSubdirs" :key="d" :value="d" />
          </datalist>
          <div class="modalHintRow">
            <div
              v-if="projectDialogPathStatus !== 'idle' && projectDialogPathMessage"
              class="pathStatus"
              :class="projectDialogPathStatus"
              :title="projectDialogPathMessage"
            >
              {{ projectDialogPathMessage }}
            </div>
            <button
              class="inlineAction"
              type="button"
              :disabled="!workspacePath"
              @click="useCurrentWorkspacePath"
            >
              使用当前目录
            </button>
          </div>

          <label class="modalLabel" for="project-name">项目名称（可选）</label>
          <input
            id="project-name"
            v-model="projectDialogName"
            ref="projectNameEl"
            class="modalInput"
            placeholder="例如: ads"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter.prevent="submitProjectDialog"
          />

          <div v-if="projectDialogError" class="modalError">{{ projectDialogError }}</div>
        </div>

        <div class="modalActions">
          <button type="button" class="btnSecondary" @click="closeProjectDialog">取消</button>
          <button type="button" class="btnPrimary" :disabled="!projectDialogPath.trim()" @click="submitProjectDialog">添加</button>
        </div>
      </div>
    </div>

    <div v-if="switchConfirmOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="cancelProjectSwitch">
      <div class="modalCard">
        <div class="modalTitle">切换项目？</div>
        <div class="modalDesc">当前对话仍在进行或有未发送内容。切换项目会丢失当前页面临时状态（不会删除历史）。</div>
        <div class="modalActions">
          <button type="button" class="btnSecondary" @click="cancelProjectSwitch">取消</button>
          <button type="button" class="btnDanger" @click="confirmProjectSwitch">切换</button>
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="actionSheetProject"
        class="projectActionSheetMask"
        data-testid="project-action-sheet"
        @click="closeProjectActionSheet"
      >
        <div
          class="projectActionSheet"
          role="dialog"
          aria-modal="true"
          :aria-label="`项目操作：${actionSheetProject.name || actionSheetProject.id}`"
          @click.stop
        >
          <div class="projectActionSheetGroup">
            <div class="projectActionSheetHeader">
              <span class="projectActionSheetTitle">{{ actionSheetProject.name || actionSheetProject.id }}</span>
              <span class="projectActionSheetSubtitle">{{ formatProjectBranch(actionSheetProject.branch) }}</span>
            </div>
            <button
              v-if="actionSheetProject.id !== activeProjectId"
              type="button"
              class="projectActionSheetItem"
              data-testid="project-action-sheet-switch"
              @click="handleActionSheetSwitch"
            >
              切换到此项目
            </button>
            <button
              v-if="actionSheetProject.id !== 'default'"
              type="button"
              class="projectActionSheetItem danger"
              :disabled="!canRemoveProject(actionSheetProject.id)"
              data-testid="project-action-sheet-remove"
              @click="handleActionSheetRemove"
            >
              <span class="actionSheetItemLabel">从列表移除</span>
              <small class="actionSheetItemHint">仅从界面列表移除，不删除本地文件</small>
            </button>
          </div>
          <button
            type="button"
            class="projectActionSheetItem cancel"
            data-testid="project-action-sheet-cancel"
            @click="closeProjectActionSheet"
          >
            取消
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style src="./App.css" scoped></style>
