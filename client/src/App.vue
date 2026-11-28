<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

declare const __APP_VERSION__: string | undefined;
const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.1";

import LoginGate from "./components/LoginGate.vue";
import MainChatView from "./components/MainChat.vue";
import ActionsReviewQueue from "./components/ActionsReviewQueue.vue";
import PullRequestsWorkspace from "./components/PullRequestsWorkspace.vue";
import { lazyComponent } from "./lib/asyncComponent";

// Settings and session pickers sit behind modals/drawers; keep them out of the
// initial chunk. Names stay identical so test stubs keyed by component name
// keep matching.
const DraggableModal = lazyComponent(() => import("./components/DraggableModal.vue"));
const ModelManager = lazyComponent(() => import("./components/ModelManager.vue"));
const SessionResumePicker = lazyComponent(() => import("./components/SessionResumePicker.vue"));
const NotesDrawer = lazyComponent(() => import("./components/NotesDrawer.vue"));

import { createAppController } from "./app/controller";
import { useLaneRuntimeBridge, type ChatLane } from "./composables/app/useLaneRuntimeBridge";
import { useNoticeSpace } from "./composables/app/useNoticeSpace";
import { useProjectSidebar } from "./composables/app/useProjectSidebar";
import { createTapActivation } from "./lib/tapActivation";
import { crumb } from "./lib/diagBreadcrumbs";
import { errorRecoveryGeneration } from "./lib/errorRecovery";
import { readWorkspaceTab, writeWorkspaceTab } from "./lib/workspaceTabPreferences";
import { purgeLatestPromptPreferences } from "./lib/preferencesStore";
import type { TranscriptViewport } from "./app/transcriptCache";
import {
  buildTranscriptViewportScopeKey,
  isTranscriptViewportScopeCurrent,
} from "./lib/transcriptViewportScope";
import {
  ArrowRight,
  CirclePlus,
  Bell,
  ChatDotRound,
  Delete,
  Document,
  MoreFilled,
  Setting,
  Clock,
} from "@element-plus/icons-vue";
import { isLaneConnected } from "./lib/laneConnectionStatus";
import { t } from "./lib/i18n";
import { RECONNECT_BUSY_MESSAGE } from "./app/projectsWs/reconnectNotice";
import { resolveLaneConnectionPhase, type LaneConnectionPhase } from "./lib/laneConnectionPhase";
import { clearPendingAgyLoginView, hasPendingAgyLoginView } from "./lib/agyPendingLogin";
import type { LaneStatus, ProjectRuntime } from "./app/controllerTypes";
const {
  loggedIn,
  cachedTranscriptAvailable,
  handleAuthRequired,
  accountGeneration,
  handleLoggedIn,
  isMobile,
  api,
  models,
  loadModels,
  openProjectDialog,
  projects,
  activeProjectId,
  activeProject,
  requestProjectSwitch,
  reorderProjects,
  removeProject,
  getRuntime,
  getAcopilotRuntime,
  connectWs,
  runtimeProjectInProgress,
  formatProjectBranch,
  apiError,
  wsError,
  apiAuthorized,
  resumeTaskThread,
  listResumableSessions,
  resumeAcopilotThread,
  clearActiveChat,
  clearAcopilotChat,
  startNewAcopilotSession,
  startNewChatSession,
  messages,
  activeRuntime,
  activeAcopilotRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  sendMainPrompt,
  sendAcopilotPrompt,
  retryPrompt,
  setMainModelId,
  setAcopilotModelId,
  setMainModelReasoningEffort,
  setAcopilotModelReasoningEffort,
  switchMainAgent,
  switchAcopilotAgent,
  interruptActive,
  interruptAcopilot,
  addPendingImages,
  clearPendingImages,
  removePendingImage,
  addAcopilotPendingImages,
  clearAcopilotPendingImages,
  removeAcopilotPendingImage,
  removeQueuedPrompt,
  removeAcopilotQueuedPrompt,
  retryQueuedPrompt,
  retryAcopilotQueuedPrompt,
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
const settingsInitialTab = ref<"roles" | "models" | "notifications">("roles");
const notesOpen = ref(false);

type MobileDrawerSection = "projects" | "settings";
type MobileContextActionId =
  | "resume"
  | "new-session"
  | "notes"
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
type WorkspaceView = ChatLane | "prs";

const mobileDrawerOpen = ref(false);
const mobileDrawerSection = ref<MobileDrawerSection>("projects");
const mobileContextMenuOpen = ref(false);
const mobileSettingsRef = ref<MobileManagerHandle | null>(null);

const chatLanes: Array<{ id: ChatLane; label: string }> = [
  { id: "acopilot", label: "Acopilot" },
  { id: "actions", label: "Actions" },
];
const workspaceTabs = computed<Array<{ id: WorkspaceView; label: string }>>(() => [
  ...chatLanes,
  { id: "prs", label: "PRs" },
]);

const {
  activeChatLane,
  setActiveChatLane,
  acopilotMessages,
  acopilotQueuedPrompts,
  acopilotPendingAgentHandoffs,
  acopilotPendingImages,
  acopilotReady,
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
  actionsReady,
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
  activeAcopilotRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  clearActiveChat,
  clearAcopilotChat,
  startNewAcopilotSession,
  startNewChatSession,
  resumeAcopilotThread,
  resumeTaskThread,
  listResumableSessions,
});

const acopilotViewportScopeKey = computed(() => buildTranscriptViewportScopeKey({
  panelKey: acopilotPanelKey.value,
  errorRecoveryGeneration: errorRecoveryGeneration.value,
  accountGeneration: accountGeneration.value,
}));
const actionsViewportScopeKey = computed(() => buildTranscriptViewportScopeKey({
  panelKey: actionsPanelKey.value,
  errorRecoveryGeneration: errorRecoveryGeneration.value,
  accountGeneration: accountGeneration.value,
}));
const acopilotViewportScope = ref<string | undefined>();
const actionsViewportScope = ref<string | undefined>();

function handleAcopilotViewportScope(scope: string | undefined): void {
  acopilotViewportScope.value = scope;
}

function handleActionsViewportScope(scope: string | undefined): void {
  actionsViewportScope.value = scope;
}

function handleAcopilotViewport(viewport: TranscriptViewport): void {
  if (!isTranscriptViewportScopeCurrent(acopilotViewportScope.value, acopilotViewportScopeKey.value)) return;
  if (activeAcopilotRuntime.value.transcriptViewport) activeAcopilotRuntime.value.transcriptViewport.value = viewport;
}

function handleActionsViewport(viewport: TranscriptViewport): void {
  if (!isTranscriptViewportScopeCurrent(actionsViewportScope.value, actionsViewportScopeKey.value)) return;
  if (activeRuntime.value.transcriptViewport) activeRuntime.value.transcriptViewport.value = viewport;
}

const activeWorkspaceTab = computed<ChatLane>(() => activeChatLane.value);
const activeWorkspaceView = ref<WorkspaceView>(activeChatLane.value);

const actionsComposerInputLocked = computed(() => Boolean(actionsInputLocked.value));

type MainChatHandle = {
  refreshAfterVisibility?: () => void | Promise<void>;
};

const acopilotChatRef = ref<MainChatHandle | null>(null);
const actionsChatRef = ref<MainChatHandle | null>(null);

const activeLaneAgents = computed(() =>
  activeWorkspaceTab.value === "acopilot" ? acopilotAgents.value : actionsAgents.value,
);
const activeLaneActiveAgentId = computed(() =>
  activeWorkspaceTab.value === "acopilot" ? acopilotActiveAgentId.value : actionsActiveAgentId.value,
);
const activeLaneModelId = computed(() =>
  activeWorkspaceTab.value === "acopilot"
    ? activeAcopilotRuntime.value.modelId.value
    : activeRuntime.value.modelId.value,
);
const activeLaneModelReasoningEffort = computed(() =>
  activeWorkspaceTab.value === "acopilot"
    ? activeAcopilotRuntime.value.modelReasoningEffort.value
    : activeRuntime.value.modelReasoningEffort.value,
);

function workspaceTabConnected(view: WorkspaceView): boolean {
  return view !== "prs" && isLaneConnected(view, { acopilot: acopilotReady.value, actions: actionsReady.value });
}

function workspaceTabStatusClass(view: WorkspaceView): string {
  if (view === "prs") return "";
  const connected = workspaceTabConnected(view);
  const busy = view === "acopilot" ? acopilotBusy.value : agentBusy.value;
  return [
    connected ? "laneTabStatusDot--connected" : "laneTabStatusDot--disconnected",
    connected && busy ? (view === "acopilot" ? "laneTabStatusDot--busy-acopilot" : "laneTabStatusDot--busy-actions") : "",
  ].filter(Boolean).join(" ");
}

function handleActiveLaneSwitchAgent(agentId: string): void {
  if (activeWorkspaceTab.value === "acopilot") {
    switchAcopilotAgent(agentId);
  } else {
    switchMainAgent(agentId);
  }
}

function handleActiveLaneSetModel(modelId: string): void {
  if (activeWorkspaceTab.value === "acopilot") {
    setAcopilotModelId(modelId);
  } else {
    setMainModelId(modelId);
  }
}

function handleActiveLaneSetReasoningEffort(effort: string): void {
  if (activeWorkspaceTab.value === "acopilot") {
    setAcopilotModelReasoningEffort(effort);
  } else {
    setMainModelReasoningEffort(effort);
  }
}

type ProjectBusyState = "idle" | "acopilot" | "actions" | "both";

function projectBusyState(projectId: string): ProjectBusyState {
  const acopilotRuntime = getAcopilotRuntime(projectId);
  const actionsRuntime = getRuntime(projectId);
  // A transport loss leaves `busy` set so the reconnect notice and input lock
  // survive. Running animations, however, must disappear with the connection.
  const acopilotBusy = Boolean(acopilotRuntime.connected.value) && runtimeProjectInProgress(acopilotRuntime);
  const actionsBusy = Boolean(actionsRuntime.connected.value) && runtimeProjectInProgress(actionsRuntime);
  if (acopilotBusy && actionsBusy) return "both";
  if (acopilotBusy) return "acopilot";
  if (actionsBusy) return "actions";
  return "idle";
}

function projectStatusClass(projectId: string): string {
  const state = projectBusyState(projectId);
  return state === "idle" ? "" : `spinning spinning--${state}`;
}

function projectStatusTitle(projectId: string): string | undefined {
  const state = projectBusyState(projectId);
  if (state === "acopilot") return "Acopilot 正在处理…";
  if (state === "actions") return "Actions 正在执行…";
  if (state === "both") return "Acopilot 与 Actions 均在运行中…";
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
  if (mobileDrawerSection.value === "settings") {
    if (mobileSettingsTab.value === "models") return "模型配置";
    if (mobileSettingsTab.value === "notifications") return t("webPush.title");
    return "角色指令";
  }
  return activeProject.value?.name?.trim() || "项目";
});

const activeProjectName = computed(() => activeProject.value?.name?.trim() || "项目");
const activeProjectBranchLabel = computed(() => {
  const branch = String(activeProject.value?.branch ?? "").trim();
  return branch ? formatProjectBranch(branch) : "";
});
const activeProjectContextTitle = computed(() => (
  activeProjectBranchLabel.value
    ? `${activeProjectName.value} ${activeProjectBranchLabel.value}`
    : activeProjectName.value
));
const activeProjectContextAriaLabel = computed(() => (
  activeProjectBranchLabel.value
    ? `当前项目 ${activeProjectName.value}，当前分支 ${activeProjectBranchLabel.value}`
    : `当前项目 ${activeProjectName.value}`
));

const mobileContextMenuTitle = computed(() => {
  if (mobileDrawerSection.value === "settings") {
    if (mobileSettingsTab.value === "models") return "模型配置操作";
    if (mobileSettingsTab.value === "notifications") return t("webPush.title");
    return "角色指令操作";
  }
  return "项目操作";
});

const mobileContextActions = computed<MobileContextAction[]>(() => {
  if (mobileDrawerSection.value === "settings" || activeWorkspaceView.value === "prs") {
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
    {
      id: "notes",
      label: "闪念",
      disabled: false,
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

function openMobileDrawer(section?: MobileDrawerSection, focusNavigation = false): void {
  if (!isMobile.value) return;
  cancelDrawerGesture();
  focusDrawerNavigationOnOpen = focusNavigation;
  if (section) {
    mobileDrawerSection.value = section;
  }
  mobileDrawerOpen.value = true;
  mobileContextMenuOpen.value = false;
}

function toggleMobileDrawer(isKeyboard?: boolean): void {
  if (mobileDrawerOpen.value) {
    if (!isKeyboard) {
      skipDrawerToggleFocus = true;
    }
    closeMobileDrawer();
  } else {
    openMobileDrawer(undefined, Boolean(isKeyboard));
  }
}

const drawerActivation = createTapActivation<boolean>(toggleMobileDrawer, { preserveFocus: true, name: "mobile-drawer" });
let skipDrawerToggleFocus = false;
let focusDrawerNavigationOnOpen = false;

function onMobileDrawerTogglePointerUp(event: PointerEvent): void {
  drawerActivation.onPointerUp(event);
  (event.currentTarget as HTMLElement)?.blur();
}

function onMobileDrawerToggleClick(event: MouseEvent): void {
  drawerActivation.onClick(event, event.detail === 0);
  (event.currentTarget as HTMLElement)?.blur();
}

function onMobileDrawerNavigationClick(event: MouseEvent): void {
  if (event.detail === 0 || !(event.target instanceof Element)) return;
  const item = event.target.closest<HTMLElement>(".mobileDrawerNavItem");
  if (!item) return;
  item.blur();
  if (mobileDrawerOpen.value) mobileDrawerRef.value?.focus({ preventScroll: true });
}

function selectWorkspaceTab(tab: WorkspaceView): void {
  if (activeWorkspaceView.value === tab) {
    closeMobileContextMenu();
    return;
  }
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  if (tab !== "prs") {
    setActiveChatLane(tab);
    writeWorkspaceTab(activeProjectId.value, tab);
  }
  activeWorkspaceView.value = tab;
  crumb(`workspace:${activeWorkspaceTab.value}->${tab}`);
  closeMobileContextMenu();
}

const laneActivation = createTapActivation(selectWorkspaceTab, { preserveFocus: true, name: "lane-tab" });

function restoreWorkspaceTab(): void {
  const projectId = activeProjectId.value.trim();
  const tab = readWorkspaceTab(projectId);
  setActiveChatLane(tab);
  activeWorkspaceView.value = tab;
}

async function refreshVisibleLaneChat(lane: ChatLane): Promise<void> {
  await nextTick();
  if (activeWorkspaceTab.value !== lane) return;
  const chat = lane === "acopilot" ? acopilotChatRef.value : actionsChatRef.value;
  await chat?.refreshAfterVisibility?.();
}

function selectMobileDrawerSection(section: MobileDrawerSection): void {
  mobileDrawerSection.value = section;
  mobileContextMenuOpen.value = false;
  if (section !== "settings") clearPendingAgyLoginView();
  if (section === "settings") closeMobileDrawer();
}

const mobileSettingsTab = ref<"roles" | "models" | "notifications">("roles");

function selectMobileDrawerSettings(tab: "roles" | "models" | "notifications"): void {
  if (!loggedIn.value) return;
  mobileSettingsTab.value = tab;
  if (tab !== "models") clearPendingAgyLoginView();
  selectMobileDrawerSection("settings");
}

const noticeRef = ref<HTMLElement | null>(null);
useNoticeSpace(noticeRef);
const acopilotNoticeRef = ref<HTMLElement | null>(null);
const actionsNoticeRef = ref<HTMLElement | null>(null);
useNoticeSpace(acopilotNoticeRef);
useNoticeSpace(actionsNoticeRef);

function sendActionsPrompt(content: string): void {
  sendMainPrompt(content);
}

function retryAcopilotMessage(message: Parameters<typeof retryPrompt>[0]): void {
  if (!loggedIn.value) return;
  retryPrompt(message, activeAcopilotRuntime.value);
}

function retryAcopilotAgentHandoff(messageId: string): void {
  const id = String(messageId ?? "").trim();
  if (!loggedIn.value || !id) return;
  const socket = activeAcopilotRuntime.value.ws as {
    send?: (type: string, payload?: unknown) => boolean | void;
  } | null;
  if (socket?.send?.("retry_agent_message", { messageId: id }) === false) {
    activeAcopilotRuntime.value.wsError.value = "Agent handoff retry could not be sent";
  }
}

function retryActionsMessage(message: Parameters<typeof retryPrompt>[0]): void {
  if (!loggedIn.value) return;
  retryPrompt(message);
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
  if (actionId === "notes") {
    closeMobileDrawer();
    openNotes();
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
  clearPendingAgyLoginView();
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
const LANE_SWIPE_IGNORE_SELECTOR = "pre, code, table, input, textarea, select, button, a, [contenteditable], .prFilterScroller";
const WORKSPACE_VIEW_ORDER: WorkspaceView[] = ["acopilot", "actions", "prs"];
const MAX_WORKSPACE_VIEW_INDEX = WORKSPACE_VIEW_ORDER.length - 1;

function workspaceViewIndex(view: WorkspaceView): number {
  const index = WORKSPACE_VIEW_ORDER.indexOf(view);
  return index >= 0 ? index : 0;
}

// Dragging a selection handle horizontally must not read as a lane swipe.
function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return false;
  const selection = window.getSelection();
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
}

type TouchSample = { x: number; time: number };

type LaneGesture = {
  startX: number;
  startY: number;
  startTime: number;
  startView: WorkspaceView;
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
  const progress = Math.min(MAX_WORKSPACE_VIEW_INDEX, Math.max(0, -laneTrackOffset.value / width));
  return {
    "--lane-pill-progress": String(progress),
    "--lane-pill-transition": laneSnapSettling.value
      ? "transform 0.36s cubic-bezier(0.25, 1, 0.5, 1)"
      : "none",
  };
});

const prPanelPreviewVisible = computed(() => {
  if (!isMobile.value || laneTrackOffset.value === null) return false;
  const width = laneGesture?.width || lanePanelWidthPx() || 1;
  return laneTrackOffset.value < -width;
});

function lanePanelWidthPx(): number {
  const measured = lanePanelsRef.value?.clientWidth ?? 0;
  if (measured > 0) return measured;
  return window.innerWidth;
}

function clampLaneOffsetWithResistance(offset: number, width: number): number {
  const minOffset = -MAX_WORKSPACE_VIEW_INDEX * width;
  if (offset > 0) {
    // Rubber-band resistance past left edge (Advisor)
    return offset * 0.35;
  }
  if (offset < minOffset) {
    // Rubber-band resistance past right edge (PRs)
    return minOffset + (offset - minOffset) * 0.35;
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

function settleLaneGesture(target: WorkspaceView, width: number): void {
  laneSnapSettling.value = true;
  laneTrackOffset.value = -workspaceViewIndex(target) * width;
  laneSettleTimer = setTimeout(() => {
    laneSettleTimer = null;
    laneSnapSettling.value = false;
    // The stylesheet position matches the settle target, so dropping the
    // inline transform cannot move the track.
    laneTrackOffset.value = null;
    if (target !== activeWorkspaceView.value) selectWorkspaceTab(target);
  }, LANE_SNAP_SETTLE_MS);
}

function onLaneSwipeTouchStart(ev: TouchEvent): void {
  if (laneGesture || laneSnapSettling.value) return;
  if (!isMobile.value || mobileDrawerOpen.value) return;
  // An in-flight drawer gesture owns the touch sequence.
  if (drawerDragProgress.value !== null || drawerSnapSettling.value) return;
  if (ev.target instanceof Element && ev.target.closest(LANE_SWIPE_IGNORE_SELECTOR)) return;
  // An active text selection means the touch is adjusting the selection
  // bounds, not navigating lanes.
  if (hasActiveTextSelection()) return;
  const touch = readSwipeTouch(ev);
  // The left edge stays reserved for the drawer edge swipe.
  if (!touch || touch.x <= DRAWER_SWIPE_EDGE_PX) return;
  laneGesture = {
    startX: touch.x,
    startY: touch.y,
    startTime: ev.timeStamp,
    startView: activeWorkspaceView.value,
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
  // A selection handle drag can appear mid-gesture (long-press selects, then
  // the handle moves horizontally); cancel instead of translating the track.
  if (hasActiveTextSelection()) {
    laneGesture = null;
    laneDragTracking.value = false;
    laneTrackOffset.value = null;
    return;
  }
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
  const base = -workspaceViewIndex(gesture.startView) * gesture.width;
  laneTrackOffset.value = clampLaneOffsetWithResistance(base + dx, gesture.width);
}

function finishLaneGesture(ev: TouchEvent, cancelled: boolean): void {
  const gesture = laneGesture;
  laneGesture = null;
  laneDragTracking.value = false;
  if (!gesture || !gesture.tracking) return;
  const width = gesture.width;
  if (cancelled) {
    // touchcancel always springs back to the view the drag started from.
    settleLaneGesture(gesture.startView, width);
    return;
  }
  const startIndex = workspaceViewIndex(gesture.startView);
  const base = -startIndex * width;
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
  let targetIndex = startIndex;
  if (velocity <= -LANE_FLICK_VELOCITY_PX_PER_MS) {
    targetIndex = Math.min(MAX_WORKSPACE_VIEW_INDEX, startIndex + 1);
  } else if (velocity >= LANE_FLICK_VELOCITY_PX_PER_MS) {
    targetIndex = Math.max(0, startIndex - 1);
  } else if (position > 0) {
    targetIndex = 0;
  } else if (position < -MAX_WORKSPACE_VIEW_INDEX * width) {
    targetIndex = MAX_WORKSPACE_VIEW_INDEX;
  } else {
    const deltaPanels = (-position - startIndex * width) / width;
    if (deltaPanels > LANE_SNAP_RATIO) {
      targetIndex = Math.min(MAX_WORKSPACE_VIEW_INDEX, startIndex + 1);
    } else if (deltaPanels < -LANE_SNAP_RATIO) {
      targetIndex = Math.max(0, startIndex - 1);
    }
  }
  settleLaneGesture(WORKSPACE_VIEW_ORDER[targetIndex] ?? gesture.startView, width);
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
  const outsideItems = active === drawer || !drawer.contains(active);
  if (ev.shiftKey && (active === first || outsideItems)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || outsideItems)) {
    ev.preventDefault();
    first.focus();
  }
}

watch(mobileDrawerOpen, async (open) => {
  if (typeof document === "undefined") return;
  document.body.style.overflow = open && isMobile.value ? "hidden" : "";
  if (!isMobile.value) return;
  const focusNavigation = focusDrawerNavigationOnOpen;
  focusDrawerNavigationOnOpen = false;
  await nextTick();
  if (mobileDrawerOpen.value !== open || !isMobile.value) return;
  if (open) {
    // Keep focus inside the drawer without giving touch opens a navigation ring.
    const target = focusNavigation
      ? mobileDrawerRef.value?.querySelector<HTMLElement>('[data-testid="mobile-drawer-section-projects"]')
      : mobileDrawerRef.value;
    target?.focus({ preventScroll: true });
  } else if (!skipDrawerToggleFocus) {
    mobileDrawerToggleRef.value?.focus();
  } else {
    mobileDrawerToggleRef.value?.blur();
  }
  skipDrawerToggleFocus = false;
});

watch(isMobile, (mobile) => {
  if (activeProjectId.value.trim() && activeWorkspaceView.value !== "prs") restoreWorkspaceTab();
  if (mobile) return;
  closeMobileDrawer();
  cancelLaneGesture();
}, { immediate: true });

watch(activeProjectId, (projectId, previousProjectId) => {
  if (!projectId.trim() || projectId === previousProjectId) return;
  restoreWorkspaceTab();
});

watch(activeChatLane, (lane) => {
  if (activeWorkspaceView.value !== "prs") activeWorkspaceView.value = lane;
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
  clearPendingAgyLoginView();
  closeMobileDrawer();
  try {
    sessionStorage.removeItem(DRAFT_STASH_KEY);
    purgeLatestPromptPreferences();
  } catch { /* Private input must not be restored across accounts. */ }
}, { flush: "sync" });

watch(
  loggedIn,
  (isLoggedIn) => {
    if (!isLoggedIn || !hasPendingAgyLoginView()) return;
    if (isMobile.value) {
      mobileSettingsTab.value = "models";
      mobileDrawerSection.value = "settings";
      mobileDrawerOpen.value = false;
    } else {
      settingsInitialTab.value = "models";
      settingsOpen.value = true;
    }
  },
  { immediate: true },
);

function stashComposerDrafts(): void {
  try {
    const actionsDraft = String(actionsComposerDraft.value ?? "");
    const acopilotDraft = String(acopilotComposerDraft.value ?? "");
    if (!actionsDraft && !acopilotDraft) {
      sessionStorage.removeItem(DRAFT_STASH_KEY);
      return;
    }
    sessionStorage.setItem(
      DRAFT_STASH_KEY,
      // Payload keys stay `worker` / `advisor`: they are persisted in
      // sessionStorage and renaming them would drop existing users' drafts.
      JSON.stringify({ projectId: activeProjectId.value, worker: actionsDraft, advisor: acopilotDraft }),
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
    const actionsDraft = String(stash.worker ?? "");
    const acopilotDraft = String(stash.advisor ?? "");
    if (actionsDraft && !actionsComposerDraft.value) actionsComposerDraft.value = actionsDraft;
    if (acopilotDraft && !acopilotComposerDraft.value) acopilotComposerDraft.value = acopilotDraft;
  } catch {
    // ignore
  }
}

onMounted(() => {
  window.addEventListener("keydown", onMobileKeydown);
  window.addEventListener("pagehide", stashComposerDrafts);
  restoreStashedComposerDrafts();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onMobileKeydown);
  window.removeEventListener("pagehide", stashComposerDrafts);
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
  getAcopilotRuntime,
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
const pendingRemoveProjectId = ref<string | null>(null);

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

const pendingRemoveProject = computed(() => {
  const id = pendingRemoveProjectId.value;
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

function requestRemoveProject(p: ProjectLike): void {
  if (!canRemoveProject(p.id)) return;
  pendingRemoveProjectId.value = p.id;
}

function cancelRemoveProject(): void {
  pendingRemoveProjectId.value = null;
}

async function confirmRemoveProject(): Promise<void> {
  const p = pendingRemoveProject.value;
  pendingRemoveProjectId.value = null;
  if (p) {
    await handleRemoveProject(p.id);
  }
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
  settingsInitialTab.value = "roles";
  settingsOpen.value = true;
}

function closeSettings(): void {
  settingsOpen.value = false;
  clearPendingAgyLoginView();
}

function openNotes(): void {
  if (!loggedIn.value) return;
  notesOpen.value = true;
}

function closeNotes(): void {
  notesOpen.value = false;
}

async function handlePromoteNote(note: { projectId: string; content: string }): Promise<void> {
  notesOpen.value = false;
  const targetProjectId = String(note.projectId ?? "").trim();
  if (
    targetProjectId &&
    targetProjectId !== activeProjectId.value &&
    projects.value.some((project) => project.id === targetProjectId)
  ) {
    selectProject(targetProjectId);
    await nextTick();
  }
  selectWorkspaceTab("acopilot");
  await nextTick();
  startNewAcopilotSession();
  await nextTick();
  acopilotComposerDraft.value = note.content;
}

async function onSettingsChanged(): Promise<void> {
  try {
    await loadModels();
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
}

const readyAcpAgentSignature = computed(() => {
  const ids = new Set<string>();
  for (const runtime of [activeRuntime.value, activeAcopilotRuntime.value]) {
    const list = runtime?.availableAgents?.value ?? [];
    for (const agent of list) {
      const id = String(agent?.id ?? "").trim();
      if (agent?.ready && (id === "codex" || id === "agy" || id.startsWith("agy:"))) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids).sort().join(",");
});

watch(readyAcpAgentSignature, (next, prev) => {
  if (!loggedIn.value || next === prev) return;
  void loadModels().catch(() => {});
});

const runningTaskCount = computed(() => 0);

const authConnectionState = ref<"checking" | "offline" | "unavailable" | "request-failed">("checking");

type LaneConnectionPhaseState = { phase: LaneConnectionPhase; message: string };

function laneConnectionPhaseForRuntime(runtime: ProjectRuntime): LaneConnectionPhaseState | null {
  const terminalError = String(runtime.connectionError.value ?? "").trim() || null;
  const socket = runtime.ws as { isConnecting?: () => boolean } | null;
  const phase = resolveLaneConnectionPhase({
    connected: runtime.connected.value,
    connecting: socket?.isConnecting?.() === true,
    syncInProgress: runtime.syncInProgress,
    reconnectActive: runtime.reconnectTimer !== null || runtime.reconnectAttempts > 0,
    terminalError,
    stateRevision: runtime.connectionPhaseRevision.value,
  });
  if (!phase) return null;
  const message = phase === "connecting"
    ? t("connection.connecting")
    : phase === "syncing"
      ? t("connection.syncing")
      : phase === "reconnecting"
        ? t("connection.reconnecting")
        : terminalError || t("connection.connectionError");
  return { phase, message };
}

function laneConnectionStatus(
  runtime: ProjectRuntime,
  laneStatus: LaneStatus | null,
  phase: LaneConnectionPhaseState | null,
): LaneStatus | null {
  if (phase?.phase === "error") {
    if (laneStatus?.kind === "error" && laneStatus.message === phase.message) return null;
    return laneStatus;
  }
  if (phase?.phase === "connecting" || phase?.phase === "reconnecting") {
    return laneStatus?.kind === "progress" && laneStatus.message === RECONNECT_BUSY_MESSAGE
      ? null
      : laneStatus;
  }
  return laneStatus?.kind === "progress" && laneStatus.message === RECONNECT_BUSY_MESSAGE
    ? null
    : laneStatus;
}

function laneOperationalError(
  runtime: ProjectRuntime,
  laneStatus: LaneStatus | null,
  phase: LaneConnectionPhaseState | null,
): string | null {
  const error = String(runtime.wsError.value ?? "").trim();
  if (!error) return null;
  if (phase?.phase === "connecting" || phase?.phase === "reconnecting") return null;
  if (phase?.phase === "error" && error === phase.message) return null;
  if (laneStatus?.kind === "error" && laneStatus.message === error) return null;
  return error;
}

function handleAuthConnectionState(state: "checking" | "offline" | "unavailable" | "request-failed"): void {
  authConnectionState.value = state;
}

function cachedConnectionStatus() {
  if (authConnectionState.value === "checking") {
    return { kind: "progress" as const, message: t("auth.checkingConnection") };
  }
  const messageKey = authConnectionState.value === "offline"
    ? "auth.offlineCached"
    : authConnectionState.value === "request-failed"
      ? "auth.serverRequestFailedCached"
      : "auth.serverUnavailableCached";
  return {
    kind: "disconnected" as const,
    message: t(messageKey),
  };
}

const actionsConnectionPhase = computed(() => laneConnectionPhaseForRuntime(activeRuntime.value));

const acopilotConnectionPhase = computed(() => laneConnectionPhaseForRuntime(activeAcopilotRuntime.value));

const actionsConnectionStatus = computed(() => loggedIn.value
  ? laneConnectionStatus(activeRuntime.value, actionsLaneStatus.value, actionsConnectionPhase.value)
  : cachedConnectionStatus());

const acopilotConnectionStatus = computed(() => loggedIn.value
  ? laneConnectionStatus(activeAcopilotRuntime.value, acopilotLaneStatus.value, acopilotConnectionPhase.value)
  : cachedConnectionStatus());

const actionsOperationalError = computed(() => loggedIn.value
  ? laneOperationalError(activeRuntime.value, actionsLaneStatus.value, actionsConnectionPhase.value)
  : null);

const acopilotOperationalError = computed(() => loggedIn.value
  ? laneOperationalError(activeAcopilotRuntime.value, acopilotLaneStatus.value, acopilotConnectionPhase.value)
  : null);

</script>

<template>
  <LoginGate
    v-if="!loggedIn"
    v-show="!cachedTranscriptAvailable"
    @logged-in="handleLoggedIn"
    @auth-required="handleAuthRequired"
    @connection-state="handleAuthConnectionState"
  />
  <div
    v-if="loggedIn || cachedTranscriptAvailable"
    class="app"
    :data-cache-read-only="!loggedIn"
    :data-active-lane="activeWorkspaceTab"
    :data-active-workspace-view="activeWorkspaceView"
    :data-project-id="activeProjectId"
    :data-worker-message-count="messages.length"
    :data-advisor-message-count="acopilotMessages.length"
    :data-worker-panel-key="actionsPanelKey"
    :data-advisor-panel-key="acopilotPanelKey"
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
        @pointerdown.stop="drawerActivation.onPointerDown($event, false)"
        @pointermove.stop="drawerActivation.onPointerMove"
        @pointercancel.stop="drawerActivation.onPointerCancel"
        @pointerup.stop="onMobileDrawerTogglePointerUp"
        @click.stop="onMobileDrawerToggleClick"
      >
        <svg class="mobileMenuIcon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect x="2" y="5.5" width="16" height="2.2" rx="1.1" />
          <rect x="2" y="12.3" width="10" height="2.2" rx="1.1" />
        </svg>
      </button>
      <div class="topbarMain">
        <div
          v-if="!isMobile || mobileDrawerSection === 'projects'"
          class="activeProjectContext"
          role="group"
          data-testid="active-project-context"
          :title="activeProjectContextTitle"
          :aria-label="activeProjectContextAriaLabel"
        >
          <span
            class="activeProjectContextName"
            data-testid="active-project-context-name"
            :title="activeProjectName"
            aria-hidden="true"
          >{{ activeProjectName }}</span>
          <span
            v-if="activeProjectBranchLabel"
            class="activeProjectBranchBadge"
            data-testid="active-project-context-branch"
            :title="activeProjectBranchLabel"
            aria-hidden="true"
          >{{ activeProjectBranchLabel }}</span>
        </div>
        <div v-else class="mobileContextTitle" :title="mobileContextTitle">
          {{ mobileContextTitle }}
        </div>
      </div>
      <div class="right">
        <div v-if="!isMobile && activeWorkspaceView !== 'prs'" class="laneSessionActions">
          <button
            v-if="loggedIn"
            class="laneTabIconBtn"
            type="button"
            title="闪念 (Notes)"
            aria-label="闪念 (Notes)"
            data-testid="lane-quick-notes"
            @click.stop="openNotes"
          >
            <el-icon :size="15" aria-hidden="true"><Document /></el-icon>
          </button>
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

    <div v-if="apiNotice && isMobile && mobileDrawerSection !== 'projects'" ref="noticeRef" class="noticeToast" role="status" aria-live="polite" aria-atomic="true" tabindex="0">
      <span class="noticeToastText">{{ apiNotice }}</span>
    </div>

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
          :tabindex="isMobile ? -1 : undefined"
          data-testid="mobile-drawer"
          @touchstart.passive="onDrawerSwipeTouchStart"
          @touchmove.passive="onDrawerSwipeTouchMove"
          @keydown="onDrawerKeydown"
        >
        <nav v-if="isMobile" class="mobileDrawerNav" aria-label="导航模块" @click="onMobileDrawerNavigationClick">
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
            :class="{ active: mobileDrawerSection === 'settings' && mobileSettingsTab === 'roles' }"
            data-testid="mobile-drawer-section-prompts"
            :disabled="!loggedIn"
            @click="selectMobileDrawerSettings('roles')"
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
          <button
            type="button"
            class="mobileDrawerNavItem mobileDrawerNavItem--link"
            :class="{ active: mobileDrawerSection === 'settings' && mobileSettingsTab === 'notifications' }"
            data-testid="mobile-drawer-section-notifications"
            :disabled="!loggedIn"
            @click="selectMobileDrawerSettings('notifications')"
          >
            <el-icon :size="16" aria-hidden="true"><Bell /></el-icon>
            <span>{{ t("webPush.title") }}</span>
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
                @pointerdown.stop
                @pointerup.stop
                @pointercancel.stop
                @touchstart.stop
                @touchend.stop
                @touchcancel.stop
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
                <span
                  v-if="!isMobile && loggedIn && p.id !== 'default'"
                  class="projectRemove"
                  :class="{ disabled: !canRemoveProject(p.id) }"
                  :title="canRemoveProject(p.id) ? '从列表移除' : '项目正在运行，暂时无法移除'"
                  aria-label="从列表移除"
                  :data-testid="`project-remove-${p.id}`"
                  @click.stop.prevent="requestRemoveProject(p)"
                  @pointerdown.stop
                  @pointerup.stop
                  @pointercancel.stop
                  @touchstart.stop
                  @touchend.stop
                  @touchcancel.stop
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
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
                :class="{ active: activeWorkspaceView === tab.id }"
                role="tab"
                :aria-selected="activeWorkspaceView === tab.id"
                :aria-controls="`lane-panel-${tab.id}`"
                :data-testid="`lane-tab-${tab.id}`"
                @pointerdown="laneActivation.onPointerDown($event, tab.id)"
                @pointermove="laneActivation.onPointerMove"
                @pointercancel="laneActivation.onPointerCancel"
                @pointerup="laneActivation.onPointerUp"
                @click="laneActivation.onClick($event, tab.id)"
              >
              <span
                v-if="tab.id !== 'prs'"
                class="laneTabStatusDot"
                :class="workspaceTabStatusClass(tab.id)"
               :data-testid="`lane-tab-status-${tab.id}`"
                aria-hidden="true"
              />
              <span class="laneTabLabel">{{ tab.label }}</span>
              </button>
            </template>
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
            :class="{
              'lanePanelsTrack--worker': activeWorkspaceView === 'actions',
              'lanePanelsTrack--prs': activeWorkspaceView === 'prs',
              'lanePanelsTrack--dragging': laneDragTracking,
            }"
            :style="laneTrackStyle"
          >
            <section
              id="lane-panel-acopilot"
              class="lanePanel"
              :class="{ 'lanePanel--inactive': activeWorkspaceView !== 'acopilot' }"
              :style="!isMobile && activeWorkspaceView !== 'acopilot' ? { display: 'none' } : undefined"
              role="tabpanel"
              aria-labelledby="lane-tab-acopilot"
              :aria-hidden="activeWorkspaceView === 'acopilot' ? undefined : 'true'"
              :inert="activeWorkspaceView !== 'acopilot' ? true : undefined"
              data-testid="lane-panel-acopilot"
              :data-message-count="acopilotMessages.length"
              :data-panel-key="`${acopilotPanelKey}:${errorRecoveryGeneration}`"
            >
              <div v-if="apiNotice && activeWorkspaceTab === 'acopilot'" ref="acopilotNoticeRef" class="noticeToast" role="status" aria-live="polite" aria-atomic="true" tabindex="0">
                <span class="noticeToastText">{{ apiNotice }}</span>
              </div>
              <MainChatView
                ref="acopilotChatRef"
                :key="`${acopilotPanelKey}:${errorRecoveryGeneration}:${accountGeneration}`"
                class="chatHost chatHost--advisor"
                :messages="acopilotMessages"
                :viewport="activeAcopilotRuntime.transcriptViewport?.value"
                :transcript-scope-key="activeAcopilotRuntime.transcriptScopeKey?.value"
                :transcript-authoritative="activeAcopilotRuntime.transcriptAuthoritative?.value"
                :transcript-authoritative-seq="activeAcopilotRuntime.transcriptAuthoritativeSeq?.value"
                :transcript-reset-seq="activeAcopilotRuntime.transcriptResetSeq?.value"
                :transcript-align-seq="activeAcopilotRuntime.transcriptAlignSeq?.value"
                :viewport-scope-key="acopilotViewportScopeKey"
                :draft="acopilotComposerDraft"
                :latest-prompt-key="acopilotChatKey"
                :voice-input-active="activeWorkspaceTab === 'acopilot' && loggedIn && !settingsOpen && !mobileDrawerOpen"
                :queued-prompts="acopilotQueuedPrompts"
                :pending-agent-handoffs="acopilotPendingAgentHandoffs"
                :pending-images="acopilotPendingImages"
                :connected="acopilotReady"
                :busy="acopilotBusy"
                :input-locked="!loggedIn || acopilotInputLocked"
                :workspace-root="resolveActiveWorkspaceRoot()"
                :agents="activeLaneAgents"
                :active-agent-id="activeLaneActiveAgentId"
                :models="models"
                :model-id="activeLaneModelId"
                :model-reasoning-effort="activeLaneModelReasoningEffort"
                :connection-status-kind="acopilotConnectionStatus?.kind ?? null"
                :connection-status-message="acopilotConnectionStatus?.message ?? null"
                :connection-phase="acopilotConnectionPhase?.phase ?? null"
                :connection-phase-message="acopilotConnectionPhase?.message ?? null"
                :operational-error="acopilotOperationalError"
                :thread-warning="acopilotThreadWarning"
                @send="sendAcopilotPrompt"
                @retry-message="retryAcopilotMessage($event)"
                @retry-agent-handoff="retryAcopilotAgentHandoff($event)"
                @update:draft="acopilotComposerDraft = $event"
                @update:viewport-scope="handleAcopilotViewportScope"
                @update:viewport="handleAcopilotViewport"
                @interrupt="interruptAcopilot"
                @addImages="addAcopilotPendingImages"
                @clearImages="clearAcopilotPendingImages"
                @removeImage="removeAcopilotPendingImage"
                @removeQueued="removeAcopilotQueuedPrompt"
                @retryQueued="retryAcopilotQueuedPrompt"
                @switch-agent="handleActiveLaneSwitchAgent"
                @set-model="handleActiveLaneSetModel"
                @set-reasoning-effort="handleActiveLaneSetReasoningEffort"
              />
            </section>

            <section
              id="lane-panel-actions"
              class="lanePanel"
              :class="{ 'lanePanel--inactive': activeWorkspaceView !== 'actions' }"
              :style="!isMobile && activeWorkspaceView !== 'actions' ? { display: 'none' } : undefined"
              role="tabpanel"
              aria-labelledby="lane-tab-actions"
              :aria-hidden="activeWorkspaceView === 'actions' ? undefined : 'true'"
              :inert="activeWorkspaceView !== 'actions' ? true : undefined"
              data-testid="lane-panel-actions"
              :data-message-count="messages.length"
              :data-panel-key="`${actionsPanelKey}:${errorRecoveryGeneration}`"
            >
              <div v-if="apiNotice && activeWorkspaceTab === 'actions'" ref="actionsNoticeRef" class="noticeToast" role="status" aria-live="polite" aria-atomic="true" tabindex="0">
                <span class="noticeToastText">{{ apiNotice }}</span>
              </div>
              <ActionsReviewQueue
                v-if="loggedIn && activeProjectId"
                :key="`${activeProjectId}:${accountGeneration}`"
                :project-id="activeProjectId"
                :active="activeWorkspaceTab === 'actions'"
              />
              <MainChatView
                ref="actionsChatRef"
                :key="`${actionsPanelKey}:${errorRecoveryGeneration}:${accountGeneration}`"
                class="chatHost"
                :messages="messages"
                :viewport="activeRuntime.transcriptViewport?.value"
                :transcript-scope-key="activeRuntime.transcriptScopeKey?.value"
                :transcript-authoritative="activeRuntime.transcriptAuthoritative?.value"
                :transcript-authoritative-seq="activeRuntime.transcriptAuthoritativeSeq?.value"
                :transcript-reset-seq="activeRuntime.transcriptResetSeq?.value"
                :transcript-align-seq="activeRuntime.transcriptAlignSeq?.value"
                :viewport-scope-key="actionsViewportScopeKey"
                :draft="actionsComposerDraft"
                :latest-prompt-key="actionsLatestPromptKey"
                :voice-input-active="activeWorkspaceTab === 'actions' && loggedIn && !settingsOpen && !mobileDrawerOpen"
                :queued-prompts="actionsQueuedPrompts"
                :pending-images="pendingImages"
                :connected="actionsReady"
                :busy="agentBusy"
                :input-locked="!loggedIn || actionsComposerInputLocked"
                :workspace-root="resolveActiveWorkspaceRoot()"
                :running-task-count="runningTaskCount"
                :agents="activeLaneAgents"
                :active-agent-id="activeLaneActiveAgentId"
                :models="models"
                :model-id="activeLaneModelId"
                :model-reasoning-effort="activeLaneModelReasoningEffort"
                :connection-status-kind="actionsConnectionStatus?.kind ?? null"
                :connection-status-message="actionsConnectionStatus?.message ?? null"
                :connection-phase="actionsConnectionPhase?.phase ?? null"
                :connection-phase-message="actionsConnectionPhase?.message ?? null"
                :operational-error="actionsOperationalError"
                :thread-warning="actionsThreadWarning"
                @send="sendActionsPrompt"
                @retry-message="retryActionsMessage($event)"
                @update:draft="actionsComposerDraft = $event"
                @update:viewport-scope="handleActionsViewportScope"
                @update:viewport="handleActionsViewport"
                @interrupt="interruptActive"
                @clear="clearActiveChat"
                @addImages="addPendingImages"
                @clearImages="clearPendingImages"
                @removeImage="removePendingImage"
                @removeQueued="removeQueuedPrompt"
                @retryQueued="retryQueuedPrompt"
                @switch-agent="handleActiveLaneSwitchAgent"
                @set-model="handleActiveLaneSetModel"
                @set-reasoning-effort="handleActiveLaneSetReasoningEffort"
              />
            </section>

            <section
              id="lane-panel-prs"
              class="lanePanel"
              :class="{ 'lanePanel--inactive': activeWorkspaceView !== 'prs' }"
              :style="!isMobile && activeWorkspaceView !== 'prs' ? { display: 'none' } : undefined"
              role="tabpanel"
              aria-labelledby="lane-tab-prs"
              :aria-hidden="activeWorkspaceView === 'prs' ? undefined : 'true'"
              :inert="activeWorkspaceView !== 'prs' ? true : undefined"
              data-testid="lane-panel-prs"
            >
              <PullRequestsWorkspace
                v-if="activeWorkspaceView === 'prs' || prPanelPreviewVisible"
                :project-id="activeProjectId"
                :active="activeWorkspaceView === 'prs'"
              />
            </section>
          </div>
        </div>
      </section>
    </main>

    <DraggableModal v-if="settingsOpen" card-variant="large" @close="closeSettings">
      <ModelManager
        :api="api"
        :initial-tab="settingsInitialTab"
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
        :agent-id="actionsActiveAgentId"
        :disabled="activeLaneBusy || resumeThreadBlocked"
        :disabled-reason="sessionResumeDisabledReason"
        @close="closeSessionPicker"
        @refresh="refreshResumableSessions"
        @load-more="loadMoreResumableSessions"
        @resume="resumeSelectedSession"
      />
    </DraggableModal>

    <DraggableModal v-if="notesOpen" card-variant="large" @close="closeNotes">
      <NotesDrawer
        :api="api"
        :project-id="activeProjectId"
        :projects="projects"
        @close="closeNotes"
        @promote="handlePromoteNote($event)"
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
    <div v-if="pendingRemoveProject" class="modalOverlay" role="dialog" aria-modal="true" @click.self="cancelRemoveProject">
      <div class="modalCard" role="document">
        <div class="modalTitle">从列表移除项目？</div>
        <div class="modalDesc">仅从项目列表移除，不会删除本地文件或工作区数据。</div>
        <div class="modalPreview">
          <div class="modalPreviewTitle">{{ pendingRemoveProject.name || pendingRemoveProject.id }}</div>
          <div v-if="pendingRemoveProject.path" class="modalPreviewPrompt">{{ pendingRemoveProject.path }}</div>
        </div>
        <div class="modalActions">
          <button type="button" class="btnSecondary" @click="cancelRemoveProject">取消</button>
          <button type="button" class="btnDanger" data-testid="project-remove-confirm" @click="confirmRemoveProject">移除</button>
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
