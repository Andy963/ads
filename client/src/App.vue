<script setup lang="ts">
import { computed, ref } from "vue";

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
import { CirclePlus, ChatDotRound, Setting, Document, Clock } from "@element-plus/icons-vue";
const {
  isExecuteBlockFixture,
  loggedIn,
  handleLoggedIn,
  isMobile,
  mobilePane,
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
  agentDelegations,
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
} = createAppController();

const modelManagerOpen = ref(false);
const globalRuleManagerOpen = ref(false);

const chatLanes: Array<{ id: ChatLane; label: string }> = [
  { id: "planner", label: "Advisor" },
  { id: "worker", label: "Worker" },
];

const {
  activeChatLane,
  plannerMessages,
  plannerQueuedPrompts,
  plannerPendingImages,
  plannerConnected,
  plannerBusy,
  plannerInputLocked,
  plannerLaneStatus,
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
  requestProjectSwitch,
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

function openModelManager(): void {
  modelManagerOpen.value = true;
}

function closeModelManager(): void {
  modelManagerOpen.value = false;
}

function openGlobalRuleManager(): void {
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
  <div v-else class="app">
    <header class="topbar">
      <div class="brand">ADS</div>
      <div class="topbarMain">
        <div v-if="isMobile" class="paneTabs" role="tablist" aria-label="切换面板">
          <button
            type="button"
            class="paneTab"
            :class="{ active: mobilePane === 'tasks' }"
            role="tab"
            :aria-selected="mobilePane === 'tasks'"
            @click="mobilePane = 'tasks'"
          >
            项目
          </button>
          <button
            type="button"
            class="paneTab"
            :class="{ active: mobilePane === 'chat' }"
            role="tab"
            :aria-selected="mobilePane === 'chat'"
            @click="mobilePane = 'chat'"
          >
            对话
          </button>
        </div>
      </div>
      <div class="right">
        <button
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
          type="button"
          class="topbarIconBtn"
          title="全局规则"
          aria-label="全局规则"
          data-testid="global-rule-manager-open"
          @click="openGlobalRuleManager"
        >
          <el-icon :size="16" aria-hidden="true"><Document /></el-icon>
        </button>
        <span class="dot" :class="{ on: connected }" :title="connected ? 'WS connected' : 'WS disconnected'" />
      </div>
    </header>

    <main class="layout" :data-pane="mobilePane">
      <aside class="left">
        <div class="projectTree">
          <div class="projectTreeHeader">
            <div class="projectTreeTitle">项目</div>
            <button type="button" class="projectAdd" title="添加项目" @click="openProjectDialog"><el-icon :size="16" aria-hidden="true" class="icon"><CirclePlus /></el-icon></button>
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
                <span v-if="p.id === 'default'" class="projectDragSpacer" aria-hidden="true" />
                <span
                  v-else
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

            <div v-if="p.expanded" class="projectTasks">
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
                />
              </div>
            </div>
        </div>
      </aside>

      <section class="chatShell">
        <div class="laneTabs" role="tablist" aria-label="切换对话 lane">
          <button
            v-for="lane in chatLanes"
            :id="`lane-tab-${lane.id}`"
            :key="lane.id"
            type="button"
            class="laneTab"
            :class="{ active: activeChatLane === lane.id }"
            role="tab"
            :aria-selected="activeChatLane === lane.id"
            :aria-controls="`lane-panel-${lane.id}`"
            :data-testid="`lane-tab-${lane.id}`"
            @click="activeChatLane = lane.id"
          >
            {{ lane.label }}
          </button>
          <span v-if="activeLaneThreadWarning" class="laneTabWarning" data-testid="lane-thread-warning">
            {{ activeLaneThreadWarning }}
          </span>
          <span class="laneTabSpacer" />
          <button
            v-if="activeLaneHasResume"
            class="laneTabIconBtn"
            type="button"
            title="从历史会话中选择一个恢复"
            data-testid="lane-resume-thread"
            @click.stop="openSessionPicker"
          >
            <el-icon :size="15" aria-hidden="true"><Clock /></el-icon>
          </button>
          <button
            class="laneTabIconBtn"
            type="button"
            title="新会话"
            :disabled="activeLaneBusy || activeLaneNewSessionBlocked"
            data-testid="lane-new-session"
            @click.stop="handleLaneNewSession"
          >
            <el-icon :size="16" aria-hidden="true"><ChatDotRound /></el-icon>
          </button>
        </div>

        <div class="lanePanels">
          <section
            :id="'lane-panel-planner'"
            v-show="activeChatLane === 'planner'"
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
              :agent-delegations="plannerAgentDelegations"
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
            v-show="activeChatLane === 'worker'"
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
              :agent-delegations="agentDelegations"
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
