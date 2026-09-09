<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

declare const __APP_VERSION__: string | undefined;
const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.1";

import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import MainChatView from "./components/MainChat.vue";
import MainChatModelPopover from "./components/MainChatModelPopover.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import ModelManager from "./components/ModelManager.vue";
import SessionResumePicker from "./components/SessionResumePicker.vue";

import { createAppController } from "./app/controller";
import { useLaneRuntimeBridge, type ChatLane } from "./composables/app/useLaneRuntimeBridge";
import { useProjectSidebar } from "./composables/app/useProjectSidebar";
import {
  readMobileWorkspaceTab,
  writeMobileWorkspaceTab,
  type MobileWorkspaceTab,
} from "./lib/mobileWorkspacePreferences";
import {
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
  getPlannerRuntime,
  connectWs,
  runtimeProjectInProgress,
  formatProjectBranch,
  apiError,
  wsError,
  apiAuthorized,
  resumeTaskThread,
  listResumableSessions,
  resumePlannerThread,
  clearActiveChat,
  clearPlannerChat,
  startNewPlannerSession,
  startNewChatSession,
  messages,
  activeRuntime,
  activePlannerRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  sendMainPrompt,
  sendPlannerPrompt,
  setMainModelId,
  setPlannerModelId,
  setMainModelReasoningEffort,
  setPlannerModelReasoningEffort,
  switchMainAgent,
  switchPlannerAgent,
  interruptActive,
  interruptPlanner,
  addPendingImages,
  clearPendingImages,
  addPlannerPendingImages,
  clearPlannerPendingImages,
  removeQueuedPrompt,
  removePlannerQueuedPrompt,
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
  { id: "planner", label: "Advisor" },
  { id: "worker", label: "Worker" },
];
const workspaceTabs = computed<Array<{ id: ChatLane; label: string }>>(() => chatLanes);
const activeWorkspaceTab = computed<ChatLane>(() => activeChatLane.value);

const {
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
  activePlannerRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  clearActiveChat,
  clearPlannerChat,
  startNewPlannerSession,
  startNewChatSession,
  resumePlannerThread,
  resumeTaskThread,
  listResumableSessions,
});

const activeLaneConnected = computed(() =>
  activeWorkspaceTab.value === "planner" ? Boolean(plannerConnected.value) : Boolean(connected.value),
);
const activeLaneInputLocked = computed(() =>
  activeWorkspaceTab.value === "planner" ? Boolean(plannerInputLocked.value) : Boolean(workerInputLocked.value),
);
const activeLaneAgents = computed(() =>
  activeWorkspaceTab.value === "planner" ? plannerAgents.value : workerAgents.value,
);
const activeLaneActiveAgentId = computed(() =>
  activeWorkspaceTab.value === "planner" ? plannerActiveAgentId.value : workerActiveAgentId.value,
);
const activeLaneModelId = computed(() =>
  activeWorkspaceTab.value === "planner"
    ? activePlannerRuntime.value.modelId.value
    : activeRuntime.value.modelId.value,
);
const activeLaneModelReasoningEffort = computed(() =>
  activeWorkspaceTab.value === "planner"
    ? activePlannerRuntime.value.modelReasoningEffort.value
    : activeRuntime.value.modelReasoningEffort.value,
);
const hasActiveLaneModelSettings = computed(() =>
  activeLaneAgents.value !== undefined || models.value !== undefined,
);

function handleActiveLaneSwitchAgent(agentId: string): void {
  if (activeWorkspaceTab.value === "planner") {
    switchPlannerAgent(agentId);
  } else {
    switchMainAgent(agentId);
  }
}

function handleActiveLaneSetModel(modelId: string): void {
  if (activeWorkspaceTab.value === "planner") {
    setPlannerModelId(modelId);
  } else {
    setMainModelId(modelId);
  }
}

function handleActiveLaneSetReasoningEffort(effort: string): void {
  if (activeWorkspaceTab.value === "planner") {
    setPlannerModelReasoningEffort(effort);
  } else {
    setMainModelReasoningEffort(effort);
  }
}

type ProjectBusyState = "idle" | "advisor" | "worker" | "both";

function projectBusyState(projectId: string): ProjectBusyState {
  const advisorBusy = runtimeProjectInProgress(getPlannerRuntime(projectId));
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

const newSessionDisabledReason = computed(() => {
  if (activeLaneBusy.value) return "当前对话正在生成，结束后才能新建会话";
  if (activeLaneNewSessionBlocked.value) return "当前 Advisor 尚未连接，暂时无法新建会话";
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
  activeChatLane.value = tab;
  if (isMobile.value) writeMobileWorkspaceTab(activeProjectId.value, tab);
  closeMobileContextMenu();
}

function restoreMobileWorkspaceTab(): void {
  const projectId = activeProjectId.value.trim();
  const tab = readMobileWorkspaceTab(projectId);
  activeChatLane.value = tab;
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

watch(isMobile, (mobile) => {
  if (mobile) {
    restoreMobileWorkspaceTab();
    return;
  }
  closeMobileDrawer();
});

watch(activeProjectId, (projectId, previousProjectId) => {
  if (!isMobile.value || !projectId.trim() || projectId === previousProjectId) return;
  restoreMobileWorkspaceTab();
});

onMounted(() => {
  window.addEventListener("keydown", onMobileKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onMobileKeydown);
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
  getPlannerRuntime,
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

const plannerConnectionStatus = computed(() => {
  const laneStatus = plannerLaneStatus.value;
  if (!plannerConnected.value && laneStatus?.kind === "progress") return laneStatus;
  const error = String(activePlannerRuntime.value.wsError.value ?? "").trim();
  if (error) return { kind: "error" as const, message: error };
  if (!plannerConnected.value) return { kind: "disconnected" as const, message: disconnectedStatusMessage };
  return laneStatus;
});

</script>

<template>
  <ExecuteBlockFixture v-if="isExecuteBlockFixture" />
  <LoginGate v-else-if="!loggedIn" @logged-in="handleLoggedIn" />
  <div v-else class="app" @click="closeMobileContextMenu">
    <header class="topbar">
      <button
        v-if="isMobile"
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
      <div class="brand">
        <span>ADS</span>
        <span class="brandVersion">v{{ appVersion }}</span>
      </div>
      <div class="topbarMain">
        <div v-if="isMobile" class="mobileContextTitle" :title="mobileContextTitle">
          {{ mobileContextTitle }}
        </div>
      </div>
      <div class="right">
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
        <div class="mobileContextMenuTitle">{{ mobileContextMenuTitle }}</div>
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
          <span v-if="action.disabled" class="mobileContextActionHint">
            {{
              action.id === "resume"
                ? sessionResumeDisabledReason
                : newSessionDisabledReason
            }}
          </span>
        </button>
      </div>
    </header>

    <main class="layout">
      <div
        v-if="isMobile && mobileDrawerOpen"
        class="mobileDrawerBackdrop"
        data-testid="mobile-drawer-backdrop"
        @click="closeMobileDrawer"
      />
      <aside
        v-if="!isMobile || mobileDrawerOpen"
        class="left"
        :class="{ mobileDrawer: isMobile }"
        data-testid="mobile-drawer"
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
            class="mobileDrawerNavItem"
            :class="{ active: mobileDrawerSection === 'settings' }"
            :aria-current="mobileDrawerSection === 'settings' ? 'page' : undefined"
            data-testid="mobile-drawer-section-settings"
            @click="selectMobileDrawerSection('settings')"
          >
            <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
            <span>系统设置</span>
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
      </aside>

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
        <div class="laneTabs" role="tablist" aria-label="切换工作区">
          <div class="laneTabGroup">
            <button
              v-for="tab in workspaceTabs"
              :id="`lane-tab-${tab.id}`"
              :key="tab.id"
              type="button"
              class="laneTab"
              :class="{ active: activeWorkspaceTab === tab.id }"
              role="tab"
              :aria-selected="activeWorkspaceTab === tab.id"
              :aria-controls="`lane-panel-${tab.id}`"
              :data-testid="`lane-tab-${tab.id}`"
              @click="selectWorkspaceTab(tab.id)"
            >
              <span
                class="laneTabStatusDot"
                :class="isLaneConnected(tab.id, { planner: plannerConnected, worker: connected })
                  ? 'laneTabStatusDot--connected'
                  : 'laneTabStatusDot--disconnected'"
                :data-testid="`lane-tab-status-${tab.id}`"
                aria-hidden="true"
              />
              <span class="laneTabLabel">{{ tab.label }}</span>
              <span
                v-if="tab.id === 'planner' ? plannerBusy : agentBusy"
                class="laneTabBusySpinner"
                :class="tab.id === 'planner' ? 'laneTabBusySpinner--advisor' : 'laneTabBusySpinner--worker'"
                :data-testid="`lane-tab-busy-${tab.id}`"
                aria-hidden="true"
              />
            </button>
          </div>
          <MainChatModelPopover
            v-if="hasActiveLaneModelSettings"
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
          <span v-if="!isMobile" class="laneTabSpacer" />
          <button
            v-if="!isMobile && activeLaneHasResume"
            class="laneTabIconBtn"
            type="button"
            title="从历史会话中选择一个恢复"
            data-testid="lane-resume-thread"
            @click.stop="openSessionPicker"
          >
            <el-icon :size="15" aria-hidden="true"><Clock /></el-icon>
          </button>
          <button
            v-if="!isMobile"
            class="laneTabIconBtn"
            type="button"
            title="新会话"
            :disabled="activeLaneBusy || activeLaneNewSessionBlocked"
            data-testid="lane-new-session"
            @click.stop="handleLaneNewSession"
          >
            <el-icon :size="16" aria-hidden="true"><ChatDotRound /></el-icon>
          </button>
          <button
            v-if="!isMobile"
            class="laneTabIconBtn"
            type="button"
            title="清空会话"
            :disabled="activeLaneBusy"
            data-testid="lane-clear-chat"
            @click.stop="handleLaneClearChat"
          >
            <el-icon :size="15" aria-hidden="true"><Delete /></el-icon>
          </button>
        </div>

        <div class="lanePanels">
          <section
            :id="'lane-panel-planner'"
            v-show="activeWorkspaceTab === 'planner'"
            class="lanePanel"
            role="tabpanel"
            aria-labelledby="lane-tab-planner"
            data-testid="lane-panel-planner"
          >
            <MainChatView
              :key="plannerChatKey"
              class="chatHost chatHost--planner"
              :messages="plannerMessages"
              :draft="plannerComposerDraft"
              :latest-prompt-key="plannerChatKey"
              :queued-prompts="plannerQueuedPrompts"
              :pending-images="plannerPendingImages"
              :connected="plannerConnected"
              :busy="plannerBusy"
              :input-locked="plannerInputLocked"
              :workspace-root="resolveActiveWorkspaceRoot()"
              :connection-status-kind="plannerConnectionStatus?.kind ?? null"
              :connection-status-message="plannerConnectionStatus?.message ?? null"
              :thread-warning="plannerThreadWarning"
              @send="sendPlannerPrompt"
              @update:draft="plannerComposerDraft = $event"
              @interrupt="interruptPlanner"
              @addImages="addPlannerPendingImages"
              @clearImages="clearPlannerPendingImages"
              @removeQueued="removePlannerQueuedPrompt"
            />
          </section>

          <section
            :id="'lane-panel-worker'"
            v-show="activeWorkspaceTab === 'worker'"
            class="lanePanel"
            role="tabpanel"
            aria-labelledby="lane-tab-worker"
            data-testid="lane-panel-worker"
          >
            <MainChatView
              :key="workerChatKey"
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
