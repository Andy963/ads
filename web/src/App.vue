<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import PromptsModal from "./components/PromptsModal.vue";
import TaskBundleDraftPanel from "./components/TaskBundleDraftPanel.vue";

import { createAppController } from "./app/controller";
import type { TaskBundle } from "./api/types";
import { CirclePlus, Setting } from "@element-plus/icons-vue";
const {
  isExecuteBlockFixture,
  loggedIn,
  handleLoggedIn,
  isMobile,
  mobilePane,
  connected,
  openProjectDialog,
  projects,
  activeProjectId,
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
  threadWarning,
  tasks,
  models,
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
  clearActiveChat,
  startNewChatSession,
  messages,
  activeRuntime,
  activePlannerRuntime,
  queuedPrompts,
  pendingImages,
  agentBusy,
  promptsModalOpen,
  prompts,
  promptsBusy,
  promptsError,
  loadPrompts,
  openPromptsModal,
  closePromptsModal,
  createPrompt,
  updatePrompt,
  deletePrompt,
  loadTaskBundleDrafts,
  updateTaskBundleDraft,
  deleteTaskBundleDraft,
  approveTaskBundleDraft,
  agentDelegations,
  sendMainPrompt,
  sendPlannerPrompt,
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
} = createAppController();

const draggingProjectId = ref<string | null>(null);
const dropTargetProjectId = ref<string | null>(null);
const dropTargetPosition = ref<"before" | "after">("before");

const workerDrawerOpen = ref(false);

const plannerMessages = computed(() => activePlannerRuntime.value.messages.value);
const plannerQueuedPrompts = computed(() =>
  activePlannerRuntime.value.queuedPrompts.value.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length })),
);
const plannerPendingImages = computed(() => activePlannerRuntime.value.pendingImages.value);
const plannerConnected = computed(() => activePlannerRuntime.value.connected.value);
const plannerBusy = computed(() => activePlannerRuntime.value.busy.value);
const plannerAgentDelegations = computed(() => activePlannerRuntime.value.delegationsInFlight.value);
const plannerDrafts = computed(() => activePlannerRuntime.value.taskBundleDrafts.value);
const plannerDraftsBusy = computed(() => activePlannerRuntime.value.taskBundleDraftsBusy.value);
const plannerDraftsError = computed(() => activePlannerRuntime.value.taskBundleDraftsError.value);
const workerAgents = computed(() => activeRuntime.value.availableAgents.value);
const workerActiveAgentId = computed(() => activeRuntime.value.activeAgentId.value);
const plannerAgents = computed(() => activePlannerRuntime.value.availableAgents.value);
const plannerActiveAgentId = computed(() => activePlannerRuntime.value.activeAgentId.value);

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

const projectRemoveConfirmOpen = ref(false);
const pendingRemoveProjectId = ref<string | null>(null);
const pendingRemoveProject = computed(() => {
  const pid = String(pendingRemoveProjectId.value ?? "").trim();
  if (!pid) return null;
  return projects.value.find((p) => p.id === pid) ?? null;
});

let suppressProjectRowClick = false;

function openTaskCreateDialogWithPrompts(): void {
  openTaskCreateDialog();
  // Best-effort: prompt list may still be loading when the dialog opens, but will
  // populate reactively once fetched.
  void loadPrompts();
}

function canDragProject(id: string): boolean {
  const pid = String(id ?? "").trim();
  return pid !== "default";
}

function scheduleSuppressProjectRowClick(): void {
  suppressProjectRowClick = true;
  setTimeout(() => {
    suppressProjectRowClick = false;
  }, 0);
}

function onProjectRowClick(projectId: string): void {
  if (suppressProjectRowClick) return;
  requestProjectSwitch(projectId);
}

function canRemoveProject(id: string): boolean {
  const pid = String(id ?? "").trim();
  if (!pid) return false;
  if (pid === "default") return false;
  return !runtimeProjectInProgress(getRuntime(pid));
}

function requestRemoveProject(id: string): void {
  const pid = String(id ?? "").trim();
  if (!canRemoveProject(pid)) return;
  pendingRemoveProjectId.value = pid;
  projectRemoveConfirmOpen.value = true;
}

function cancelRemoveProject(): void {
  projectRemoveConfirmOpen.value = false;
  pendingRemoveProjectId.value = null;
}

async function confirmRemoveProject(): Promise<void> {
  const pid = String(pendingRemoveProjectId.value ?? "").trim();
  projectRemoveConfirmOpen.value = false;
  pendingRemoveProjectId.value = null;
  if (!pid) return;
  await removeProject(pid);
}

function onProjectDragStart(ev: DragEvent, projectId: string): void {
  const id = String(projectId ?? "").trim();
  if (!canDragProject(id)) return;

  draggingProjectId.value = id;
  dropTargetProjectId.value = null;
  dropTargetPosition.value = "before";
  try {
    ev.dataTransfer?.setData("text/plain", id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  } catch {
    // ignore
  }
}

function onProjectDragEnd(): void {
  draggingProjectId.value = null;
  dropTargetProjectId.value = null;
  dropTargetPosition.value = "before";
}

function onProjectDragOver(ev: DragEvent, targetProjectId: string): void {
  const dragging = draggingProjectId.value;
  const targetId = String(targetProjectId ?? "").trim();
  if (!dragging) return;
  if (!canDragProject(targetId)) return;
  if (dragging === targetId) return;

  ev.preventDefault();
  try {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  } catch {
    // ignore
  }

  dropTargetProjectId.value = targetId;
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) {
    dropTargetPosition.value = "before";
    return;
  }
  const rect = el.getBoundingClientRect();
  const midpoint = rect.top + rect.height / 2;
  dropTargetPosition.value = ev.clientY > midpoint ? "after" : "before";
}

async function onProjectDrop(ev: DragEvent, targetProjectId: string): Promise<void> {
  const dragging = draggingProjectId.value;
  const targetId = String(targetProjectId ?? "").trim();
  const position = dropTargetPosition.value;
  if (dragging) scheduleSuppressProjectRowClick();
  onProjectDragEnd();

  if (!dragging) return;
  if (!targetId) return;
  if (!canDragProject(targetId)) return;
  if (dragging === targetId) return;

  ev.preventDefault();

  const ids = projects.value.filter((p) => p.id !== "default").map((p) => p.id);
  const fromIdx = ids.indexOf(dragging);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;

  ids.splice(fromIdx, 1);
  const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
  const insertAt = position === "after" ? adjustedTo + 1 : adjustedTo;
  ids.splice(Math.max(0, Math.min(ids.length, insertAt)), 0, dragging);
  await reorderProjects(ids);
}


const updateViewportHeightVar = (): void => {
  if (typeof window === "undefined") return;
  const vv = window.visualViewport;
  const height = vv && Number.isFinite(vv.height) && vv.height > 0 ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--ads-visual-viewport-height", `${Math.round(height)}px`);
};

onMounted(() => {
  updateViewportHeightVar();
  window.addEventListener("resize", updateViewportHeightVar, { passive: true });
  window.visualViewport?.addEventListener("resize", updateViewportHeightVar, { passive: true });
  window.visualViewport?.addEventListener("scroll", updateViewportHeightVar, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateViewportHeightVar);
  window.visualViewport?.removeEventListener("resize", updateViewportHeightVar);
  window.visualViewport?.removeEventListener("scroll", updateViewportHeightVar);
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
        <button v-if="isMobile" type="button" class="topbarWorker" title="Worker" @click="workerDrawerOpen = true">
          Worker
        </button>
        <button
          type="button"
          class="topbarGear"
          title="Prompts"
          aria-label="Prompts"
          data-testid="prompts-button"
          @click="openPromptsModal"
        >
          <el-icon :size="16" aria-hidden="true" class="icon"><Setting /></el-icon>
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

          <div v-for="p in projects" :key="p.id" class="projectNode" :class="{ active: p.id === activeProjectId }">
            <button
              type="button"
              class="projectRow"
              :class="{
                isDragging: draggingProjectId === p.id,
                dropBefore: dropTargetProjectId === p.id && dropTargetPosition === 'before',
                dropAfter: dropTargetProjectId === p.id && dropTargetPosition === 'after',
              }"
              :title="p.name"
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
                  v-if="p.id !== 'default'"
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
              <div v-if="threadWarning" class="warning">{{ threadWarning }}</div>

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
                :models="models"
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
                @create="openTaskCreateDialogWithPrompts"
                @resumeThread="resumeTaskThread"
                @newSession="startNewChatSession"
              />
            </div>
          </div>
        </div>
      </aside>

      <section class="plannerPane">
        <MainChatView
          :key="activeProjectId"
          class="chatHost chatHost--planner"
          title="Planner"
          :messages="plannerMessages"
          :queued-prompts="plannerQueuedPrompts"
          :pending-images="plannerPendingImages"
          :connected="plannerConnected"
          :busy="plannerBusy"
          :agents="plannerAgents"
          :active-agent-id="plannerActiveAgentId"
          :agent-delegations="plannerAgentDelegations"
          @send="sendPlannerPrompt"
          @switchAgent="switchPlannerAgent"
          @interrupt="interruptPlanner"
          @addImages="addPlannerPendingImages"
          @clearImages="clearPlannerPendingImages"
          @removeQueued="removePlannerQueuedPrompt"
        />
      </section>

      <section v-if="!isMobile" class="workerPane">
        <MainChatView
          :key="activeProjectId"
          class="chatHost"
          title="Worker"
          :messages="messages"
          :queued-prompts="queuedPrompts.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length }))"
          :pending-images="pendingImages"
          :connected="connected"
          :busy="agentBusy"
          :agents="workerAgents"
          :active-agent-id="workerActiveAgentId"
          :agent-delegations="agentDelegations"
          @send="sendMainPrompt"
          @switchAgent="switchMainAgent"
          @interrupt="interruptActive"
          @clear="clearActiveChat"
          @addImages="addPendingImages"
          @clearImages="clearPendingImages"
          @removeQueued="removeQueuedPrompt"
        />
      </section>
    </main>

    <div
      v-if="isMobile && workerDrawerOpen"
      class="workerDrawerOverlay"
      role="dialog"
      aria-modal="true"
      @click.self="workerDrawerOpen = false"
    >
      <div class="workerDrawer">
        <div class="workerDrawerHeader">
          <div class="workerDrawerTitle">Worker</div>
          <button type="button" class="workerDrawerClose" @click="workerDrawerOpen = false">Close</button>
        </div>
        <MainChatView
          :key="activeProjectId"
          class="chatHost"
          :messages="messages"
          :queued-prompts="queuedPrompts.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length }))"
          :pending-images="pendingImages"
          :connected="connected"
          :busy="agentBusy"
          :agents="workerAgents"
          :active-agent-id="workerActiveAgentId"
          :agent-delegations="agentDelegations"
          @send="sendMainPrompt"
          @switchAgent="switchMainAgent"
          @interrupt="interruptActive"
          @clear="clearActiveChat"
          @addImages="addPendingImages"
          @clearImages="clearPendingImages"
          @removeQueued="removeQueuedPrompt"
        />
      </div>
    </div>

    <div v-if="apiNotice" class="noticeToast" role="status" aria-live="polite">
      <span class="noticeToastText">{{ apiNotice }}</span>
    </div>

    <PromptsModal
      v-if="promptsModalOpen"
      data-testid="prompts-modal"
      :prompts="prompts"
      :busy="promptsBusy"
      :error="promptsError"
      @close="closePromptsModal"
      @create="(input) => createPrompt(input)"
      @update="(id, input) => updatePrompt(id, input)"
      @delete="(id) => deletePrompt(id)"
    />

    <DraggableModal v-if="taskCreateDialogOpen" card-variant="wide" @close="closeTaskCreateDialog">
      <TaskCreateForm
        class="taskCreateModal"
        :prompts="prompts"
        :prompts-busy="promptsBusy"
        :workspace-root="resolveActiveWorkspaceRoot() || ''"
        @submit="submitTaskCreate"
        @submit-and-run="submitTaskCreateAndRun"
        @reset-thread="clearActiveChat"
        @cancel="closeTaskCreateDialog"
      />
    </DraggableModal>

    <div v-if="projectDialogOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="closeProjectDialog">
      <div class="modalCard">
        <div class="modalTitle">添加项目</div>
        <div class="modalDesc">每个项目会对应一个独立会话（session），对话和工作目录互不串。</div>

        <div class="modalForm">
          <label class="modalLabel" for="project-path">项目目录路径（PC 上的路径）</label>
          <input
            id="project-path"
            v-model="projectDialogPath"
            ref="projectPathEl"
            class="modalInput"
            placeholder="例如: /home/andy/ads"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter.prevent="focusProjectName"
            @blur="validateProjectDialogPath()"
            @input="onProjectDialogPathInput"
          />
          <div class="modalHintRow">
            <div
              v-if="projectDialogPathStatus !== 'idle' && projectDialogPathMessage"
              class="pathStatus"
              :class="projectDialogPathStatus"
              :title="projectDialogPathMessage"
            >
              {{ projectDialogPathMessage }}
            </div>
            <button class="inlineAction" type="button" :disabled="!workspacePath" @click="useCurrentWorkspacePath">使用当前目录</button>
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
