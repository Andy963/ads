<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

declare const __APP_VERSION__: string | undefined;
const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.1";

import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import TaskBundleDraftPanel from "./components/TaskBundleDraftPanel.vue";
import ModelManager from "./components/ModelManager.vue";
import GlobalRuleManager from "./components/GlobalRuleManager.vue";
import SessionResumePicker from "./components/SessionResumePicker.vue";

import { createAppController } from "./app/controller";
import type { TaskBundle } from "./api/types";
import { useLaneRuntimeBridge, type ChatLane } from "./composables/app/useLaneRuntimeBridge";
import { useProjectSidebar } from "./composables/app/useProjectSidebar";
import { MODEL_AGENT_GROUPS, type AgentKind } from "./lib/model_agent";
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
  connectWs,
  runtimeProjectInProgress,
  formatProjectBranch,
  queueStatus,
  apiError,
  wsError,
  tasks,
  selectedId,
  apiAuthorized,
  runBusyIds,
  select,
  updateQueuedTask,
  updateQueuedTaskAndRun,
  reorderPendingTasks,
  runTaskQueue,
  pauseTaskQueue,
  createTask,
  runSingleTask,
  cancelTask,
  retryTask,
  deleteTask,
  onTaskEvent,
  openTaskCreateDialog,
  resumeTaskThread,
  listResumableSessions,
  resumePlannerThread,
  clearActiveChat,
  clearPlannerChat,
  startNewChatSession,
  messages,
  activeRuntime,
  activePlannerRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  loadTaskBundleDrafts,
  updateTaskBundleDraft,
  deleteTaskBundleDraft,
  approveTaskBundleDraft,
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
  taskCreateDialogOpen,
  closeTaskCreateDialog,
  resolveActiveWorkspaceRoot,
  submitTaskCreate,
  submitTaskCreateAndRun,
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
  deleteConfirmOpen,
  pendingDeleteTask,
  cancelDeleteTask,
  confirmDeleteTask,
  deleteConfirmButtonEl,
  goalPause,
  goalResume,
  goalClear,
  reviewTaskAction,
} = createAppController();

const modelManagerOpen = ref(false);
const globalRuleManagerOpen = ref(false);

type MobileDrawerSection = "projects" | "rules" | "models";
type MobileContextActionId =
  | "resume"
  | "new-session"
  | "create-task"
  | "create-rule"
  | "refresh-rules"
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
const mobileModelAgent = ref<AgentKind | null>(null);
const mobileTaskTabActive = ref(false);
const mobileContextMenuOpen = ref(false);
const mobileGlobalRuleManagerRef = ref<MobileManagerHandle | null>(null);
const mobileModelManagerRef = ref<MobileManagerHandle | null>(null);

const chatLanes: Array<{ id: ChatLane; label: string }> = [
  { id: "planner", label: "Advisor" },
  { id: "worker", label: "Worker" },
];
const workspaceTabs = computed<Array<{ id: MobileWorkspaceTab; label: string }>>(() =>
  isMobile.value ? [{ id: "tasks", label: "Task" }, ...chatLanes] : chatLanes,
);
const activeWorkspaceTab = computed<MobileWorkspaceTab>(() =>
  mobileTaskTabActive.value ? "tasks" : activeChatLane.value,
);

const {
  activeChatLane,
  plannerMessages,
  plannerQueuedPrompts,
  plannerPendingImages,
  plannerConnected,
  plannerBusy,
  plannerInputLocked,
  plannerLaneStatus,
  plannerDrafts,
  plannerDraftsBusy,
  plannerDraftsError,
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
  queueStatus,
  tasks,
  queuedPrompts,
  pendingImages,
  agentBusy,
  clearActiveChat,
  clearPlannerChat,
  startNewChatSession,
  resumePlannerThread,
  resumeTaskThread,
  listResumableSessions,
});

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
  if (mobileDrawerSection.value === "rules") return "规则";
  if (mobileDrawerSection.value === "models") {
    const selected = MODEL_AGENT_GROUPS.find((group) => group.kind === mobileModelAgent.value);
    return selected?.label || "Provider";
  }
  return activeProject.value?.name?.trim() || "项目";
});

const mobileContextMenuTitle = computed(() => {
  if (mobileDrawerSection.value === "rules") return "规则操作";
  if (mobileDrawerSection.value === "models") {
    return mobileModelAgent.value ? `${mobileContextTitle.value} 操作` : "Provider";
  }
  if (mobileTaskTabActive.value) return "任务操作";
  return "项目操作";
});

const mobileContextActions = computed<MobileContextAction[]>(() => {
  if (mobileDrawerSection.value === "rules") {
    return [
      { id: "create-rule", label: "新增规则" },
      { id: "refresh-rules", label: "刷新规则" },
    ];
  }
  if (mobileDrawerSection.value === "models") {
    if (!mobileModelAgent.value) return [];
    return [
      { id: "create-model", label: "新增模型" },
      { id: "refresh-models", label: "刷新模型列表" },
    ];
  }
  if (mobileTaskTabActive.value) {
    return [{ id: "create-task", label: "新增任务" }];
  }
  return [
    { id: "create-task", label: "新增任务" },
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
    if (section !== "models") mobileModelAgent.value = null;
  }
  mobileDrawerOpen.value = true;
  mobileContextMenuOpen.value = false;
}

function toggleMobileDrawer(): void {
  if (mobileDrawerOpen.value) closeMobileDrawer();
  else openMobileDrawer();
}

function selectWorkspaceTab(tab: MobileWorkspaceTab): void {
  if (tab === "tasks") {
    mobileTaskTabActive.value = true;
  } else {
    mobileTaskTabActive.value = false;
    activeChatLane.value = tab;
  }
  if (isMobile.value) writeMobileWorkspaceTab(activeProjectId.value, tab);
  closeMobileContextMenu();
}

function restoreMobileWorkspaceTab(): void {
  const projectId = activeProjectId.value.trim();
  const tab = readMobileWorkspaceTab(projectId);
  mobileTaskTabActive.value = tab === "tasks";
  if (tab !== "tasks") activeChatLane.value = tab;
}

function selectMobileDrawerSection(section: MobileDrawerSection): void {
  mobileDrawerSection.value = section;
  if (section !== "models") mobileModelAgent.value = null;
  mobileContextMenuOpen.value = false;
  if (section === "rules") closeMobileDrawer();
}

function selectMobileModelAgent(agent: AgentKind): void {
  mobileDrawerSection.value = "models";
  mobileModelAgent.value = agent;
  mobileContextMenuOpen.value = false;
  closeMobileDrawer();
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
  if (actionId === "create-task") {
    closeMobileDrawer();
    openTaskCreateDialog();
    return;
  }
  if (actionId === "create-rule") {
    mobileGlobalRuleManagerRef.value?.create();
    return;
  }
  if (actionId === "refresh-rules") {
    void mobileGlobalRuleManagerRef.value?.refresh();
    return;
  }
  if (actionId === "create-model") {
    mobileModelManagerRef.value?.create();
    return;
  }
  if (actionId === "refresh-models") {
    void mobileModelManagerRef.value?.refresh();
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
  mobileModelAgent.value = null;
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
  mobileTaskTabActive.value = false;
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
  runtimeProjectInProgress,
  requestProjectSwitch: requestProjectSwitchFromMobile,
  reorderProjects,
  removeProject,
});
function refreshPlannerDrafts(): void {
  void loadTaskBundleDrafts(activeProjectId.value);
}

function onApproveDraft(payload: { id: string; runQueue: boolean }): void {
  void approveTaskBundleDraft(payload.id, { runQueue: payload.runQueue, projectId: activeProjectId.value });
}

function onUpdateDraft(payload: { id: string; bundle: TaskBundle }): void {
  void updateTaskBundleDraft(payload.id, payload.bundle, activeProjectId.value);
}

function onDeleteDraft(id: string): void {
  void deleteTaskBundleDraft(id, activeProjectId.value);
}

function openTaskCreateDialogHandler(): void {
  openTaskCreateDialog();
}

async function saveTask(payload: { id: string; updates: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }> {
  return await updateQueuedTask(payload.id, payload.updates);
}

async function saveTaskAndRun(payload: { id: string; updates: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }> {
  return await updateQueuedTaskAndRun(payload.id, payload.updates);
}

function onReviewAction(payload: {
  taskId: string;
  action: "force_approve" | "edit_rework" | "skip_review" | "abort";
  feedback?: string;
  reason?: string;
}): void {
  void reviewTaskAction({ ...payload, projectId: activeProjectId.value });
}

function openModelManager(): void {
  if (isMobile.value) {
    openMobileDrawer("models");
    return;
  }
  modelManagerOpen.value = true;
}

function closeModelManager(): void {
  modelManagerOpen.value = false;
}

function openGlobalRuleManager(): void {
  if (isMobile.value) {
    openMobileDrawer("rules");
    return;
  }
  globalRuleManagerOpen.value = true;
}

function closeGlobalRuleManager(): void {
  globalRuleManagerOpen.value = false;
}

async function onModelManagerChanged(): Promise<void> {
  try {
    await loadModels();
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
}

const runningTaskCount = computed(() =>
  tasks.value.filter((t) => t.status === "running" || t.status === "planning").length,
);

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
          title="管理模型"
          aria-label="管理模型"
          data-testid="model-manager-open"
          @click="openModelManager"
        >
          <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
        </button>
        <button
          v-if="!isMobile"
          type="button"
          class="topbarIconBtn"
          title="全局规则"
          aria-label="全局规则"
          data-testid="global-rule-manager-open"
          @click="openGlobalRuleManager"
        >
          <el-icon :size="16" aria-hidden="true"><Document /></el-icon>
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
            :class="{ active: mobileDrawerSection === 'rules' }"
            :aria-current="mobileDrawerSection === 'rules' ? 'page' : undefined"
            data-testid="mobile-drawer-section-rules"
            @click="selectMobileDrawerSection('rules')"
          >
            <el-icon :size="16" aria-hidden="true"><Document /></el-icon>
            <span>规则</span>
          </button>
          <button
            type="button"
            class="mobileDrawerNavItem"
            :class="{ active: mobileDrawerSection === 'models' }"
            :aria-current="mobileDrawerSection === 'models' ? 'page' : undefined"
            data-testid="mobile-drawer-section-models"
            @click="selectMobileDrawerSection('models')"
          >
            <el-icon :size="16" aria-hidden="true"><Setting /></el-icon>
            <span>Provider</span>
          </button>
        </nav>

        <div v-if="isMobile && mobileDrawerSection === 'models'" class="mobileDrawerSubitems" aria-label="Provider CLI">
          <button
            v-for="group in MODEL_AGENT_GROUPS"
            :key="group.kind"
            type="button"
            class="mobileDrawerSubitem"
            :class="{ active: mobileModelAgent === group.kind }"
            :data-testid="`mobile-drawer-model-${group.kind}`"
            @click="selectMobileModelAgent(group.kind)"
          >
            <span class="mobileDrawerSubitemText">
              <strong>{{ group.label }}</strong>
              <small>{{ group.description }}</small>
            </span>
          </button>
        </div>

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
              <span class="projectStatus" :class="{ spinning: runtimeProjectInProgress(getRuntime(p.id)) }" />
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

            <div v-if="!isMobile && p.expanded" class="projectTasks">
              <div v-if="queueStatus && (!queueStatus.enabled || !queueStatus.ready)" class="error">
                <div>任务队列未运行：{{ !queueStatus.enabled ? "TASK_QUEUE_ENABLED=false" : queueStatus.error || "agent not ready" }}</div>
                <div style="margin-top: 6px; opacity: 0.85">
                  任务会保持 pending；请在启动 web server 前配置模型 Key，并确保 `TASK_QUEUE_ENABLED=true`。
                </div>
              </div>
              <div v-if="apiError" class="error">API: {{ apiError }}</div>
              <div v-if="wsError" class="error">WS: {{ wsError }}</div>
              <TaskBundleDraftPanel
                v-if="plannerDrafts.length > 0 || plannerDraftsError"
                :drafts="plannerDrafts"
                :busy="plannerDraftsBusy"
                :error="plannerDraftsError"
                @refresh="refreshPlannerDrafts"
                @approve="onApproveDraft"
                @update="onUpdateDraft"
                @delete="onDeleteDraft"
              />

                <TaskBoard
                  class="taskBoard"
                  :tasks="tasks"
                  :api="api"
                  :workspace-root="resolveActiveWorkspaceRoot()"
                  :agents="workerAgents"
                  :active-agent-id="workerActiveAgentId"
                  :selected-id="selectedId"
                  :queue-status="queueStatus"
                  :can-run-single="apiAuthorized"
                  :show-create-button="!isMobile"
                  :update-task="saveTask"
                  :update-task-and-run="saveTaskAndRun"
                :run-busy-ids="runBusyIds"
                @select="select"
                @update="({ id, updates }) => updateQueuedTask(id, updates)"
                @update-and-run="({ id, updates }) => updateQueuedTaskAndRun(id, updates)"
                @reorder="(ids) => reorderPendingTasks(ids)"
                @queueRun="runTaskQueue"
                @queuePause="pauseTaskQueue"
                  @runSingle="(id) => runSingleTask(id)"
                  @cancel="cancelTask"
                  @retry="retryTask"
                  @delete="deleteTask"
                  @create="openTaskCreateDialogHandler"
                  @goal-pause="(id) => goalPause(id)"
                  @goal-resume="(id) => goalResume(id)"
                  @goal-clear="(id) => goalClear(id)"
                  @review-action="onReviewAction"
                />
              </div>
            </div>
        </div>
      </aside>

      <section v-if="isMobile && mobileDrawerSection !== 'projects'" class="mobileMainPanel">
        <GlobalRuleManager
          v-if="mobileDrawerSection === 'rules'"
          ref="mobileGlobalRuleManagerRef"
          :api="api"
          :show-header="false"
          :show-add-button="false"
          @close="closeMobileModule"
        />
        <ModelManager
          v-else-if="mobileDrawerSection === 'models' && mobileModelAgent"
          :key="mobileModelAgent"
          ref="mobileModelManagerRef"
          :api="api"
          :agent="mobileModelAgent"
          :show-header="false"
          @close="closeMobileModule"
          @changed="onModelManagerChanged"
        />
        <div v-else-if="mobileDrawerSection === 'models'" class="mobileModuleEmpty">
          <el-icon :size="30" aria-hidden="true"><Setting /></el-icon>
          <strong>选择一个 Provider</strong>
          <span>打开左上角导航，从 Provider 下面选择 Codex 或 Claude。</span>
        </div>
      </section>

      <section v-if="!isMobile || mobileDrawerSection === 'projects'" class="chatShell">
        <div class="laneTabs" role="tablist" aria-label="切换工作区">
          <button
            v-for="tab in workspaceTabs"
            :id="`lane-tab-${tab.id}`"
            :key="tab.id"
            type="button"
            class="laneTab"
            :class="{
              active: activeWorkspaceTab === tab.id,
              'laneTab--connected': isLaneConnected(tab.id, { planner: plannerConnected, worker: connected }),
              'laneTab--disconnected': tab.id !== 'tasks' && !isLaneConnected(tab.id, { planner: plannerConnected, worker: connected }),
            }"
            role="tab"
            :aria-selected="activeWorkspaceTab === tab.id"
            :aria-controls="`lane-panel-${tab.id}`"
            :data-testid="`lane-tab-${tab.id}`"
            @click="selectWorkspaceTab(tab.id)"
          >
            {{ tab.label }}
          </button>
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
              :agents="plannerAgents"
              :active-agent-id="plannerActiveAgentId"
              :models="models"
              :model-id="activePlannerRuntime.modelId.value"
              :model-reasoning-effort="activePlannerRuntime.modelReasoningEffort.value"
              :workspace-root="resolveActiveWorkspaceRoot()"
              :connection-status-kind="plannerConnectionStatus?.kind ?? null"
              :connection-status-message="plannerConnectionStatus?.message ?? null"
              @send="sendPlannerPrompt"
              @update:draft="plannerComposerDraft = $event"
              @switchAgent="switchPlannerAgent"
              @setModel="setPlannerModelId"
              @setReasoningEffort="setPlannerModelReasoningEffort"
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
              :agents="workerAgents"
              :active-agent-id="workerActiveAgentId"
              :models="models"
              :model-id="activeRuntime.modelId.value"
              :model-reasoning-effort="activeRuntime.modelReasoningEffort.value"
              :workspace-root="resolveActiveWorkspaceRoot()"
              :running-task-count="runningTaskCount"
              :connection-status-kind="workerConnectionStatus?.kind ?? null"
              :connection-status-message="workerConnectionStatus?.message ?? null"
              @send="sendMainPrompt"
              @update:draft="workerComposerDraft = $event"
              @switchAgent="switchMainAgent"
              @setModel="setMainModelId"
              @setReasoningEffort="setMainModelReasoningEffort"
              @interrupt="interruptActive"
              @clear="clearActiveChat"
              @addImages="addPendingImages"
              @clearImages="clearPendingImages"
              @removeQueued="removeQueuedPrompt"
            />
          </section>

          <section
            v-if="isMobile"
            :id="'lane-panel-tasks'"
            v-show="activeWorkspaceTab === 'tasks'"
            class="lanePanel taskLanePanel"
            role="tabpanel"
            aria-labelledby="lane-tab-tasks"
            data-testid="lane-panel-tasks"
          >
            <div class="mobileTaskWorkspace">
              <div v-if="queueStatus && (!queueStatus.enabled || !queueStatus.ready)" class="error">
                <div>任务队列未运行：{{ !queueStatus.enabled ? "TASK_QUEUE_ENABLED=false" : queueStatus.error || "agent not ready" }}</div>
                <div style="margin-top: 6px; opacity: 0.85">
                  任务会保持 pending；请在启动 web server 前配置模型 Key，并确保 `TASK_QUEUE_ENABLED=true`。
                </div>
              </div>
              <div v-if="apiError" class="error">API: {{ apiError }}</div>
              <div v-if="wsError" class="error">WS: {{ wsError }}</div>

              <TaskBundleDraftPanel
                v-if="plannerDrafts.length > 0 || plannerDraftsError"
                :drafts="plannerDrafts"
                :busy="plannerDraftsBusy"
                :error="plannerDraftsError"
                @refresh="refreshPlannerDrafts"
                @approve="onApproveDraft"
                @update="onUpdateDraft"
                @delete="onDeleteDraft"
              />

              <TaskBoard
                class="taskBoard"
                :tasks="tasks"
                :api="api"
                :workspace-root="resolveActiveWorkspaceRoot()"
                :agents="workerAgents"
                :active-agent-id="workerActiveAgentId"
                :selected-id="selectedId"
                :queue-status="queueStatus"
                :can-run-single="apiAuthorized"
                :show-create-button="false"
                :update-task="saveTask"
                :update-task-and-run="saveTaskAndRun"
                :run-busy-ids="runBusyIds"
                @select="select"
                @update="({ id, updates }) => updateQueuedTask(id, updates)"
                @update-and-run="({ id, updates }) => updateQueuedTaskAndRun(id, updates)"
                @reorder="(ids) => reorderPendingTasks(ids)"
                @queueRun="runTaskQueue"
                @queuePause="pauseTaskQueue"
                @runSingle="(id) => runSingleTask(id)"
                @cancel="cancelTask"
                @retry="retryTask"
                @delete="deleteTask"
                @create="openTaskCreateDialogHandler"
                @goal-pause="(id) => goalPause(id)"
                @goal-resume="(id) => goalResume(id)"
                @goal-clear="(id) => goalClear(id)"
                @review-action="onReviewAction"
              />
            </div>
          </section>
        </div>
      </section>
    </main>

    <div v-if="apiNotice" class="noticeToast" role="status" aria-live="polite">
      <span class="noticeToastText">{{ apiNotice }}</span>
    </div>

    <DraggableModal v-if="taskCreateDialogOpen" card-variant="large" @close="closeTaskCreateDialog">
      <TaskCreateForm
        :workspace-root="resolveActiveWorkspaceRoot() || ''"
        :agents="workerAgents"
        :active-agent-id="workerActiveAgentId"
        @submit="submitTaskCreate"
        @submit-and-run="submitTaskCreateAndRun"
        @reset-thread="clearActiveChat"
        @cancel="closeTaskCreateDialog"
      />
    </DraggableModal>

    <DraggableModal v-if="modelManagerOpen" card-variant="large" @close="closeModelManager">
      <ModelManager :api="api" @close="closeModelManager" @changed="onModelManagerChanged" />
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

    <DraggableModal v-if="globalRuleManagerOpen" card-variant="large" @close="closeGlobalRuleManager">
      <GlobalRuleManager :api="api" @close="closeGlobalRuleManager" />
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

    <div v-if="deleteConfirmOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="cancelDeleteTask">
      <div class="modalCard">
        <div class="modalTitle">删除任务？</div>
        <div class="modalDesc">确定删除该任务吗？删除后无法恢复。</div>
        <div v-if="pendingDeleteTask" class="modalPreview">
          <div class="modalPreviewTitle">{{ pendingDeleteTask.title || pendingDeleteTask.id }}</div>
          <div v-if="pendingDeleteTask.prompt && pendingDeleteTask.prompt.trim()" class="modalPreviewPrompt">
            {{ pendingDeleteTask.prompt.length > 240 ? `${pendingDeleteTask.prompt.slice(0, 240)}…` : pendingDeleteTask.prompt }}
          </div>
        </div>
        <div class="modalActions">
          <button type="button" class="btnSecondary" @click="cancelDeleteTask">取消</button>
          <button ref="deleteConfirmButtonEl" type="button" class="btnDanger" @click="confirmDeleteTask">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./App.css" scoped></style>
