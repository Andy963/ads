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
import { diagAlert } from "./lib/diagAlert";
import { crumb } from "./lib/diagBreadcrumbs";
import { errorRecoveryGeneration } from "./lib/errorRecovery";
import {
  readMobileWorkspaceTab,
  writeMobileWorkspaceTab,
  type MobileWorkspaceTab,
} from "./lib/mobileWorkspacePreferences";
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
  addAdvisorPendingImages,
  clearAdvisorPendingImages,
  removeQueuedPrompt,
  removeAdvisorQueuedPrompt,
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
  { id: "advisor", label: "Advisor" },
  { id: "worker", label: "Worker" },
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
  if (mobileDrawerSection.value === "settings") return "系统设置";
  return activeProject.value?.name?.trim() || "项目";
});

const mobileContextMenuTitle = computed(() => {
  if (mobileDrawerSection.value === "settings") return "系统设置操作";
  return "项目操作";
});

const mobileContextActions = computed<MobileContextAction[]>(() => {
  if (mobileDrawerSection.value === "settings") {
    return [
      { id: "create-model", label: "新增模型" },
      { id: "refresh-models", label: "刷新模型列表" },
    ];
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

function closeMobileDrawer(): void {
  mobileDrawerOpen.value = false;
  mobileContextMenuOpen.value = false;
}

function openMobileDrawer(section?: MobileDrawerSection): void {
  if (!isMobile.value) return;
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

function selectWorkspaceTab(tab: ChatLane): void {
  if (activeWorkspaceTab.value === tab) {
    closeMobileContextMenu();
    return;
  }
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const before = {
    lane: activeWorkspaceTab.value,
    workerCount: messages.length,
    advisorCount: advisorMessages.length,
  };
  setActiveChatLane(tab);
  crumb(`lane:${activeWorkspaceTab.value}->${tab}`);
  if (isMobile.value) writeMobileWorkspaceTab(activeProjectId.value, tab);
  closeMobileContextMenu();
  // Temporary diagnostic: verify the lane switch actually landed in the DOM.
  const expectedKey = `${tab === "advisor" ? advisorPanelKey.value : workerPanelKey.value}:${errorRecoveryGeneration.value}`;
  window.setTimeout(() => {
    try {
      const appEl = document.querySelector(".app");
      const activeLane = appEl?.getAttribute("data-active-lane");
      const panel = document.getElementById(`lane-panel-${tab}`);
      const panelKey = panel?.getAttribute("data-panel-key");
      const visibleCount = panel?.getAttribute("data-message-count");
      const hidden = Boolean(panel) && panel?.style.display === "none";
      if (activeLane !== tab || !panel || hidden || panelKey !== expectedKey) {
        diagAlert("lane切换未生效", {
          clicked: tab,
          activeLane,
          panelKey,
          expectedKey,
          visibleCount,
          hidden,
          before,
        });
      }
    } catch {
      // diagnostics must never break switching
    }
  }, 400);
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
const DRAWER_SWIPE_TRIGGER_PX = 32;
const DRAWER_SWIPE_RATIO = 1.4;

type DrawerSwipe = { startX: number; startY: number; triggered: boolean };
let drawerEdgeSwipe: DrawerSwipe | null = null;
let drawerCloseSwipe: DrawerSwipe | null = null;

function readSwipeTouch(ev: TouchEvent): { x: number; y: number } | null {
  if (ev.touches.length !== 1) return null;
  return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
}

function isHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > DRAWER_SWIPE_TRIGGER_PX && Math.abs(dx) > Math.abs(dy) * DRAWER_SWIPE_RATIO;
}

function onDrawerEdgeTouchStart(ev: TouchEvent): void {
  if (!isMobile.value || mobileDrawerOpen.value) return;
  const touch = readSwipeTouch(ev);
  if (!touch || touch.x > DRAWER_SWIPE_EDGE_PX) return;
  drawerEdgeSwipe = { startX: touch.x, startY: touch.y, triggered: false };
}

function onDrawerEdgeTouchMove(ev: TouchEvent): void {
  const swipe = drawerEdgeSwipe;
  if (!swipe || swipe.triggered) return;
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  if (touch.x - swipe.startX > 0 && isHorizontalSwipe(touch.x - swipe.startX, touch.y - swipe.startY)) {
    swipe.triggered = true;
    openMobileDrawer();
  }
}

function onDrawerSwipeTouchStart(ev: TouchEvent): void {
  if (!isMobile.value) return;
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  drawerCloseSwipe = { startX: touch.x, startY: touch.y, triggered: false };
}

function onDrawerSwipeTouchMove(ev: TouchEvent): void {
  const swipe = drawerCloseSwipe;
  if (!swipe || swipe.triggered) return;
  const touch = readSwipeTouch(ev);
  if (!touch) return;
  const dx = touch.x - swipe.startX;
  if (dx < 0 && isHorizontalSwipe(dx, touch.y - swipe.startY)) {
    swipe.triggered = true;
    closeMobileDrawer();
  }
}

function onDrawerSwipeTouchEnd(): void {
  drawerEdgeSwipe = null;
  drawerCloseSwipe = null;
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
});

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
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onMobileKeydown);
  window.removeEventListener("pagehide", stashComposerDrafts);
  document.body.style.overflow = "";
});

const {
  draggingProjectId,
  dropTargetProjectId,
  dropTargetPosition,
  projectRemoveConfirmOpen,
  pendingRemoveProject,
  projectRowKey,
  onProjectRowClick,
  onProjectRowPointerDown,
  onProjectRowPointerUp,
  onProjectRowPointerCancel,
  canRemoveProject,
  requestRemoveProject,
  cancelRemoveProject,
  confirmRemoveProject,
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
function openSettings(): void {
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
  const laneStatus = workerLaneStatus.value;
  if (!connected.value && laneStatus?.kind === "progress") return laneStatus;
  const error = String(wsError.value ?? "").trim();
  if (error) return { kind: "error" as const, message: error };
  if (!connected.value) return { kind: "disconnected" as const, message: disconnectedStatusMessage };
  return laneStatus;
});

const advisorConnectionStatus = computed(() => {
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
  <LoginGate v-else-if="!loggedIn" @logged-in="handleLoggedIn" />
  <div
    v-else
    class="app"
    :data-active-lane="activeWorkspaceTab"
    :data-project-id="activeProjectId"
    :data-worker-message-count="messages.length"
    :data-advisor-message-count="advisorMessages.length"
    :data-worker-panel-key="workerPanelKey"
    :data-advisor-panel-key="advisorPanelKey"
    @click="closeMobileContextMenu"
    @touchstart.passive="onDrawerEdgeTouchStart"
    @touchmove.passive="onDrawerEdgeTouchMove"
    @touchend="onDrawerSwipeTouchEnd"
    @touchcancel="onDrawerSwipeTouchEnd"
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
        @click.stop="toggleMobileDrawer"
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
            v-if="activeLaneHasResume"
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
            :disabled="activeLaneBusy || activeLaneNewSessionBlocked"
            data-testid="lane-new-session"
            @click.stop="handleLaneNewSession"
          >
            <el-icon :size="16" aria-hidden="true"><ChatDotRound /></el-icon>
          </button>
          <button
            class="laneTabIconBtn"
            type="button"
            title="Clear session"
            :disabled="activeLaneBusy"
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
          @click="openSettings"
        >
          <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
        </button>
        <button
          v-if="isMobile"
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
          v-if="isMobile && mobileDrawerOpen"
          class="mobileDrawerBackdrop"
          data-testid="mobile-drawer-backdrop"
          @click="closeMobileDrawer"
        />
      </Transition>
      <Transition name="mobile-drawer">
        <aside
          v-if="!isMobile || mobileDrawerOpen"
          ref="mobileDrawerRef"
          class="left"
          :class="{ mobileDrawer: isMobile }"
          data-testid="mobile-drawer"
          @touchstart.passive="onDrawerSwipeTouchStart"
          @touchmove.passive="onDrawerSwipeTouchMove"
          @touchend="onDrawerSwipeTouchEnd"
          @touchcancel="onDrawerSwipeTouchEnd"
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
            class="mobileDrawerNavItem mobileDrawerNavItem--link"
            data-testid="mobile-drawer-section-settings"
            @click="selectMobileDrawerSection('settings')"
          >
            <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
            <span>系统设置</span>
            <el-icon class="mobileDrawerNavChevron" :size="14" aria-hidden="true"><ArrowRight /></el-icon>
          </button>
        </nav>

        <div v-if="!isMobile || mobileDrawerSection === 'projects'" class="projectTree">
          <div class="projectTreeHeader">
            <div class="projectTreeTitle">项目</div>
            <div class="projectTreeHeaderActions">
              <button type="button" class="projectAdd" title="添加项目" @click="openProjectDialogFromDrawer"><el-icon :size="16" aria-hidden="true" class="icon"><CirclePlus /></el-icon></button>
            </div>
          </div>

          <div v-for="p in projects" :key="projectRowKey(p)" class="projectNode" :class="{ active: p.id === activeProjectId }">
            <button
              type="button"
              class="projectRow"
              :class="{
                isDragging: draggingProjectId === p.id,
                dropBefore: dropTargetProjectId === p.id && dropTargetPosition === 'before',
                dropAfter: dropTargetProjectId === p.id && dropTargetPosition === 'after',
              }"
              :title="p.name"
              @pointerdown="(ev) => onProjectRowPointerDown(ev, p.id)"
              @pointerup="(ev) => onProjectRowPointerUp(ev, p.id)"
              @pointercancel="onProjectRowPointerCancel"
              @click="onProjectRowClick(p.id)"
              @dragover="(ev) => onProjectDragOver(ev, p.id)"
              @drop="(ev) => onProjectDrop(ev, p.id)"
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
                  v-if="p.id !== 'default' && p.id === activeProjectId"
                  class="projectRemove"
                  :class="{ disabled: !canRemoveProject(p.id) }"
                  title="Remove project"
                  aria-label="Remove project"
                  data-testid="project-remove"
                  @click.stop.prevent="requestRemoveProject(p.id)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
                <span v-if="!isMobile && p.id === 'default'" class="projectDragSpacer" aria-hidden="true" />
                <span
                  v-else-if="!isMobile"
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
          ref="mobileSettingsRef"
          :api="api"
          initial-tab="lane-prompts"
          :show-header="false"
          @close="closeMobileModule"
          @changed="onSettingsChanged"
        />
      </section>

      <section v-if="!isMobile || mobileDrawerSection === 'projects'" class="chatShell">
        <div class="laneTabs">
          <div class="laneTabGroup" role="tablist" aria-label="切换工作区">
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
                  :class="isLaneConnected(tab.id, { advisor: advisorConnected, worker: connected })
                    ? 'laneTabStatusDot--connected'
                    : 'laneTabStatusDot--disconnected'"
                  :data-testid="`lane-tab-status-${tab.id}`"
                  aria-hidden="true"
                />
                <span class="laneTabLabel">{{ tab.label }}</span>
                <span
                  v-if="tab.id === 'advisor' ? advisorBusy : agentBusy"
                  class="laneTabBusySpinner"
                  :class="tab.id === 'advisor' ? 'laneTabBusySpinner--advisor' : 'laneTabBusySpinner--worker'"
                  :data-testid="`lane-tab-busy-${tab.id}`"
                  aria-hidden="true"
                />
              </button>
            </template>
          </div>
          <div class="laneModelControls" data-testid="lane-model-controls">
            <MainChatModelSelectors
              :connected="activeLaneConnected"
              :busy="activeLaneBusy"
              :input-locked="activeLaneInputLocked"
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

        <div class="lanePanels">
          <section
            :id="'lane-panel-advisor'"
            v-if="activeWorkspaceTab === 'advisor'"
            class="lanePanel"
            role="tabpanel"
            aria-labelledby="lane-tab-advisor"
            data-testid="lane-panel-advisor"
            :data-message-count="advisorMessages.length"
            :data-panel-key="`${advisorPanelKey}:${errorRecoveryGeneration}`"
          >
            <MainChatView
              ref="advisorChatRef"
              :key="`${advisorPanelKey}:${errorRecoveryGeneration}`"
              class="chatHost chatHost--advisor"
              :messages="advisorMessages"
              :draft="advisorComposerDraft"
              :latest-prompt-key="advisorChatKey"
              :queued-prompts="advisorQueuedPrompts"
              :pending-images="advisorPendingImages"
              :connected="advisorConnected"
              :busy="advisorBusy"
              :input-locked="advisorInputLocked"
              :workspace-root="resolveActiveWorkspaceRoot()"
              :connection-status-kind="advisorConnectionStatus?.kind ?? null"
              :connection-status-message="advisorConnectionStatus?.message ?? null"
              :thread-warning="advisorThreadWarning"
              @send="sendAdvisorPrompt"
              @update:draft="advisorComposerDraft = $event"
              @interrupt="interruptAdvisor"
              @addImages="addAdvisorPendingImages"
              @clearImages="clearAdvisorPendingImages"
              @removeQueued="removeAdvisorQueuedPrompt"
            />
          </section>

          <section
            :id="'lane-panel-worker'"
            v-else
            class="lanePanel"
            role="tabpanel"
            aria-labelledby="lane-tab-worker"
            data-testid="lane-panel-worker"
            :data-message-count="messages.length"
            :data-panel-key="`${workerPanelKey}:${errorRecoveryGeneration}`"
          >
            <MainChatView
              ref="workerChatRef"
              :key="`${workerPanelKey}:${errorRecoveryGeneration}`"
              class="chatHost"
              :messages="messages"
              :draft="workerComposerDraft"
              :latest-prompt-key="workerLatestPromptKey"
              :queued-prompts="workerQueuedPrompts"
              :pending-images="pendingImages"
              :connected="connected"
              :busy="agentBusy"
              :input-locked="workerInputLocked"
              :workspace-root="resolveActiveWorkspaceRoot()"
              :running-task-count="runningTaskCount"
              :connection-status-kind="workerConnectionStatus?.kind ?? null"
              :connection-status-message="workerConnectionStatus?.message ?? null"
              :thread-warning="workerThreadWarning"
              @send="sendMainPrompt"
              @update:draft="workerComposerDraft = $event"
              @interrupt="interruptActive"
              @clear="clearActiveChat"
              @addImages="addPendingImages"
              @clearImages="clearPendingImages"
              @removeQueued="removeQueuedPrompt"
            />
          </section>
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

    <div v-if="projectRemoveConfirmOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="cancelRemoveProject">
      <div class="modalCard">
        <div class="modalTitle">Remove project?</div>
        <div class="modalDesc">
          This removes the project from the Web UI list only. It does not delete any files or workspace data.
        </div>
        <div v-if="pendingRemoveProject" class="modalPreview">
          <div class="modalPreviewTitle">{{ pendingRemoveProject.name || pendingRemoveProject.id }}</div>
          <div v-if="pendingRemoveProject.path && pendingRemoveProject.path.trim()" class="modalPreviewPrompt">
            {{ pendingRemoveProject.path }}
          </div>
        </div>
        <div class="modalActions">
          <button type="button" class="btnSecondary" @click="cancelRemoveProject">Cancel</button>
          <button type="button" class="btnDanger" @click="confirmRemoveProject">Remove</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./App.css" scoped></style>
