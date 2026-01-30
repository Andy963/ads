<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { ApiClient } from "./api/client";
import type { AuthMe, CreateTaskInput, ModelConfig, PlanStep, Task, TaskDetail, TaskEventPayload, TaskQueueStatus } from "./api/types";
import { AdsWebSocket } from "./api/ws";
import LoginGate from "./components/LoginGate.vue";
import DraggableModal from "./components/DraggableModal.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";
import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import { finalizeStreamingOnDisconnect, mergeHistoryFromServer } from "./lib/chat_sync";
import { formatApiError, looksLikeNotFound } from "./lib/api_error";
import { clearLiveActivityWindow, createLiveActivityWindow, ingestCommandActivity, ingestExploredActivity, renderLiveActivityMarkdown } from "./lib/live_activity";
import { isProjectInProgress } from "./lib/project_status";

const PROJECTS_KEY = "ADS_WEB_PROJECTS";
const ACTIVE_PROJECT_KEY = "ADS_WEB_ACTIVE_PROJECT";
const LEGACY_WS_SESSION_KEY = "ADS_WEB_SESSION";

type WorkspaceState = { path?: string; rules?: string; modified?: string[]; branch?: string };
type ProjectTab = {
  id: string;
  name: string;
  path: string;
  sessionId: string;
  initialized: boolean;
  createdAt: number;
  updatedAt: number;
  branch?: string;
  expanded?: boolean;
};

type BufferedTaskChatEvent =
  | { kind: "message"; role: "user" | "assistant" | "system"; content: string }
  | { kind: "delta"; role: "assistant"; delta: string; source?: "chat" | "step"; modelUsed?: string | null }
  | { kind: "command"; command: string };

type TaskChatBuffer = { firstTs: number; events: BufferedTaskChatEvent[] };

const TASK_CHAT_BUFFER_TTL_MS = 5 * 60_000;
const TASK_CHAT_BUFFER_MAX_EVENTS = 64;

const fixtureMode = computed(() => {
  try {
    return new URLSearchParams(window.location.search).get("fixture") || "";
  } catch {
    return "";
  }
});
const isExecuteBlockFixture = computed(() => fixtureMode.value === "execute-block");

const loggedIn = ref(false);
const currentUser = ref<AuthMe | null>(null);

const projects = ref<ProjectTab[]>([]);
const activeProjectId = ref("");
const projectDialogOpen = ref(false);
const projectDialogPath = ref("");
const projectDialogName = ref("");
const projectDialogError = ref<string | null>(null);
const switchConfirmOpen = ref(false);
const pendingSwitchProjectId = ref<string | null>(null);
const deleteConfirmOpen = ref(false);
const pendingDeleteTaskId = ref<string | null>(null);
const deleteConfirmButtonEl = ref<HTMLButtonElement | null>(null);
const taskCreateDialogOpen = ref(false);
const projectPathEl = ref<HTMLInputElement | null>(null);
const projectNameEl = ref<HTMLInputElement | null>(null);
const projectDialogPathStatus = ref<"idle" | "checking" | "ok" | "error">("idle");
const projectDialogPathMessage = ref("");
const lastValidatedProjectPath = ref("");
let lastValidatedProjectSessionId = "";
let projectPathValidationSeq = 0;

type PathValidateResponse = {
  ok: boolean;
  allowed: boolean;
  exists: boolean;
  isDirectory: boolean;
  resolvedPath?: string;
  workspaceRoot?: string;
  projectSessionId?: string;
  error?: string;
  allowedDirs?: string[];
};

const api = new ApiClient({ baseUrl: "" });

const models = ref<ModelConfig[]>([]);

// Keep the command panel focused: show only the most recent few commands.
const MAX_RECENT_COMMANDS = 5;
const MAX_LIVE_ACTIVITY_STEPS = 5;
const MAX_TURN_COMMANDS = 64;
const MAX_EXECUTE_PREVIEW_LINES = 3;
// Avoid unbounded in-memory growth during long-running sessions.
const MAX_CHAT_MESSAGES = 200;

type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  command?: string;
  hiddenLineCount?: number;
  ts?: number;
  streaming?: boolean;
};
const LIVE_STEP_ID = "live-step";
const LIVE_ACTIVITY_ID = "live-activity";
const LIVE_MESSAGE_IDS = [LIVE_STEP_ID, LIVE_ACTIVITY_ID] as const;

function isLiveMessageId(id: string): boolean {
  return (LIVE_MESSAGE_IDS as readonly string[]).includes(id);
}

function findFirstLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = idx < 0 ? at : Math.min(idx, at);
  }
  return idx;
}

function findLastLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = Math.max(idx, at);
  }
  return idx;
}
type IncomingImage = { name?: string; mime?: string; data: string };
type QueuedPrompt = { id: string; clientMessageId: string; text: string; images: IncomingImage[]; createdAt: number };

const isMobile = ref(false);
const mobilePane = ref<"tasks" | "chat">("chat");

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);

type ProjectRuntime = {
  projectSessionId: string;
  connected: ReturnType<typeof ref<boolean>>;
  apiError: ReturnType<typeof ref<string | null>>;
  apiNotice: ReturnType<typeof ref<string | null>>;
  wsError: ReturnType<typeof ref<string | null>>;
  threadWarning: ReturnType<typeof ref<string | null>>;
  activeThreadId: ReturnType<typeof ref<string | null>>;
  queueStatus: ReturnType<typeof ref<TaskQueueStatus | null>>;
  workspacePath: ReturnType<typeof ref<string>>;
  tasks: ReturnType<typeof ref<Task[]>>;
  selectedId: ReturnType<typeof ref<string | null>>;
  expanded: ReturnType<typeof ref<Set<string>>>;
  plansByTaskId: ReturnType<typeof ref<Map<string, PlanStep[]>>>;
  planFetchInFlightByTaskId: Map<string, Promise<void>>;
  runBusyIds: ReturnType<typeof ref<Set<string>>>;
  busy: ReturnType<typeof ref<boolean>>;
  turnInFlight: boolean;
  pendingAckClientMessageId: string | null;
  messages: ReturnType<typeof ref<ChatItem[]>>;
  recentCommands: ReturnType<typeof ref<string[]>>;
  turnCommands: string[];
  executePreviewByKey: Map<string, { key: string; command: string; previewLines: string[]; totalLines: number; remainder: string }>;
  executeOrder: string[];
  seenCommandIds: Set<string>;
  pendingImages: ReturnType<typeof ref<IncomingImage[]>>;
  queuedPrompts: ReturnType<typeof ref<QueuedPrompt[]>>;
  ignoreNextHistory: boolean;
  ws: AdsWebSocket | null;
  reconnectTimer: number | null;
  reconnectAttempts: number;
  pendingCdRequestedPath: string | null;
  suppressNextClearHistoryResult: boolean;
  noticeTimer: number | null;
  liveActivity: ReturnType<typeof createLiveActivityWindow>;
  startedTaskIds: Set<string>;
  taskChatBufferByTaskId: Map<string, TaskChatBuffer>;
};

function createProjectRuntime(): ProjectRuntime {
  return {
    projectSessionId: "",
    connected: ref(false),
    apiError: ref<string | null>(null),
    apiNotice: ref<string | null>(null),
    wsError: ref<string | null>(null),
    threadWarning: ref<string | null>(null),
    activeThreadId: ref<string | null>(null),
    queueStatus: ref<TaskQueueStatus | null>(null),
    workspacePath: ref(""),
    tasks: ref<Task[]>([]),
    selectedId: ref<string | null>(null),
    expanded: ref<Set<string>>(new Set()),
    plansByTaskId: ref<Map<string, PlanStep[]>>(new Map()),
    planFetchInFlightByTaskId: new Map(),
    runBusyIds: ref<Set<string>>(new Set()),
    busy: ref(false),
    turnInFlight: false,
    pendingAckClientMessageId: null,
    messages: ref<ChatItem[]>([]),
    recentCommands: ref<string[]>([]),
    turnCommands: [],
    executePreviewByKey: new Map(),
    executeOrder: [],
    seenCommandIds: new Set<string>(),
    pendingImages: ref<IncomingImage[]>([]),
    queuedPrompts: ref<QueuedPrompt[]>([]),
    ignoreNextHistory: false,
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    pendingCdRequestedPath: null,
    suppressNextClearHistoryResult: false,
    noticeTimer: null,
    liveActivity: createLiveActivityWindow(MAX_LIVE_ACTIVITY_STEPS),
    startedTaskIds: new Set<string>(),
    taskChatBufferByTaskId: new Map<string, TaskChatBuffer>(),
  };
}

const runtimeByProjectId = new Map<string, ProjectRuntime>();

function normalizeProjectId(id: string | null | undefined): string {
  const trimmed = String(id ?? "").trim();
  return trimmed || "default";
}

function getRuntime(projectId: string | null | undefined): ProjectRuntime {
  const id = normalizeProjectId(projectId);
  const existing = runtimeByProjectId.get(id);
  if (existing) return existing;
  const created = createProjectRuntime();
  runtimeByProjectId.set(id, created);
  return created;
}

const activeRuntime = computed(() => getRuntime(activeProjectId.value));

const connected = computed({
  get: () => activeRuntime.value.connected.value,
  set: (v: boolean) => {
    activeRuntime.value.connected.value = v;
  },
});
const apiError = computed({
  get: () => activeRuntime.value.apiError.value,
  set: (v: string | null) => {
    activeRuntime.value.apiError.value = v;
  },
});
const apiNotice = computed({
  get: () => activeRuntime.value.apiNotice.value,
  set: (v: string | null) => {
    activeRuntime.value.apiNotice.value = v;
  },
});
const wsError = computed({
  get: () => activeRuntime.value.wsError.value,
  set: (v: string | null) => {
    activeRuntime.value.wsError.value = v;
  },
});
const threadWarning = computed({
  get: () => activeRuntime.value.threadWarning.value,
  set: (v: string | null) => {
    activeRuntime.value.threadWarning.value = v;
  },
});
const activeThreadId = computed({
  get: () => activeRuntime.value.activeThreadId.value,
  set: (v: string | null) => {
    activeRuntime.value.activeThreadId.value = v;
  },
});
const queueStatus = computed({
  get: () => activeRuntime.value.queueStatus.value,
  set: (v: TaskQueueStatus | null) => {
    activeRuntime.value.queueStatus.value = v;
  },
});
const workspacePath = computed({
  get: () => activeRuntime.value.workspacePath.value,
  set: (v: string) => {
    activeRuntime.value.workspacePath.value = v;
  },
});
const tasks = computed({
  get: () => activeRuntime.value.tasks.value,
  set: (v: Task[]) => {
    activeRuntime.value.tasks.value = v;
  },
});
const selectedId = computed({
  get: () => activeRuntime.value.selectedId.value,
  set: (v: string | null) => {
    activeRuntime.value.selectedId.value = v;
  },
});
const expanded = computed({
  get: () => activeRuntime.value.expanded.value,
  set: (v: Set<string>) => {
    activeRuntime.value.expanded.value = v;
  },
});
const plansByTaskId = computed({
  get: () => activeRuntime.value.plansByTaskId.value,
  set: (v: Map<string, PlanStep[]>) => {
    activeRuntime.value.plansByTaskId.value = v;
  },
});
const runBusyIds = computed({
  get: () => activeRuntime.value.runBusyIds.value,
  set: (v: Set<string>) => {
    activeRuntime.value.runBusyIds.value = v;
  },
});
const busy = computed({
  get: () => activeRuntime.value.busy.value,
  set: (v: boolean) => {
    activeRuntime.value.busy.value = v;
  },
});
const messages = computed({
  get: () => activeRuntime.value.messages.value,
  set: (v: ChatItem[]) => {
    activeRuntime.value.messages.value = v;
  },
});
const recentCommands = computed({
  get: () => activeRuntime.value.recentCommands.value,
  set: (v: string[]) => {
    activeRuntime.value.recentCommands.value = v;
  },
});
const pendingImages = computed({
  get: () => activeRuntime.value.pendingImages.value,
  set: (v: IncomingImage[]) => {
    activeRuntime.value.pendingImages.value = v;
  },
});
const queuedPrompts = computed({
  get: () => activeRuntime.value.queuedPrompts.value,
  set: (v: QueuedPrompt[]) => {
    activeRuntime.value.queuedPrompts.value = v;
  },
});

const tasksBusy = computed(() => tasks.value.some((t) => t.status === "planning" || t.status === "running"));
const agentBusy = computed(() => busy.value || tasksBusy.value);

const pendingDeleteTask = computed(() => tasks.value.find((t) => t.id === pendingDeleteTaskId.value) ?? null);

function updateIsMobile(): void {
  if (typeof window === "undefined") return;
  isMobile.value = window.matchMedia?.("(max-width: 900px)")?.matches ?? window.innerWidth <= 900;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function randomUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return randomId("uuid");
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

type PersistedPrompt = { clientMessageId: string; text: string; createdAt: number };

function pendingPromptStorageKey(sessionId: string): string {
  const normalized = String(sessionId ?? "").trim();
  return normalized ? `ads.pendingPrompt.${normalized}` : "ads.pendingPrompt.unknown";
}

function savePendingPrompt(rt: ProjectRuntime, prompt: QueuedPrompt): void {
  if (!rt.projectSessionId) return;
  // Avoid persisting large image payloads into sessionStorage.
  if (prompt.images.length > 0) return;
  const key = pendingPromptStorageKey(rt.projectSessionId);
  const payload: PersistedPrompt = {
    clientMessageId: prompt.clientMessageId,
    text: prompt.text,
    createdAt: prompt.createdAt,
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function clearPendingPrompt(rt: ProjectRuntime): void {
  if (!rt.projectSessionId) return;
  const key = pendingPromptStorageKey(rt.projectSessionId);
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function restorePendingPrompt(rt: ProjectRuntime): void {
  if (!rt.projectSessionId) return;
  const key = pendingPromptStorageKey(rt.projectSessionId);
  const stored = safeJsonParse<PersistedPrompt>(sessionStorage.getItem(key));
  if (!stored) return;
  const clientMessageId = String(stored.clientMessageId ?? "").trim();
  const text = String(stored.text ?? "");
  if (!clientMessageId) return;
  const alreadyQueued = rt.queuedPrompts.value.some((q) => q.clientMessageId === clientMessageId);
  if (alreadyQueued) return;
  if (runtimeAgentBusy(rt)) return;
  rt.queuedPrompts.value = [
    { id: randomId("q"), clientMessageId, text, images: [], createdAt: Number(stored.createdAt) || Date.now() },
    ...rt.queuedPrompts.value,
  ];
}

function deriveProjectName(path: string): string {
  const normalized = String(path ?? "").trim();
  if (!normalized) return "Project";
  const cleaned = normalized.replace(/[\\/]+$/g, "");
  const parts = cleaned.split(/[\\/]+/g).filter(Boolean);
  return parts[parts.length - 1] ?? "Project";
}

function createProjectTab(params: { path: string; name?: string; sessionId?: string; initialized?: boolean }): ProjectTab {
  const now = Date.now();
  const sessionId = params.sessionId?.trim() || (crypto.randomUUID?.() ?? randomId("sess"));
  const id = sessionId;
  const path = String(params.path ?? "").trim();
  const name = String(params.name ?? "").trim() || deriveProjectName(path);
  const initialized = params.initialized ?? !path;
  return { id, name, path, sessionId, initialized, createdAt: now, updatedAt: now, expanded: false };
}

function persistProjects(): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects.value));
    localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId.value);
  } catch {
    // ignore
  }
}

function initializeProjects(): void {
  const stored = safeJsonParse<ProjectTab[]>(localStorage.getItem(PROJECTS_KEY));
  const normalized: ProjectTab[] = Array.isArray(stored)
    ? stored
        .map((p) => {
          const sessionId = String((p as Partial<ProjectTab>)?.sessionId ?? "").trim();
          const path = String((p as Partial<ProjectTab>)?.path ?? "").trim();
          const name = String((p as Partial<ProjectTab>)?.name ?? "").trim() || deriveProjectName(path);
          if (!sessionId) return null;
          return createProjectTab({
            path,
            name,
            sessionId,
            initialized: Boolean((p as Partial<ProjectTab>)?.initialized) || !path,
          });
        })
        .filter((p): p is ProjectTab => Boolean(p))
    : [];

  if (normalized.length === 0) {
    const legacySession = String(localStorage.getItem(LEGACY_WS_SESSION_KEY) ?? "").trim();
    normalized.push(createProjectTab({ path: "", name: "默认", sessionId: legacySession || undefined, initialized: true }));
  }

  const storedActive = String(localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "").trim();
  const initialActive = normalized.some((p) => p.id === storedActive) ? storedActive : normalized[0]!.id;
  activeProjectId.value = initialActive;
  projects.value = normalized.map((p) => ({ ...p, expanded: p.id === initialActive }));
  persistProjects();
}

function updateProject(id: string, updates: Partial<ProjectTab>): void {
  const targetId = String(id ?? "").trim();
  if (!targetId) return;
  const next = projects.value.map((p) => {
    if (p.id !== targetId) return p;
    return { ...p, ...updates, updatedAt: Date.now() };
  });
  projects.value = next;
  persistProjects();
}

function setExpandedExclusive(targetId: string, expanded: boolean): void {
  const tid = String(targetId ?? "").trim();
  if (!tid) return;
  const now = Date.now();
  projects.value = projects.value.map((p) => {
    if (expanded) {
      const nextExpanded = p.id === tid;
      if (p.expanded === nextExpanded) return p;
      return { ...p, expanded: nextExpanded, updatedAt: now };
    }
    if (p.id !== tid) return p;
    if (!p.expanded) return p;
    return { ...p, expanded: false, updatedAt: now };
  });
  persistProjects();
}

function collapseAllProjects(): void {
  const now = Date.now();
  let changed = false;
  const next = projects.value.map((p) => {
    if (!p.expanded) return p;
    changed = true;
    return { ...p, expanded: false, updatedAt: now };
  });
  if (!changed) return;
  projects.value = next;
  persistProjects();
}

function clearChatState(): void {
  busy.value = false;
  activeRuntime.value.pendingCdRequestedPath = null;
  queuedPrompts.value = [];
  pendingImages.value = [];
  recentCommands.value = [];
  activeRuntime.value.turnCommands = [];
  activeRuntime.value.executePreviewByKey.clear();
  activeRuntime.value.executeOrder = [];
  activeRuntime.value.turnInFlight = false;
  threadWarning.value = null;
  activeThreadId.value = null;
  clearStepLive();
  finalizeCommandBlock();
  setMessages([]);
}

function performProjectSwitch(id: string): void {
  const nextId = String(id ?? "").trim();
  if (!nextId) return;
  if (nextId === activeProjectId.value) return;

  activeProjectId.value = nextId;
  setExpandedExclusive(nextId, true);
  void activateProject(nextId);
}

function requestProjectSwitch(id: string): void {
  const nextId = String(id ?? "").trim();
  if (!nextId) return;

  if (nextId === activeProjectId.value) {
    const nextExpanded = !activeProject.value?.expanded;
    if (nextExpanded) {
      setExpandedExclusive(nextId, true);
    } else {
      collapseAllProjects();
    }
    return;
  }
  performProjectSwitch(nextId);
}

function formatProjectBranch(branch?: string): string {
  const normalized = String(branch ?? "").trim();
  if (!normalized) return "-";
  if (normalized === "HEAD") return "detached";
  return normalized;
}

function cancelProjectSwitch(): void {
  switchConfirmOpen.value = false;
  pendingSwitchProjectId.value = null;
}

function confirmProjectSwitch(): void {
  const target = pendingSwitchProjectId.value;
  switchConfirmOpen.value = false;
  pendingSwitchProjectId.value = null;
  if (target) performProjectSwitch(target);
}

function cancelDeleteTask(): void {
  deleteConfirmOpen.value = false;
  pendingDeleteTaskId.value = null;
}

async function confirmDeleteTask(): Promise<void> {
  const taskId = pendingDeleteTaskId.value;
  deleteConfirmOpen.value = false;
  pendingDeleteTaskId.value = null;
  if (!taskId) return;

  apiError.value = null;
  try {
    await api.delete<{ success: boolean }>(withWorkspaceQuery(`/api/tasks/${taskId}`));
    tasks.value = tasks.value.filter((x) => x.id !== taskId);
    expanded.value = new Set([...expanded.value].filter((x) => x !== taskId));
    plansByTaskId.value.delete(taskId);
    plansByTaskId.value = new Map(plansByTaskId.value);

    if (selectedId.value === taskId) {
      selectedId.value = tasks.value[0]?.id ?? null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

function openProjectDialog(): void {
  projectDialogError.value = null;
  projectDialogName.value = "";
  projectDialogPath.value = "";
  projectDialogPathStatus.value = "idle";
  projectDialogPathMessage.value = "";
  lastValidatedProjectPath.value = "";
  projectDialogOpen.value = true;
  void nextTick(() => projectPathEl.value?.focus());
}

function closeProjectDialog(): void {
  projectDialogOpen.value = false;
  projectDialogError.value = null;
  projectDialogPathStatus.value = "idle";
  projectDialogPathMessage.value = "";
  lastValidatedProjectPath.value = "";
}

function useCurrentWorkspacePath(): void {
  if (!workspacePath.value.trim()) return;
  projectDialogPath.value = workspacePath.value.trim();
  if (!projectDialogName.value.trim()) {
    projectDialogName.value = deriveProjectName(projectDialogPath.value);
  }
  void nextTick(() => projectNameEl.value?.focus());
  void validateProjectDialogPath({ force: true });
}

function focusProjectName(): void {
  if (!projectDialogName.value.trim() && projectDialogPath.value.trim()) {
    projectDialogName.value = deriveProjectName(projectDialogPath.value);
  }
  void nextTick(() => projectNameEl.value?.focus());
}

function onProjectDialogPathInput(): void {
  if (projectDialogPathStatus.value !== "idle") {
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
  }
  lastValidatedProjectPath.value = "";
  lastValidatedProjectSessionId = "";
}

async function validateProjectDialogPath(options?: { force?: boolean }): Promise<boolean> {
  const path = projectDialogPath.value.trim();
  if (!path) {
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
    lastValidatedProjectPath.value = "";
    lastValidatedProjectSessionId = "";
    return false;
  }

  if (!options?.force && lastValidatedProjectPath.value === path && projectDialogPathStatus.value !== "checking") {
    return projectDialogPathStatus.value === "ok";
  }

  const seq = (projectPathValidationSeq += 1);
  projectDialogPathStatus.value = "checking";
  projectDialogPathMessage.value = "检查中…";

  try {
    const result = await api.get<PathValidateResponse>(`/api/paths/validate?path=${encodeURIComponent(path)}`);
    if (seq !== projectPathValidationSeq) {
      return false;
    }

    if (result.ok) {
      const workspaceRoot = String(result.workspaceRoot ?? "").trim();
      const resolved = String(result.resolvedPath ?? "").trim();
      const nextPath = workspaceRoot || resolved;
      if (nextPath && nextPath !== path) {
        projectDialogPath.value = nextPath;
      }
      lastValidatedProjectSessionId = String(result.projectSessionId ?? "").trim();
      lastValidatedProjectPath.value = projectDialogPath.value.trim();
      projectDialogPathStatus.value = "ok";
      projectDialogPathMessage.value = "目录可用";
      return true;
    }

    lastValidatedProjectPath.value = path;
    projectDialogPathStatus.value = "error";
    projectDialogPathMessage.value = String(result.error ?? "目录不可用");
    return false;
  } catch (error) {
    if (seq !== projectPathValidationSeq) {
      return false;
    }
    lastValidatedProjectPath.value = path;
    projectDialogPathStatus.value = "error";
    projectDialogPathMessage.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function submitProjectDialog(): Promise<void> {
  projectDialogError.value = null;
  const rawPath = projectDialogPath.value.trim();
  if (!rawPath) {
    projectDialogError.value = "请输入项目目录路径";
    return;
  }

  const ok = await validateProjectDialogPath({ force: true });
  if (!ok) {
    if (projectDialogPathStatus.value !== "error") {
      projectDialogPathStatus.value = "error";
      projectDialogPathMessage.value = "目录不可用";
    }
    return;
  }

  const path = projectDialogPath.value.trim();
  if (!path) {
    projectDialogError.value = "请输入项目目录路径";
    return;
  }
  const existing = projects.value.find((p) => p.path === path);
  if (existing) {
    closeProjectDialog();
    requestProjectSwitch(existing.id);
    return;
  }

  const name = projectDialogName.value.trim() || deriveProjectName(path);
  const project = createProjectTab({
    path,
    name,
    initialized: false,
    sessionId: lastValidatedProjectSessionId || undefined,
  });
  projects.value = [...projects.value, project];
  activeProjectId.value = project.id;
  setExpandedExclusive(project.id, true);

  closeProjectDialog();
  void activateProject(project.id);
}

function runtimeOrActive(rt?: ProjectRuntime): ProjectRuntime {
  return rt ?? activeRuntime.value;
}

function runtimeTasksBusy(rt: ProjectRuntime): boolean {
  return rt.tasks.value.some((t) => t.status === "planning" || t.status === "running");
}

function runtimeProjectInProgress(rt: ProjectRuntime): boolean {
  return isProjectInProgress({
    taskStatuses: rt.tasks.value.map((t) => t.status),
    conversationInProgress: rt.busy.value,
  });
}

function runtimeAgentBusy(rt: ProjectRuntime): boolean {
  return rt.busy.value || runtimeTasksBusy(rt);
}

function trimChatItems(items: ChatItem[]): ChatItem[] {
  const existing = Array.isArray(items) ? items : [];
  const liveById = new Map<string, ChatItem>();
  for (const liveId of LIVE_MESSAGE_IDS) {
    const msg = existing.find((m) => m.id === liveId) ?? null;
    if (msg) liveById.set(liveId, msg);
  }

  const nonLive = existing.filter((m) => !isLiveMessageId(m.id));
  const trimmed = nonLive.length <= MAX_CHAT_MESSAGES ? nonLive : nonLive.slice(nonLive.length - MAX_CHAT_MESSAGES);
  const liveBlock = LIVE_MESSAGE_IDS.map((id) => liveById.get(id)).filter(Boolean) as ChatItem[];
  if (liveBlock.length === 0) {
    return trimmed;
  }

  // Keep live activity/step traces anchored to the current turn by inserting them directly
  // before any turn output (execute blocks / assistant stream). This avoids the UX bug where
  // early tool status appears after execute blocks or after the assistant answer.
  let insertAt = trimmed.length;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const m = trimmed[i]!;
    if (m.role === "assistant" && m.streaming) {
      insertAt = i;
      break;
    }
  }
  for (let i = 0; i < insertAt; i++) {
    if (trimmed[i]!.kind === "execute") {
      insertAt = i;
      break;
    }
  }

  return [...trimmed.slice(0, insertAt), ...liveBlock, ...trimmed.slice(insertAt)];
}

function setMessages(items: ChatItem[], rt?: ProjectRuntime): void {
  runtimeOrActive(rt).messages.value = trimChatItems(items);
}

function pushMessageBeforeLive(item: Omit<ChatItem, "id">, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  const liveIndex = findFirstLiveIndex(existing);
  const next = { ...item, id: randomId("msg"), ts: item.ts ?? Date.now() };
  if (liveIndex < 0) {
    setMessages([...existing, next], state);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), next, ...existing.slice(liveIndex)], state);
}

function pushRecentCommand(command: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return;
  const turn = [...state.turnCommands, trimmed];
  state.turnCommands = turn.slice(Math.max(0, turn.length - MAX_TURN_COMMANDS));
  const recent = [...state.recentCommands.value, trimmed];
  state.recentCommands.value = recent.slice(Math.max(0, recent.length - MAX_RECENT_COMMANDS));
}

function resetConversation(rt: ProjectRuntime, notice: string, keepLatestTurn = true): void {
  const existing = rt.messages.value.slice();
  const withoutLive = existing.filter((m) => !isLiveMessageId(m.id));
  const tail = (() => {
    if (!keepLatestTurn) return [];
    for (let i = withoutLive.length - 1; i >= 0; i--) {
      if (withoutLive[i]!.role === "user") return withoutLive.slice(i);
    }
    return [];
  })();

  rt.recentCommands.value = [];
  rt.turnCommands = [];
  rt.executePreviewByKey.clear();
  rt.executeOrder = [];
  rt.seenCommandIds.clear();
  rt.pendingImages.value = [];
  rt.turnInFlight = false;
  clearStepLive(rt);

  const next: ChatItem[] = notice.trim()
    ? [{ id: randomId("sys"), role: "system", kind: "text", content: notice.trim() }, ...tail]
    : [...tail];
  setMessages(next, rt);
}

function threadReset(
  rt: ProjectRuntime,
  params: {
    notice: string;
    warning?: string | null;
    keepLatestTurn?: boolean;
    clearBackendHistory?: boolean;
    resetThreadId?: boolean;
    source?: string;
  },
): void {
  rt.threadWarning.value = params.warning ?? null;
  rt.ignoreNextHistory = true;
  resetConversation(rt, params.notice, params.keepLatestTurn ?? false);
  if (params.resetThreadId) {
    rt.activeThreadId.value = null;
  }
  if (params.clearBackendHistory) {
    rt.suppressNextClearHistoryResult = true;
    rt.ws?.clearHistory();
  }
  recordChatClear("thread_reset", params.source ?? "unknown");
}

function clearConversationForResume(rt: ProjectRuntime): void {
  rt.threadWarning.value = null;
  rt.ignoreNextHistory = false;
  resetConversation(rt, "", false);
  rt.activeThreadId.value = null;
  finalizeCommandBlock(rt);
}

function applyStreamingDisconnectCleanup(rt: ProjectRuntime): void {
  const existing = rt.messages.value.slice();
  const next = finalizeStreamingOnDisconnect(existing, LIVE_STEP_ID);
  if (next.length === existing.length && next.every((m, idx) => m === existing[idx])) return;
  setMessages(next, rt);
}

function applyMergedHistory(serverHistory: ChatItem[], rt: ProjectRuntime): void {
  const next = mergeHistoryFromServer(rt.messages.value, serverHistory, LIVE_STEP_ID);
  setMessages(next, rt);
}

function recordChatClear(reason: "thread_reset", source: string): void {
  // Lightweight observability: ensure clears are always attributable to "thread_reset".
  try {
    console.info("[ads][chat_clear]", { reason, source, ts: Date.now() });
  } catch {
    // ignore
  }
}

function dropEmptyAssistantPlaceholder(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (isLiveMessageId(m.id)) continue;
    if (m.role === "assistant" && m.kind === "text" && m.streaming && !String(m.content ?? "").trim()) {
      setMessages([...existing.slice(0, i), ...existing.slice(i + 1)], state);
      return;
    }
    if (m.role === "assistant" && m.streaming) {
      return;
    }
  }
}

function hasEmptyAssistantPlaceholder(rt?: ProjectRuntime): boolean {
  const state = runtimeOrActive(rt);
  return state.messages.value.some(
    (m) =>
      m.role === "assistant" &&
      m.kind === "text" &&
      m.streaming &&
      !String(m.content ?? "").trim(),
  );
}

function hasAssistantAfterLastUser(rt?: ProjectRuntime): boolean {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.filter((m) => !isLiveMessageId(m.id));
  let lastUserIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    if (existing[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  for (let i = existing.length - 1; i > lastUserIndex; i--) {
    const m = existing[i]!;
    if (m.role === "assistant" && m.kind === "text" && String(m.content ?? "").trim()) {
      return true;
    }
  }
  return false;
}

function shouldIgnoreStepDelta(delta: string): boolean {
  const text = String(delta ?? "");
  return text.includes("初始化 Codex 线程") || text.includes("开始处理请求");
}

function ingestCommand(rawCmd: string, rt?: ProjectRuntime, id?: string | null): void {
  const state = runtimeOrActive(rt);
  const cmd = String(rawCmd ?? "").trim();
  if (!cmd) return;

  if (id) {
    if (state.seenCommandIds.has(id)) return;
    state.seenCommandIds.add(id);
  } else {
    const prev = state.turnCommands[state.turnCommands.length - 1] ?? "";
    if (prev === cmd) return;
  }

  pushRecentCommand(cmd, state);
}

function commandKeyForWsEvent(command: string, id: string | null): string | null {
  const cmd = String(command ?? "").trim();
  if (!cmd) return null;
  const normalizedId = String(id ?? "").trim();
  return normalizedId ? `id:${normalizedId}` : `cmd:${cmd}`;
}

function stripCommandHeader(outputDelta: string, command: string): string {
  const raw = String(outputDelta ?? "");
  if (!raw) return "";

  const normalized = raw.replace(/\r\n/g, "\n");
  const header = `$ ${String(command ?? "").trim()}\n`;
  if (normalized.startsWith(header)) {
    return normalized.slice(header.length);
  }
  if (normalized.startsWith(`\n${header}`)) {
    return normalized.slice(1 + header.length);
  }
  return normalized;
}

function trimRightLine(line: string): string {
  return String(line ?? "").replace(/\s+$/, "");
}

function upsertExecuteBlock(key: string, command: string, outputDelta: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  dropEmptyAssistantPlaceholder(state);
  const existing = state.messages.value.slice();

  const normalizedKey = String(key ?? "").trim();
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedKey || !normalizedCommand) return;

  const current =
    state.executePreviewByKey.get(normalizedKey) ??
    (() => {
      const created = { key: normalizedKey, command: normalizedCommand, previewLines: [] as string[], totalLines: 0, remainder: "" };
      state.executePreviewByKey.set(normalizedKey, created);
      state.executeOrder = [...state.executeOrder, normalizedKey];
      return created;
    })();

  const cleanedDelta = stripCommandHeader(outputDelta, normalizedCommand).replace(/^\n+/, "");
  if (cleanedDelta) {
    const combined = (current.remainder + cleanedDelta).replace(/\r\n/g, "\n");
    const parts = combined.split("\n");
    current.remainder = parts.pop() ?? "";
    for (const rawLine of parts) {
      const line = trimRightLine(rawLine);
      if (!line) continue;
      current.totalLines += 1;
      if (current.previewLines.length < MAX_EXECUTE_PREVIEW_LINES) {
        current.previewLines.push(line);
      }
    }
  }

  const preview = current.previewLines.slice();
  if (preview.length < MAX_EXECUTE_PREVIEW_LINES) {
    const partial = trimRightLine(current.remainder);
    if (partial) preview.push(partial);
  }

  const hiddenLineCount = Math.max(0, current.totalLines - current.previewLines.length);
  const itemId = `exec:${normalizedKey}`;
  const nextItem: ChatItem = {
    id: itemId,
    role: "system",
    kind: "execute",
    content: preview.join("\n"),
    command: normalizedCommand,
    hiddenLineCount,
    streaming: true,
  };

  const existingIdx = existing.findIndex((m) => m.id === itemId);
  if (existingIdx >= 0) {
    existing[existingIdx] = nextItem;
    setMessages(existing.slice(), state);
    return;
  }

  const lastLiveIndex = findLastLiveIndex(existing);
  let insertAt = lastLiveIndex < 0 ? existing.length : lastLiveIndex + 1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (isLiveMessageId(m.id)) continue;
    if (m.role === "assistant" && m.streaming) {
      insertAt = Math.min(insertAt, i);
      break;
    }
  }
  if (lastLiveIndex >= 0) {
    insertAt = Math.max(insertAt, lastLiveIndex + 1);
  }

  let lastExecuteIdx = -1;
  for (let i = 0; i < insertAt; i++) {
    if (existing[i]!.kind === "execute") {
      lastExecuteIdx = i;
    }
  }
  if (lastExecuteIdx >= 0) insertAt = lastExecuteIdx + 1;

  setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);

  if (state.executeOrder.length > MAX_TURN_COMMANDS) {
    const overflow = state.executeOrder.length - MAX_TURN_COMMANDS;
    const toDrop = state.executeOrder.slice(0, overflow);
    state.executeOrder = state.executeOrder.slice(overflow);
    for (const k of toDrop) {
      state.executePreviewByKey.delete(k);
    }
    const pruned = state.messages.value.filter((m) => !(m.kind === "execute" && toDrop.includes(String(m.id).slice("exec:".length))));
    setMessages(pruned, state);
  }
}

function finalizeCommandBlock(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  let insertAt = -1;
  const withoutExecute: ChatItem[] = [];
  for (let i = 0; i < existing.length; i++) {
    const m = existing[i]!;
    if (m.kind === "execute") {
      if (insertAt < 0) insertAt = withoutExecute.length;
      continue;
    }
    withoutExecute.push(m);
  }

  const commands = state.turnCommands.slice();
  const content = commands.map((c) => `$ ${c}`).join("\n").trim();

  state.recentCommands.value = [];
  state.turnCommands = [];
  state.executePreviewByKey.clear();
  state.executeOrder = [];
  state.seenCommandIds.clear();

  if (!content) {
    if (withoutExecute.length !== existing.length) setMessages(withoutExecute, state);
    return;
  }

  if (insertAt < 0) {
    const liveIndex = findFirstLiveIndex(withoutExecute);
    insertAt = liveIndex < 0 ? withoutExecute.length : liveIndex;
    for (let i = withoutExecute.length - 1; i >= 0; i--) {
      const m = withoutExecute[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        insertAt = Math.min(insertAt, i);
        break;
      }
    }
  }

  const item: ChatItem = { id: randomId("cmd"), role: "system", kind: "command", content, streaming: false };
  setMessages([...withoutExecute.slice(0, insertAt), item, ...withoutExecute.slice(insertAt)], state);
}

function removeQueuedPrompt(id: string): void {
  const target = String(id ?? "").trim();
  if (!target) return;
  queuedPrompts.value = queuedPrompts.value.filter((q) => q.id !== target);
}

function enqueueMainPrompt(text: string, images: IncomingImage[]): void {
  const content = String(text ?? "").trim();
  const imgs = Array.isArray(images) ? images : [];
  if (!content && imgs.length === 0) return;
  queuedPrompts.value = [
    ...queuedPrompts.value,
    { id: randomId("q"), clientMessageId: randomUuid(), text: content, images: imgs, createdAt: Date.now() },
  ];
  flushQueuedPrompts();
}

function flushQueuedPrompts(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  if (runtimeAgentBusy(state)) return;
  if (!state.connected.value) return;
  if (!state.ws) return;
  if (state.queuedPrompts.value.length === 0) return;

  const next = state.queuedPrompts.value[0]!;
  state.queuedPrompts.value = state.queuedPrompts.value.slice(1);

  try {
    const display =
      next.text && next.images.length > 0
        ? `${next.text}\n\n[图片 x${next.images.length}]`
        : next.text
          ? next.text
          : `[图片 x${next.images.length}]`;

    finalizeCommandBlock(state);
    clearStepLive(state);

    pushMessageBeforeLive({ role: "user", kind: "text", content: display }, state);
    pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
    state.busy.value = true;
    state.turnInFlight = true;
    state.pendingAckClientMessageId = next.clientMessageId;
    savePendingPrompt(state, next);
    state.ws.sendPrompt(next.images.length > 0 ? { text: next.text, images: next.images } : next.text, next.clientMessageId);
  } catch {
    state.queuedPrompts.value = [next, ...state.queuedPrompts.value];
  }
}

function upsertStreamingDelta(delta: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const chunk = String(delta ?? "");
  if (!chunk) return;
  dropEmptyAssistantPlaceholder(state);
  const existing = state.messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (isLiveMessageId(m.id)) continue;
    if (m.role === "assistant" && m.streaming) {
      streamIndex = i;
      break;
    }
  }
  if (streamIndex >= 0) {
    existing[streamIndex]!.content += chunk;
    setMessages(existing.slice(), state);
    return;
  }

  const nextItem: ChatItem = {
    id: randomId("stream"),
    role: "assistant",
    kind: "text",
    content: chunk,
    streaming: true,
    ts: Date.now(),
  };
  const lastLiveIndex = findLastLiveIndex(existing);
  if (lastLiveIndex < 0) {
    setMessages([...existing, nextItem], state);
    return;
  }
  // Keep live activity/step traces above the assistant stream when the placeholder was dropped.
  const insertAt = Math.min(existing.length, lastLiveIndex + 1);
  setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);
}

function trimToLastLines(text: string, maxLines: number, maxChars = 2500): string {
  const normalized = String(text ?? "");
  const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
  const lines = recent.split("\n");
  if (lines.length <= maxLines) return recent;
  return lines.slice(lines.length - maxLines).join("\n");
}

function upsertStepLiveDelta(delta: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  dropEmptyAssistantPlaceholder(state);
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = state.messages.value.slice();
  const idx = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const current = idx >= 0 ? existing[idx]!.content : "";
  const nextText = trimToLastLines(current + chunk, 14);
  const nextItem: ChatItem = {
    id: LIVE_STEP_ID,
    role: "assistant",
    kind: "text",
    content: nextText,
    streaming: true,
    ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
  };
  const withoutStep = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

  let insertAt = withoutStep.length;
  for (let i = withoutStep.length - 1; i >= 0; i--) {
    const m = withoutStep[i]!;
    if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
      insertAt = i;
      break;
    }
  }

  const next = [...withoutStep.slice(0, insertAt), nextItem, ...withoutStep.slice(insertAt)];
  setMessages(next, state);
}

function upsertLiveActivity(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  dropEmptyAssistantPlaceholder(state);
  const markdown = renderLiveActivityMarkdown(state.liveActivity);

  const existing = state.messages.value.slice();

  if (!markdown) {
    const next = existing.filter((m) => m.id !== LIVE_ACTIVITY_ID);
    if (next.length === existing.length) return;
    setMessages(next, state);
    return;
  }

  const idx = existing.findIndex((m) => m.id === LIVE_ACTIVITY_ID);
  const nextItem: ChatItem = {
    id: LIVE_ACTIVITY_ID,
    role: "assistant",
    kind: "text",
    content: markdown,
    streaming: true,
    ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
  };
  const withoutActivity = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

  const stepIdx = withoutActivity.findIndex((m) => m.id === LIVE_STEP_ID);
  let insertAt = stepIdx >= 0 ? stepIdx : withoutActivity.length;
  if (stepIdx < 0) {
    for (let i = withoutActivity.length - 1; i >= 0; i--) {
      const m = withoutActivity[i]!;
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        insertAt = i;
        break;
      }
    }
  }

  const next = [...withoutActivity.slice(0, insertAt), nextItem, ...withoutActivity.slice(insertAt)];
  setMessages(next, state);
}

function clearStepLive(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  clearLiveActivityWindow(state.liveActivity);
  const existing = state.messages.value.slice();
  const next = existing.filter((m) => !isLiveMessageId(m.id));
  if (next.length === existing.length) return;
  setMessages(next, state);
}

function finalizeAssistant(content: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const trimmedText = text.trim();
  const existing = state.messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (isLiveMessageId(m.id)) continue;
    if (m.role === "assistant" && m.streaming) {
      streamIndex = i;
      break;
    }
  }
  if (streamIndex >= 0) {
    const current = String(existing[streamIndex]!.content ?? "");
    if (!trimmedText) {
      if (!current.trim()) {
        setMessages([...existing.slice(0, streamIndex), ...existing.slice(streamIndex + 1)], state);
        return;
      }
      existing[streamIndex]!.streaming = false;
      setMessages(existing.slice(), state);
      return;
    }
    existing[streamIndex]!.content = text;
    existing[streamIndex]!.streaming = false;
    setMessages(existing.slice(), state);
    return;
  }

  if (!trimmedText) return;
  const normalizedText = trimmedText;
  const lastNonLive = (() => {
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      return m;
    }
    return null;
  })();
  if (lastNonLive?.role === "assistant" && lastNonLive.kind === "text") {
    const prev = String(lastNonLive.content ?? "").replace(/\r\n/g, "\n").trim();
    if (prev === normalizedText) {
      return;
    }
  }

  pushMessageBeforeLive({ role: "assistant", kind: "text", content: text }, state);
}

function pruneTaskChatBuffer(rt: ProjectRuntime): void {
  const now = Date.now();
  for (const [taskId, entry] of rt.taskChatBufferByTaskId.entries()) {
    if (!taskId) {
      rt.taskChatBufferByTaskId.delete(taskId);
      continue;
    }
    if (entry.events.length === 0 || now - entry.firstTs > TASK_CHAT_BUFFER_TTL_MS) {
      rt.taskChatBufferByTaskId.delete(taskId);
    }
  }
}

function bufferTaskChatEvent(taskId: string, event: BufferedTaskChatEvent, rt: ProjectRuntime): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  pruneTaskChatBuffer(rt);
  const existing = rt.taskChatBufferByTaskId.get(id);
  if (!existing) {
    rt.taskChatBufferByTaskId.set(id, { firstTs: Date.now(), events: [event] });
    return;
  }
  const nextEvents = [...existing.events, event].slice(-TASK_CHAT_BUFFER_MAX_EVENTS);
  rt.taskChatBufferByTaskId.set(id, { firstTs: existing.firstTs, events: nextEvents });
}

function markTaskChatStarted(taskId: string, rt: ProjectRuntime): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  if (!rt.startedTaskIds.has(id)) {
    rt.startedTaskIds.add(id);
  }
  const buffered = rt.taskChatBufferByTaskId.get(id);
  if (!buffered || buffered.events.length === 0) return;
  rt.taskChatBufferByTaskId.delete(id);

  for (const ev of buffered.events) {
    if (ev.kind === "message") {
      if (ev.role === "assistant") {
        finalizeAssistant(ev.content, rt);
      } else {
        pushMessageBeforeLive({ role: ev.role, kind: "text", content: ev.content }, rt);
      }
      continue;
    }
    if (ev.kind === "delta") {
      if (ev.source === "step") {
        upsertStepLiveDelta(ev.delta, rt);
      } else {
        upsertStreamingDelta(ev.delta, rt);
      }
      continue;
    }
    if (ev.kind === "command") {
      ingestCommand(ev.command, rt, null);
      continue;
    }
  }
}

function resolveWorkspaceRoot(project: ProjectTab | null, rt: ProjectRuntime): string | null {
  const projectPath = String(project?.path ?? "").trim();
  if (projectPath) return projectPath;
  const fallback = String(rt.workspacePath.value ?? "").trim();
  return fallback || null;
}

function resolveActiveWorkspaceRoot(): string | null {
  return resolveWorkspaceRoot(activeProject.value, activeRuntime.value);
}

function withWorkspaceQueryFor(projectId: string, apiPath: string): string {
  const pid = normalizeProjectId(projectId);
  const project = projects.value.find((p) => p.id === pid) ?? null;
  const rt = getRuntime(pid);
  const root = resolveWorkspaceRoot(project, rt);
  if (!root) return apiPath;
  const joiner = apiPath.includes("?") ? "&" : "?";
  return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
}

function withWorkspaceQuery(apiPath: string): string {
  return withWorkspaceQueryFor(activeProjectId.value, apiPath);
}

function resetTaskState(): void {
  tasks.value = [];
  selectedId.value = null;
  expanded.value = new Set();
  plansByTaskId.value = new Map();
}

async function ensurePlan(taskId: string): Promise<void> {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  const pid = normalizeProjectId(activeProjectId.value);
  const rt = getRuntime(pid);
  if ((rt.plansByTaskId.value.get(id)?.length ?? 0) > 0) return;
  const inFlight = rt.planFetchInFlightByTaskId.get(id);
  if (inFlight) {
    await inFlight;
    return;
  }

  const op = (async () => {
    try {
      const plan = await api.get<PlanStep[]>(withWorkspaceQuery(`/api/tasks/${id}/plan`));
      rt.plansByTaskId.value.set(id, Array.isArray(plan) ? plan : []);
      rt.plansByTaskId.value = new Map(rt.plansByTaskId.value);
    } catch {
      // ignore
    }
  })().finally(() => {
    rt.planFetchInFlightByTaskId.delete(id);
  });

  rt.planFetchInFlightByTaskId.set(id, op);
  try {
    await op;
  } catch {}
}

function togglePlan(taskId: string): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function clearReconnectTimer(rt: ProjectRuntime): void {
  if (rt.reconnectTimer === null) return;
  try {
    clearTimeout(rt.reconnectTimer);
  } catch {
    // ignore
  }
  rt.reconnectTimer = null;
}

function scheduleReconnect(projectId: string, rt: ProjectRuntime, reason: string): void {
  void reason;
  if (!loggedIn.value) return;
  if (rt.reconnectTimer !== null) return;

  const attempt = Math.min(6, rt.reconnectAttempts);
  const delayMs = Math.min(15_000, 800 * Math.pow(2, attempt));
  rt.reconnectAttempts += 1;
  rt.reconnectTimer = window.setTimeout(() => {
    rt.reconnectTimer = null;
    void connectWs(projectId).catch(() => {
      scheduleReconnect(projectId, rt, "connect failed");
    });
  }, delayMs);
}

function closeRuntimeConnection(rt: ProjectRuntime): void {
  clearReconnectTimer(rt);
  const prev = rt.ws;
  rt.ws = null;
  try {
    prev?.close();
  } catch {
    // ignore
  }
  rt.connected.value = false;
}

function closeAllConnections(): void {
  for (const rt of runtimeByProjectId.values()) {
    closeRuntimeConnection(rt);
  }
}

const apiAuthorized = computed(() => loggedIn.value);

let appMounted = false;

function handleLoggedIn(me: AuthMe): void {
  loggedIn.value = true;
  currentUser.value = me;
  closeAllConnections();
  if (appMounted) {
    void bootstrap();
  }
}

function setNotice(message: string, projectId: string = activeProjectId.value): void {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  rt.apiNotice.value = message;
  if (rt.noticeTimer !== null) {
    try {
      clearTimeout(rt.noticeTimer);
    } catch {
      // ignore
    }
    rt.noticeTimer = null;
  }
  rt.noticeTimer = window.setTimeout(() => {
    rt.noticeTimer = null;
    rt.apiNotice.value = null;
  }, 3000);
}

function clearNotice(projectId: string = activeProjectId.value): void {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  rt.apiNotice.value = null;
  if (rt.noticeTimer !== null) {
    try {
      clearTimeout(rt.noticeTimer);
    } catch {
      // ignore
    }
    rt.noticeTimer = null;
  }
}

async function loadModels(): Promise<void> {
  models.value = await api.get<ModelConfig[]>("/api/models");
}

async function loadQueueStatus(projectId: string = activeProjectId.value): Promise<void> {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  rt.queueStatus.value = await api.get<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/status"));
}

async function runTaskQueue(projectId: string = activeProjectId.value): Promise<void> {
  apiError.value = null;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  try {
    rt.queueStatus.value = await api.post<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/run"), {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function pauseTaskQueue(projectId: string = activeProjectId.value): Promise<void> {
  apiError.value = null;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  try {
    rt.queueStatus.value = await api.post<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/pause"), {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function reorderPendingTasks(ids: string[], projectId: string = activeProjectId.value): Promise<void> {
  apiError.value = null;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  const normalized = (ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  // Optimistic UI reorder: update queueOrder locally so the list reflects the new order immediately.
  // Roll back on API failure.
  const pending = rt.tasks.value.filter((t) => t.status === "pending");
  const priorQueueOrderById = new Map<string, number>();
  for (const t of pending) {
    priorQueueOrderById.set(t.id, (t as unknown as { queueOrder?: number }).queueOrder ?? 0);
  }
  const orderIndex = new Map<string, number>();
  for (let i = 0; i < normalized.length; i++) {
    orderIndex.set(normalized[i]!, i);
  }
  const base = (() => {
    let min = Number.POSITIVE_INFINITY;
    for (const t of pending) {
      const q = (t as unknown as { queueOrder?: number }).queueOrder;
      if (typeof q === "number" && Number.isFinite(q)) min = Math.min(min, q);
    }
    return Number.isFinite(min) ? Math.floor(min) : Date.now();
  })();

  rt.tasks.value = rt.tasks.value.map((t) => {
    if (t.status !== "pending") return t;
    const idx = orderIndex.get(t.id);
    if (idx == null) return t;
    return { ...(t as object), queueOrder: base + idx } as Task;
  });

  try {
    const res = await api.post<{ success: boolean; tasks: Task[] }>(
      withWorkspaceQueryFor(pid, "/api/tasks/reorder"),
      { ids: normalized },
    );
    for (const task of res?.tasks ?? []) {
      upsertTask(task, rt);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;

    // Best-effort rollback to the previous order.
    rt.tasks.value = rt.tasks.value.map((t) => {
      if (t.status !== "pending") return t;
      const prior = priorQueueOrderById.get(t.id);
      if (prior == null) return t;
      return { ...(t as object), queueOrder: prior } as Task;
    });
  }
}

async function loadTasks(projectId: string = activeProjectId.value): Promise<void> {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  rt.tasks.value = await api.get<Task[]>(withWorkspaceQueryFor(pid, "/api/tasks?limit=100"));
  if (!rt.selectedId.value && rt.tasks.value.length > 0) {
    const nextPending = rt.tasks.value
      .filter((t) => t.status === "pending")
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
        return a.createdAt - b.createdAt;
      })[0];
    rt.selectedId.value = (nextPending ?? rt.tasks.value[0])!.id;
  }
}

function upsertTask(t: Task, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const idx = state.tasks.value.findIndex((x) => x.id === t.id);
  const normalizedAttachments = Array.isArray((t as { attachments?: unknown }).attachments)
    ? ((t as { attachments?: Task["attachments"] }).attachments ?? undefined)
    : undefined;
  if (idx >= 0) {
    const existing = state.tasks.value[idx]!;
    state.tasks.value[idx] = {
      ...existing,
      ...t,
      attachments: normalizedAttachments ?? existing.attachments,
    };
  } else {
    state.tasks.value.unshift(t);
  }
}

function onTaskEvent(payload: { event: TaskEventPayload["event"]; data: unknown }, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  pruneTaskChatBuffer(state);
  if (payload.event === "task:updated") {
    const t = payload.data as Task;
    upsertTask(t, state);
    return;
  }
  if (payload.event === "command") {
    const data = payload.data as { taskId: string; command: string };
    markTaskChatStarted(data.taskId, state);
    ingestCommand(data.command, state, null);
    upsertExecuteBlock(`task:${String(data.taskId ?? "").trim()}:${randomId("cmd")}`, data.command, "", state);
    return;
  }
  if (payload.event === "message:delta") {
    const data = payload.data as { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" };
    if (data.role === "assistant") {
      markTaskChatStarted(data.taskId, state);
      if (data.source === "step") {
        upsertStepLiveDelta(data.delta, state);
      } else {
        upsertStreamingDelta(data.delta, state);
      }
    }
    return;
  }
  if (payload.event === "task:started") {
    const t = payload.data as Task;
    upsertTask(t, state);
    finalizeCommandBlock(state);
    markTaskChatStarted(t.id, state);
    return;
  }
  if (payload.event === "task:planned") {
    const data = payload.data as { task: Task; plan?: Array<{ stepNumber: number; title: string; description?: string | null }> };
    upsertTask(data.task, state);
    markTaskChatStarted(data.task.id, state);
    if (Array.isArray(data.plan) && data.plan.length > 0) {
      const steps: PlanStep[] = data.plan.map((step) => ({
        id: step.stepNumber,
        taskId: data.task.id,
        stepNumber: step.stepNumber,
        title: step.title,
        description: step.description ?? null,
        status: "pending",
        startedAt: null,
        completedAt: null,
      }));
      state.plansByTaskId.value.set(data.task.id, steps);
      state.plansByTaskId.value = new Map(state.plansByTaskId.value);
    }
    return;
  }
  if (payload.event === "task:running") {
    const t = payload.data as Task;
    upsertTask(t, state);
    markTaskChatStarted(t.id, state);
    return;
  }
  if (payload.event === "step:started") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    markTaskChatStarted(data.taskId, state);
    const plan = state.plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "running";
      }
      state.plansByTaskId.value = new Map(state.plansByTaskId.value);
    }
    clearStepLive(state);
    return;
  }
  if (payload.event === "step:completed") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    markTaskChatStarted(data.taskId, state);
    const plan = state.plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "completed";
      }
      state.plansByTaskId.value = new Map(state.plansByTaskId.value);
    }
    clearStepLive(state);
    return;
  }
  if (payload.event === "message") {
    const data = payload.data as { taskId: string; role: string; content: string };
    const taskId = String(data.taskId ?? "").trim();
    const role = String(data.role ?? "").trim();
    const content = String(data.content ?? "");

    if (role === "user" && !state.startedTaskIds.has(taskId)) {
      bufferTaskChatEvent(taskId, { kind: "message", role: "user", content }, state);
      return;
    }
    if (role !== "user") {
      markTaskChatStarted(taskId, state);
    }
    if (role === "assistant") {
      finalizeAssistant(content, state);
      return;
    }
    if (role === "user") {
      const normalized = content.trim();
      if (
        state.messages.value.some(
          (m) => m.role === "user" && m.kind === "text" && String(m.content ?? "").trim() === normalized,
        )
      ) {
        return;
      }
      pushMessageBeforeLive({ role: "user", kind: "text", content }, state);
      const task = state.tasks.value.find((t) => t.id === taskId) ?? null;
      const status = String(task?.status ?? "");
      if (status === "pending" || status === "planning" || status === "running") {
        if (!hasEmptyAssistantPlaceholder(state)) {
          pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
        }
      }
      return;
    }
    if (role === "system") {
      pushMessageBeforeLive({ role: "system", kind: "text", content }, state);
      return;
    }
    return;
  }
  if (payload.event === "task:completed") {
    const t = payload.data as Task;
    markTaskChatStarted(t.id, state);
    upsertTask(t, state);
    clearStepLive(state);
    finalizeCommandBlock(state);
    if (t.result && t.result.trim() && !hasAssistantAfterLastUser(state)) {
      finalizeAssistant(t.result, state);
    }
    flushQueuedPrompts(state);
    void loadQueueStatus();
    return;
  }
  if (payload.event === "task:failed") {
    const data = payload.data as { task: Task; error: string };
    markTaskChatStarted(data.task.id, state);
    upsertTask(data.task, state);
    clearStepLive(state);
    finalizeCommandBlock(state);
    pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` }, state);
    flushQueuedPrompts(state);
    void loadQueueStatus();
    return;
  }
  if (payload.event === "task:cancelled") {
    const t = payload.data as Task;
    markTaskChatStarted(t.id, state);
    upsertTask(t, state);
    clearStepLive(state);
    finalizeCommandBlock(state);
    pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" }, state);
    flushQueuedPrompts(state);
    void loadQueueStatus();
    return;
  }
}

function mergeProjectsInto(target: ProjectTab, candidate: ProjectTab): ProjectTab {
  const name = target.name || candidate.name;
  const initialized = target.initialized || candidate.initialized;
  const createdAt = Math.min(target.createdAt, candidate.createdAt);
  const updatedAt = Date.now();
  return { ...target, ...candidate, name, initialized, createdAt, updatedAt };
}

function replaceProjectId(oldId: string, next: ProjectTab): void {
  const current = projects.value.slice();
  const existingIdx = current.findIndex((p) => p.id === next.id);
  const oldIdx = current.findIndex((p) => p.id === oldId);
  if (oldIdx < 0) {
    return;
  }

  if (existingIdx >= 0 && existingIdx !== oldIdx) {
    const merged = mergeProjectsInto(current[existingIdx]!, next);
    current[existingIdx] = merged;
    current.splice(oldIdx, 1);
  } else {
    current[oldIdx] = next;
  }

  projects.value = current;
  if (activeProjectId.value === oldId) {
    activeProjectId.value = next.id;
  }
  if (pendingSwitchProjectId.value === oldId) {
    pendingSwitchProjectId.value = next.id;
  }
  const oldKey = normalizeProjectId(oldId);
  const nextKey = normalizeProjectId(next.id);
  if (oldKey !== nextKey) {
    const rt = runtimeByProjectId.get(oldKey);
    if (rt) {
      if (!runtimeByProjectId.has(nextKey)) {
        runtimeByProjectId.set(nextKey, rt);
      }
      runtimeByProjectId.delete(oldKey);
    }
  }
  persistProjects();
}

async function resolveProjectIdentity(project: ProjectTab): Promise<{ sessionId: string; path: string } | null> {
  const rawPath = String(project.path ?? "").trim();
  if (!rawPath) {
    return null;
  }
  try {
    const result = await api.get<PathValidateResponse>(`/api/paths/validate?path=${encodeURIComponent(rawPath)}`);
    if (!result.ok) {
      return null;
    }
    const sessionId = String(result.projectSessionId ?? "").trim();
    if (!sessionId) {
      return null;
    }
    const workspaceRoot = String(result.workspaceRoot ?? "").trim();
    const resolvedPath = String(result.resolvedPath ?? "").trim();
    const normalizedPath = workspaceRoot || resolvedPath || rawPath;
    return { sessionId, path: normalizedPath };
  } catch {
    return null;
  }
}

async function connectWs(projectId: string = activeProjectId.value): Promise<void> {
  if (!loggedIn.value) return;
  let pid = normalizeProjectId(projectId);
  let project = projects.value.find((p) => p.id === pid) ?? null;
  if (!project) return;

  let rt = getRuntime(pid);
  rt.projectSessionId = String(project.sessionId ?? "").trim();

  const identity = await resolveProjectIdentity(project);
  if (identity && (identity.sessionId !== project.sessionId || identity.path !== project.path)) {
    const nextProject: ProjectTab = {
      ...project,
      id: identity.sessionId,
      sessionId: identity.sessionId,
      path: identity.path,
      updatedAt: Date.now(),
    };
    replaceProjectId(project.id, nextProject);
    pid = nextProject.id;
    project = nextProject;
    rt = getRuntime(pid);
    rt.projectSessionId = String(project.sessionId ?? "").trim();
  }

  clearReconnectTimer(rt);

  const prev = rt.ws;
  rt.ws = null;
  try {
    prev?.close();
  } catch {
    // ignore
  }

  const wsInstance = new AdsWebSocket({ sessionId: project.sessionId });
  rt.ws = wsInstance;
  let disconnectCleanupDone = false;
  let disconnectWasBusy = false;

  const cleanupDisconnectState = () => {
    if (disconnectCleanupDone) return;
    disconnectCleanupDone = true;
    disconnectWasBusy = rt.busy.value;
    rt.connected.value = false;
    rt.busy.value = false;
    clearStepLive(rt);
    finalizeCommandBlock(rt);
    applyStreamingDisconnectCleanup(rt);
    if (disconnectWasBusy) {
      pushMessageBeforeLive(
        {
          role: "system",
          kind: "text",
          content: "Connection lost while a request was running. Reconnecting and syncing history…",
        },
        rt,
      );
    }
  };

  wsInstance.onOpen = () => {
    if (rt.ws !== wsInstance) return;
    rt.connected.value = true;
    rt.wsError.value = null;
    rt.reconnectAttempts = 0;
    clearReconnectTimer(rt);
    restorePendingPrompt(rt);
    flushQueuedPrompts(rt);
  };

  wsInstance.onClose = (ev) => {
    if (rt.ws !== wsInstance) return;
    cleanupDisconnectState();

    if (ev.code === 4401) {
      rt.wsError.value = "Unauthorized";
      clearReconnectTimer(rt);
      return;
    }
    if (ev.code === 4409) {
      rt.wsError.value = "Max clients reached (increase ADS_WEB_MAX_CLIENTS)";
      clearReconnectTimer(rt);
      return;
    }

    const reason = String((ev as CloseEvent).reason ?? "").trim();
    rt.wsError.value = `WebSocket closed (${ev.code || "unknown"})${reason ? `: ${reason}` : ""}`;
    scheduleReconnect(pid, rt, "close");
  };

  wsInstance.onError = () => {
    if (rt.ws !== wsInstance) return;
    cleanupDisconnectState();
    rt.wsError.value = "WebSocket error";
    scheduleReconnect(pid, rt, "error");
  };

  wsInstance.onTaskEvent = (payload) => {
    if (rt.ws !== wsInstance) return;
    onTaskEvent(payload, rt);
  };

  wsInstance.onMessage = (msg) => {
    if (rt.ws !== wsInstance) return;

    if (msg.type === "ack") {
      const id = String((msg as { client_message_id?: unknown }).client_message_id ?? "").trim();
      if (id && rt.pendingAckClientMessageId === id) {
        rt.pendingAckClientMessageId = null;
        clearPendingPrompt(rt);
      }
      return;
    }

    if (msg.type === "welcome") {
      let nextPath = "";
      let wsState: WorkspaceState | null = null;
      const maybeWorkspace = (msg as { workspace?: unknown }).workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        wsState = maybeWorkspace as WorkspaceState;
        nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;
      }

      const serverThreadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
      const handshakeReset = Boolean((msg as { reset?: unknown }).reset);
      const prevThreadId = String(rt.activeThreadId.value ?? "").trim();
      if (handshakeReset) {
        threadReset(rt, {
          notice: "Context thread was reset. Chat history was cleared to avoid misleading context.",
          warning: "Context thread was reset by backend handshake. Chat history was cleared automatically.",
          keepLatestTurn: false,
          clearBackendHistory: false,
          resetThreadId: true,
          source: "welcome_reset",
        });
      } else if (prevThreadId && serverThreadId && prevThreadId !== serverThreadId) {
        rt.threadWarning.value =
          `Backend thread changed without an explicit reset marker (prev=${prevThreadId}, now=${serverThreadId}). ` +
          "UI was preserved, but model context may not match chat history.";
      }
      if (serverThreadId) rt.activeThreadId.value = serverThreadId;

      const current = projects.value.find((p) => p.id === pid) ?? null;
      if (current && !current.initialized && current.path.trim()) {
        rt.pendingCdRequestedPath = current.path.trim();
        wsInstance.send("command", { command: `/cd ${current.path.trim()}`, silent: true });
        return;
      }
      if (current) {
        const updates: Partial<ProjectTab> = { initialized: true };
        if (nextPath) updates.path = nextPath;
        if (wsState && Object.prototype.hasOwnProperty.call(wsState, "branch")) {
          updates.branch = String(wsState.branch ?? "");
        }
        updateProject(current.id, updates);
      }
      return;
    }

    if (msg.type === "workspace") {
      const data = (msg as { data?: unknown }).data;
      if (data && typeof data === "object") {
        const wsState = data as WorkspaceState;
        const nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;

        if (rt.pendingCdRequestedPath) {
          const current = projects.value.find((p) => p.id === pid) ?? null;
          if (current) {
            updateProject(current.id, { path: nextPath || rt.pendingCdRequestedPath, initialized: true });
          }
          rt.pendingCdRequestedPath = null;
          return;
        }
        const current = projects.value.find((p) => p.id === pid) ?? null;
        if (current) {
          const updates: Partial<ProjectTab> = { initialized: true };
          if (nextPath) updates.path = nextPath;
          if (Object.prototype.hasOwnProperty.call(wsState, "branch")) {
            updates.branch = String(wsState.branch ?? "");
          }
          updateProject(current.id, updates);
        }
      }
      return;
    }

    if (msg.type === "thread_reset") {
      threadReset(rt, {
        notice: "Context thread was reset. Chat history was cleared to avoid misleading context.",
        warning: "Context thread was reset by backend signal. Chat history was cleared automatically.",
        keepLatestTurn: false,
        clearBackendHistory: false,
        resetThreadId: true,
        source: "thread_reset_signal",
      });
      return;
    }

    if (msg.type === "history") {
      if (rt.busy.value || rt.queuedPrompts.value.length > 0) return;
      if (rt.ignoreNextHistory) {
        rt.ignoreNextHistory = false;
        return;
      }
      const items = Array.isArray(msg.items) ? msg.items : [];
      rt.recentCommands.value = [];
      rt.seenCommandIds.clear();
      const next: ChatItem[] = [];
      let cmdGroup: string[] = [];
      let cmdGroupTs: number | null = null;
      const flushCommands = () => {
        if (cmdGroup.length === 0) return;
        next.push({
          id: randomId("h-cmd"),
          role: "system",
          kind: "command",
          content: cmdGroup.join("\n"),
          ts: cmdGroupTs ?? undefined,
        });
        cmdGroup = [];
        cmdGroupTs = null;
      };
      for (let idx = 0; idx < items.length; idx++) {
        const entry = items[idx] as { role?: unknown; text?: unknown; kind?: unknown; ts?: unknown };
        const role = String(entry.role ?? "");
        const text = String(entry.text ?? "");
        const kind = String(entry.kind ?? "");
        const rawTs = entry.ts;
        const ts =
          typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 0
            ? Math.floor(rawTs)
            : null;
        const trimmed = text.trim();
        if (!trimmed) continue;
        const isCommand = kind === "command" || (role === "status" && trimmed.startsWith("$ "));
        if (isCommand) {
          cmdGroup = [...cmdGroup, trimmed].slice(-MAX_TURN_COMMANDS);
          if (ts) cmdGroupTs = ts;
          continue;
        }
        flushCommands();
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed, ts: ts ?? undefined });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed, ts: ts ?? undefined });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed, ts: ts ?? undefined });
      }
      flushCommands();
      applyMergedHistory(next, rt);
      return;
    }
    if (msg.type === "delta") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const source = String((msg as { source?: unknown }).source ?? "").trim();
      if (source === "step") {
        const delta = String(msg.delta ?? "");
        if (shouldIgnoreStepDelta(delta)) return;
        upsertStepLiveDelta(delta, rt);
      } else {
        upsertStreamingDelta(String(msg.delta ?? ""), rt);
      }
      return;
    }
    if (msg.type === "explored") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const entry = (msg as { entry?: unknown }).entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (category === "Execute") {
          return;
        }
        if (summary) {
          ingestExploredActivity(rt.liveActivity, category, summary);
          upsertLiveActivity(rt);
        }
      }
      return;
    }
    if (msg.type === "patch") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const patch = (msg as { patch?: unknown }).patch;
      if (!patch || typeof patch !== "object") return;

      const typed = patch as { files?: unknown; diff?: unknown; truncated?: unknown };
      const diff = String(typed.diff ?? "").trimEnd();
      if (!diff.trim()) return;

      const files = Array.isArray(typed.files) ? (typed.files as Array<{ path?: unknown; added?: unknown; removed?: unknown }>) : [];
      const fileLines = files
        .map((f) => {
          const filePath = String(f.path ?? "").trim();
          if (!filePath) return "";
          const added = typeof f.added === "number" && Number.isFinite(f.added) ? Math.max(0, Math.floor(f.added)) : null;
          const removed = typeof f.removed === "number" && Number.isFinite(f.removed) ? Math.max(0, Math.floor(f.removed)) : null;
          const stat = added === null || removed === null ? "(binary)" : `(+${added} -${removed})`;
          return `- \`${filePath}\` ${stat}`;
        })
        .filter(Boolean);

      const truncated = Boolean(typed.truncated);
      const header = fileLines.length ? `Modified files:\n${fileLines.join("\n")}\n\n` : "";
      const note = truncated ? "\n\n_Diff was truncated to avoid flooding the UI._\n" : "";
      const content = `${header}\`\`\`diff\n${diff}\n\`\`\`${note}`;
      pushMessageBeforeLive({ role: "system", kind: "text", content }, rt);
      return;
    }
    if (msg.type === "result") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      const output = String(msg.output ?? "");
      if (rt.suppressNextClearHistoryResult) {
        rt.suppressNextClearHistoryResult = false;
        const kind = String((msg as { kind?: unknown }).kind ?? "").trim();
        if (msg.ok === true && kind === "clear_history") {
          clearStepLive(rt);
          finalizeCommandBlock(rt);
          flushQueuedPrompts(rt);
          return;
        }
      }
      const threadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
      if (threadId) {
        rt.activeThreadId.value = threadId;
      }
      const expectedThreadId = String((msg as { expectedThreadId?: unknown }).expectedThreadId ?? "").trim();
      const didThreadReset = Boolean((msg as { threadReset?: unknown }).threadReset);
      if (didThreadReset) {
        const detail = expectedThreadId && threadId ? ` (expected=${expectedThreadId}, actual=${threadId})` : "";
        threadReset(rt, {
          notice: "Context thread was reset. Chat history was cleared to start a new conversation.",
          warning:
            `Context thread was reset${detail}. Chat history may not match model context. ` +
            "History was cleared automatically.",
          keepLatestTurn: true,
          clearBackendHistory: true,
          resetThreadId: true,
          source: "result_thread_reset",
        });
      }
      if (rt.pendingCdRequestedPath && msg.ok === false) {
        if (output.includes("/cd") || output.includes("目录")) {
          rt.pendingCdRequestedPath = null;
        }
      }
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      finalizeAssistant(output, rt);
      flushQueuedPrompts(rt);
      return;
    }
    if (msg.type === "error") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      pushMessageBeforeLive({ role: "system", kind: "text", content: String(msg.message ?? "error") }, rt);
      flushQueuedPrompts(rt);
      return;
    }
    if (msg.type === "command") {
      const cmd = String(msg.command?.command ?? "").trim();
      const id = String(msg.command?.id ?? "").trim();
      const outputDelta = String(msg.command?.outputDelta ?? "");
      const key = commandKeyForWsEvent(cmd, id || null);
      if (!key) return;
      rt.busy.value = true;
      rt.turnInFlight = true;
      ingestCommand(cmd, rt, id || null);
      upsertExecuteBlock(key, cmd, outputDelta, rt);
      if (cmd) {
        ingestCommandActivity(rt.liveActivity, cmd);
        upsertLiveActivity(rt);
      }
      return;
    }
  };

  wsInstance.connect();
}

async function createTask(input: CreateTaskInput): Promise<Task | null> {
  apiError.value = null;
  clearNotice();
  try {
    const created = await api.post<Task>(withWorkspaceQuery("/api/tasks"), input);
    upsertTask(created);
    selectedId.value = created.id;
    return created;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
  return null;
}

async function submitTaskCreate(input: CreateTaskInput): Promise<void> {
  const created = await createTask(input);
  if (created) taskCreateDialogOpen.value = false;
}

async function submitTaskCreateAndRun(input: CreateTaskInput): Promise<void> {
  const created = await createTask(input);
  if (!created) {
    return;
  }
  taskCreateDialogOpen.value = false;
  await runTaskQueue();
}

function pendingIdsInQueueOrder(): string[] {
  return tasks.value
    .filter((t) => t.status === "pending")
    .slice()
    .sort((a, b) => {
      if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    })
    .map((t) => t.id);
}

async function updateQueuedTaskAndRun(id: string, updates: Record<string, unknown>): Promise<void> {
  const taskId = String(id ?? "").trim();
  if (!taskId) return;

  await updateQueuedTask(taskId, updates);
  if (apiError.value) {
    return;
  }

  const ids = pendingIdsInQueueOrder();
  const next = ids.filter((x) => x !== taskId);
  next.push(taskId);
  await reorderPendingTasks(next);
  if (apiError.value) {
    return;
  }

  await runTaskQueue();
}

async function refreshTaskRow(id: string, projectId: string = activeProjectId.value): Promise<void> {
  const taskId = String(id ?? "").trim();
  if (!taskId) return;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  try {
    const detail = await api.get<TaskDetail>(withWorkspaceQueryFor(pid, `/api/tasks/${taskId}`));
    upsertTask(detail, rt);
    if (Array.isArray(detail.plan)) {
      rt.plansByTaskId.value.set(taskId, detail.plan);
      rt.plansByTaskId.value = new Map(rt.plansByTaskId.value);
    }
  } catch {
    // ignore
  }
}

function setTaskRunBusy(id: string, busy: boolean, projectId: string = activeProjectId.value): void {
  const taskId = String(id ?? "").trim();
  if (!taskId) return;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  const next = new Set(rt.runBusyIds.value);
  if (busy) next.add(taskId);
  else next.delete(taskId);
  rt.runBusyIds.value = next;
}

function mockSingleTaskRun(taskId: string, projectId: string = activeProjectId.value): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  const now = Date.now();

  const existing = rt.tasks.value.find((t) => t.id === id);
  if (!existing) return;

  upsertTask({ ...existing, status: "running", startedAt: now, completedAt: null, error: null, result: null }, rt);
  window.setTimeout(() => {
    const t = rt.tasks.value.find((x) => x.id === id);
    if (!t) return;
    upsertTask({ ...t, status: "completed", completedAt: Date.now(), result: "mock: completed", error: null }, rt);
  }, 900);
}

async function runSingleTask(id: string, projectId: string = activeProjectId.value): Promise<void> {
  const taskId = String(id ?? "").trim();
  if (!taskId) return;
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);

  rt.apiError.value = null;
  clearNotice(pid);
  if (!apiAuthorized.value) {
    rt.apiError.value = "Unauthorized";
    return;
  }
  if (rt.runBusyIds.value.has(taskId)) {
    return;
  }

  setTaskRunBusy(taskId, true, pid);
  try {
    const res = await api.post<{ success: boolean; taskId?: string; state?: string; mode?: string }>(
      withWorkspaceQueryFor(pid, `/api/tasks/${taskId}/run`),
      {},
    );
    void res;
    setNotice(`Task ${taskId.slice(0, 8)} scheduled`, pid);
    await refreshTaskRow(taskId, pid);
    await loadQueueStatus(pid);
  } catch (error) {
    const msg = formatApiError(error);
    if (import.meta.env.DEV && looksLikeNotFound(msg)) {
      setNotice(`Task ${taskId.slice(0, 8)} scheduled (mock)`, pid);
      mockSingleTaskRun(taskId, pid);
      return;
    }
    rt.apiError.value = msg;
  } finally {
    setTaskRunBusy(taskId, false, pid);
  }
}

async function cancelTask(id: string): Promise<void> {
  apiError.value = null;
  clearNotice();
  try {
    const res = await api.patch<{ success: boolean; task?: Task | null }>(withWorkspaceQuery(`/api/tasks/${id}`), { action: "cancel" });
    if (res?.task) {
      upsertTask(res.task);
    }
    await loadTasks();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function retryTask(id: string): Promise<void> {
  apiError.value = null;
  clearNotice();
  try {
    const res = await api.post<{ success: boolean; task?: Task | null }>(withWorkspaceQuery(`/api/tasks/${id}/retry`), {});
    if (res?.task) {
      upsertTask(res.task);
    }
    await loadTasks();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function deleteTask(id: string): Promise<void> {
  apiError.value = null;
  clearNotice();
  const taskId = String(id ?? "").trim();
  if (!taskId) return;
  const t = tasks.value.find((x) => x.id === taskId);
  if (t && (t.status === "running" || t.status === "planning")) {
    apiError.value = "任务执行中，无法删除（请先终止）";
    return;
  }
  pendingDeleteTaskId.value = taskId;
  deleteConfirmOpen.value = true;
  void nextTick(() => deleteConfirmButtonEl.value?.focus());
}

async function updateQueuedTask(id: string, updates: Record<string, unknown>): Promise<void> {
  apiError.value = null;
  clearNotice();
  try {
    const res = await api.patch<{ success: boolean; task?: Task }>(withWorkspaceQuery(`/api/tasks/${id}`), updates);
    if (res?.task) {
      upsertTask(res.task);
    } else {
      await loadTasks();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

function sendMainPrompt(content: string): void {
  apiError.value = null;
  const text = String(content ?? "");
  const images = pendingImages.value.slice();
  pendingImages.value = [];
  enqueueMainPrompt(text, images);
}

function interruptActive(): void {
  activeRuntime.value.ws?.interrupt();
}

function clearActiveChat(): void {
  const rt = activeRuntime.value;
  threadReset(rt, {
    notice: "",
    warning: null,
    keepLatestTurn: false,
    clearBackendHistory: true,
    resetThreadId: true,
    source: "user_reset_thread",
  });
}

async function resumeTaskThread(projectId: string = activeProjectId.value): Promise<void> {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  rt.apiError.value = null;
  clearNotice(pid);

  if (runtimeTasksBusy(rt) || Boolean(rt.queueStatus.value?.running)) {
    rt.apiError.value = "任务执行中，无法恢复";
    return;
  }

  clearConversationForResume(rt);
  setNotice("正在恢复上下文…", pid);

  try {
    if (!rt.ws || !rt.connected.value) {
      await connectWs(pid);
    }
    rt.ws?.send("task_resume");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    rt.apiError.value = msg;
  }
}

function addPendingImages(imgs: IncomingImage[]): void {
  const rt = activeRuntime.value;
  rt.pendingImages.value = [...rt.pendingImages.value, ...(Array.isArray(imgs) ? imgs : [])];
}

function clearPendingImages(): void {
  activeRuntime.value.pendingImages.value = [];
}

async function activateProject(projectId: string): Promise<void> {
  const pid = normalizeProjectId(projectId);
  const rt = getRuntime(pid);
  if (!loggedIn.value) return;
  rt.apiError.value = null;
  rt.wsError.value = null;
  try {
    await loadQueueStatus(pid);
    if (!rt.ws || !rt.connected.value) {
      await connectWs(pid);
    }
    await loadTasks(pid);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    rt.apiError.value = msg;
  }
}

async function bootstrap(): Promise<void> {
  if (!loggedIn.value) return;
  try {
    await loadModels();
    await activateProject(activeProjectId.value);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

onMounted(() => {
  appMounted = true;
  initializeProjects();
  updateIsMobile();
  window.addEventListener("resize", updateIsMobile);
  if (loggedIn.value) {
    void bootstrap();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateIsMobile);
  closeAllConnections();
});

function select(id: string): void {
  selectedId.value = id;
}

function openTaskCreateDialog(): void {
  apiError.value = null;
  taskCreateDialogOpen.value = true;
}

function closeTaskCreateDialog(): void {
  taskCreateDialogOpen.value = false;
}
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
            :class="{ active: mobilePane === 'chat' }"
            role="tab"
            :aria-selected="mobilePane === 'chat'"
            @click="mobilePane = 'chat'"
          >
            对话
          </button>
          <button
            type="button"
            class="paneTab"
            :class="{ active: mobilePane === 'tasks' }"
            role="tab"
            :aria-selected="mobilePane === 'tasks'"
            @click="mobilePane = 'tasks'"
          >
            任务
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
            <button type="button" class="projectAdd" title="添加项目" @click="openProjectDialog">＋</button>
          </div>

          <div
            v-for="p in projects"
            :key="p.id"
            class="projectNode"
            :class="{ active: p.id === activeProjectId }"
          >
            <button
              type="button"
              class="projectRow"
              :title="p.path || p.name"
              @click="requestProjectSwitch(p.id)"
            >
              <span class="projectStatus" :class="{ spinning: runtimeProjectInProgress(getRuntime(p.id)) }" />
              <span class="projectText">
                <span class="projectName">{{ p.path || p.name }}</span>
                <span class="projectBranch">{{ formatProjectBranch(p.branch) }}</span>
              </span>
            </button>

            <div v-if="p.expanded" class="projectTasks">
              <div v-if="queueStatus && (!queueStatus.enabled || !queueStatus.ready)" class="error">
                <div>任务队列未运行：{{ !queueStatus.enabled ? "TASK_QUEUE_ENABLED=false" : queueStatus.error || "agent not ready" }}</div>
                <div style="margin-top: 6px; opacity: 0.85;">任务会保持 pending；请在启动 web server 前配置模型 Key，并确保 `TASK_QUEUE_ENABLED=true`。</div>
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
                @resetThread="clearActiveChat"
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

<style scoped>
.boot {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #0b1020 0%, #1e293b 100%);
  color: rgba(229, 231, 235, 0.8);
}
.app {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden;
  background: var(--app-bg);
  color: var(--text);
}
.topbar {
  flex-shrink: 0;
  height: calc(48px + env(safe-area-inset-top, 0px));
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: env(safe-area-inset-top, 0px) 12px 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  width: 100%;
  gap: 10px;
}
.topbarMain {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.projectTabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.projectTabs::-webkit-scrollbar {
  display: none;
}
.projectTab {
  border: 1px solid var(--border);
  background: rgba(15, 23, 42, 0.04);
  color: #334155;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
}
.projectTab.active {
  background: rgba(37, 99, 235, 0.12);
  border-color: rgba(37, 99, 235, 0.45);
  color: #1d4ed8;
  box-shadow: var(--shadow-sm);
}
.projectTabText {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.projectAdd {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--accent);
  font-weight: 900;
  display: grid;
  place-items: center;
  line-height: 1;
  cursor: pointer;
}
.projectAdd:hover {
  background: rgba(37, 99, 235, 0.06);
}
.modalOverlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(10px);
  z-index: 50;
}
.modalCard {
  width: min(520px, 100%);
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.22);
  padding: 18px 18px 16px 18px;
}
.modalTitle {
  font-size: 16px;
  font-weight: 900;
  color: #0f172a;
}
.modalDesc {
  margin-top: 6px;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;
}
.modalPreview {
  margin-top: 12px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: #f8fafc;
  border-radius: 12px;
  padding: 10px 12px;
}
.modalPreviewTitle {
  font-size: 13px;
  font-weight: 900;
  color: #0f172a;
}
.modalPreviewPrompt {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #64748b;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}
.modalForm {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modalLabel {
  font-size: 12px;
  font-weight: 800;
  color: #0f172a;
}
.modalInput {
  width: 100%;
  padding: 12px 12px;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.5);
  background: rgba(248, 250, 252, 0.9);
  font-size: 14px;
  color: #0f172a;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}
.modalInput::placeholder {
  color: rgba(100, 116, 139, 0.65);
}
.modalInput:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
  background: white;
}
.modalHintRow {
  margin-top: -6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.pathStatus {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 700;
  color: #64748b;
}
.pathStatus.ok {
  color: #059669;
}
.pathStatus.error {
  color: #dc2626;
}
.pathStatus.checking {
  color: #64748b;
}
.inlineAction {
  border: none;
  background: transparent;
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 4px 2px;
}
.inlineAction:disabled {
  color: rgba(100, 116, 139, 0.5);
  cursor: not-allowed;
}
.modalError {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 12px;
  color: #dc2626;
}
.modalActions {
  margin-top: 16px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.btnSecondary,
.btnPrimary,
.btnDanger {
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  border: 1px solid rgba(226, 232, 240, 0.9);
}
.btnSecondary {
  background: var(--surface);
  color: var(--text);
}
.btnSecondary:hover {
  background: rgba(15, 23, 42, 0.03);
}
.btnPrimary {
  border-color: rgba(37, 99, 235, 0.25);
  background: var(--accent);
  color: white;
}
.btnPrimary:hover:not(:disabled) {
  background: var(--accent-2);
}
.btnPrimary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btnDanger {
  border-color: rgba(239, 68, 68, 0.25);
  background: var(--danger);
  color: white;
}
.btnDanger:hover {
  background: var(--danger-2);
}
.brand {
  font-weight: 700;
  font-size: 14px;
  color: var(--accent);
  white-space: nowrap;
  flex-shrink: 0;
}
.paneTabs {
  display: flex;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
  flex: 0 0 auto;
  width: min(180px, 42vw);
  justify-content: center;
  min-width: 0;
}
.paneTab {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}
.paneTab.active {
  background: white;
  color: #0f172a;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.right {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #ef4444;
}
.dot.on {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
}
.muted {
  color: #64748b;
  font-size: 13px;
}
.layout {
  --sidebar-width: clamp(280px, 24vw, 360px);
  flex: 1;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  gap: 12px;
  padding: 12px 12px 8px 12px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
  min-height: 0;
  overflow: hidden;
}
.chatHost {
  flex: 1;
  min-height: 0;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.projectTree {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: rgba(248, 250, 252, 0.95);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 16px;
  padding: 10px;
  height: 80vh;
  min-height: 0;
  overflow: auto;
}
.projectTreeHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 2px;
}
.projectTreeTitle {
  font-size: 13px;
  font-weight: 800;
  color: #64748b;
}
.projectNode {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.projectRow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 10px;
  padding: 6px 12px;
  background: white;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  transition: box-shadow 0.15s ease, background-color 0.15s ease;
}
.projectNode.active .projectRow {
  background: linear-gradient(180deg, #2f80ff 0%, #1f6fff 100%);
  color: white;
  box-shadow: 0 8px 16px rgba(79, 142, 247, 0.32);
}
.projectRow:hover {
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.08);
}
.projectStatus {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(148, 163, 184, 0.75);
  position: relative;
  flex: 0 0 auto;
}
.projectStatus::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 6px;
  height: 6px;
  margin: auto;
  border-radius: 999px;
  background: transparent;
}
.projectNode.active .projectStatus::after {
  background: rgba(255, 255, 255, 0.9);
}
.projectStatus.spinning {
  border-color: #10b981;
  border-top-color: transparent;
  animation: spin 0.9s linear infinite;
}
.projectStatus.spinning::after {
  background: transparent;
}
.projectNode.active .projectStatus {
  border-color: rgba(255, 255, 255, 0.8);
}
.projectNode.active .projectStatus.spinning {
  border-color: #10b981;
  border-top-color: transparent;
}
.projectNode.active .projectStatus.spinning::after {
  background: transparent;
}
.projectText {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.projectName {
  font-size: 14px;
  font-weight: 700;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.projectBranch {
  display: block;
  font-size: 11px;
  line-height: 1.2;
  color: rgba(100, 116, 139, 0.95);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.projectNode.active .projectBranch {
  color: rgba(255, 255, 255, 0.75);
}
.projectTasks {
  margin-left: 14px;
  padding-left: 10px;
  border-left: 2px solid rgba(226, 232, 240, 0.95);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.taskBoard {
  /* Keep the list compact; it should scroll internally when there are many tasks. */
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.modalCardWide {
  width: min(900px, 100%);
  max-height: 88vh;
  overflow: hidden;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  display: flex;
  flex-direction: column;
}
.taskCreateModal {
  flex: 1 1 auto;
  min-height: 0;
}
.rightPane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.link {
  background: transparent;
  border: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: color 0.15s;
}
.link:hover {
  color: #1d4ed8;
  text-decoration: underline;
}
.error {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  color: #dc2626;
}
.warning {
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.12);
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  color: #b45309;
}
.noticeToast {
  position: fixed;
  left: 50%;
  top: calc(48px + env(safe-area-inset-top, 0px) + 12px);
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(34, 197, 94, 0.28);
  background: rgba(34, 197, 94, 0.1);
  box-shadow: var(--shadow-sm);
  font-size: 13px;
  color: #15803d;
  max-width: min(92vw, 620px);
  pointer-events: none;
  z-index: 40;
  animation: noticeToastIn 0.14s ease-out;
}
.noticeToastText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes noticeToastIn {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    padding: 8px;
    gap: 8px;
    max-width: 100%;
  }
  :deep(input),
  :deep(textarea),
  :deep(select) {
    font-size: 16px;
  }
  .topbar {
    padding-left: 12px;
    padding-right: 12px;
  }
  .left,
  .rightPane {
    display: none;
  }
  .layout[data-pane="tasks"] .left {
    display: flex;
  }
  .layout[data-pane="chat"] .rightPane {
    display: flex;
  }
}
</style>
