<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";

import { createAppController } from "./app/controller";
import { CirclePlus } from "@element-plus/icons-vue";
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
  plansByTaskId,
  expanded,
  apiAuthorized,
  runBusyIds,
  select,
  togglePlan,
  ensurePlan,
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
  queuedPrompts,
  pendingImages,
  agentBusy,
  sendMainPrompt,
  interruptActive,
  addPendingImages,
  clearPendingImages,
  removeQueuedPrompt,
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

let suppressProjectRowClick = false;

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

function canMoveProjectToTop(projectId: string): boolean {
  const id = String(projectId ?? "").trim();
  if (!canDragProject(id)) return false;
  const ids = projects.value.filter((p) => p.id !== "default").map((p) => p.id);
  return ids.indexOf(id) > 0;
}

async function moveProjectToTop(projectId: string): Promise<void> {
  const id = String(projectId ?? "").trim();
  if (!canDragProject(id)) return;

  const ids = projects.value.filter((p) => p.id !== "default").map((p) => p.id);
  const idx = ids.indexOf(id);
  if (idx <= 0) return;

  ids.splice(idx, 1);
  ids.unshift(id);
  await reorderProjects(ids);
}

function onProjectMoveToTopClick(ev: MouseEvent, projectId: string): void {
  if (!canMoveProjectToTop(projectId)) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  void moveProjectToTop(projectId);
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
              :title="p.path || p.name"
              @click="onProjectRowClick(p.id)"
              @dragover="(ev) => onProjectDragOver(ev, p.id)"
              @drop="(ev) => onProjectDrop(ev, p.id)"
            >
              <span class="projectStatus" :class="{ spinning: runtimeProjectInProgress(getRuntime(p.id)) }" />
              <span class="projectText">
                <span class="projectName">{{ p.path || p.name }}</span>
                <span class="projectBranch">{{ formatProjectBranch(p.branch) }}</span>
              </span>
              <span class="projectRowActions">
                <span
                  class="projectMoveToTop"
                  :class="{ disabled: !canMoveProjectToTop(p.id) }"
                  title="Move to top"
                  @click="(ev) => onProjectMoveToTopClick(ev, p.id)"
                >
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M4 3h12v2H4V3zm6 14V8.9l2.8 2.8 1.4-1.4L10 5.7 5.8 10.3l1.4 1.4L9 8.9V17h2z" />
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

              <TaskBoard
                class="taskBoard"
                :tasks="tasks"
                :models="models"
                :selected-id="selectedId"
                :plans="plansByTaskId"
                :expanded="expanded"
                :queue-status="queueStatus"
                :can-run-single="apiAuthorized"
                :run-busy-ids="runBusyIds"
                @select="select"
                @togglePlan="togglePlan"
                @ensurePlan="ensurePlan"
                @update="({ id, updates }) => updateQueuedTask(id, updates)"
                @update-and-run="({ id, updates }) => updateQueuedTaskAndRun(id, updates)"
                @reorder="(ids) => reorderPendingTasks(ids)"
                @queueRun="runTaskQueue"
                @queuePause="pauseTaskQueue"
                @runSingle="(id) => runSingleTask(id)"
                @cancel="cancelTask"
                @retry="retryTask"
                @delete="deleteTask"
                @create="openTaskCreateDialog"
                @resumeThread="resumeTaskThread"
                @newSession="startNewChatSession"
              />
            </div>
          </div>
        </div>
      </aside>

      <section class="rightPane">
        <MainChatView
          :key="activeProjectId"
          class="chatHost"
          :messages="messages"
          :queued-prompts="queuedPrompts.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length }))"
          :pending-images="pendingImages"
          :connected="connected"
          :busy="agentBusy"
          @send="sendMainPrompt"
          @interrupt="interruptActive"
          @clear="clearActiveChat"
          @addImages="addPendingImages"
          @clearImages="clearPendingImages"
          @removeQueued="removeQueuedPrompt"
        />
      </section>
    </main>

    <div v-if="apiNotice" class="noticeToast" role="status" aria-live="polite">
      <span class="noticeToastText">{{ apiNotice }}</span>
    </div>

    <DraggableModal v-if="taskCreateDialogOpen" card-variant="wide" @close="closeTaskCreateDialog">
      <TaskCreateForm
        class="taskCreateModal"
        :models="models"
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
