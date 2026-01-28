<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { ApiClient } from "./api/client";
import type { AuthMe, CreateTaskInput, ModelConfig, PlanStep, Task, TaskDetail, TaskEventPayload, TaskQueueStatus } from "./api/types";
import { AdsWebSocket } from "./api/ws";
import LoginGate from "./components/LoginGate.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";
import { finalizeStreamingOnDisconnect, mergeHistoryFromServer } from "./lib/chat_sync";
import { formatApiError, looksLikeNotFound } from "./lib/api_error";

const PROJECTS_KEY = "ADS_WEB_PROJECTS";
const ACTIVE_PROJECT_KEY = "ADS_WEB_ACTIVE_PROJECT";
const LEGACY_WS_SESSION_KEY = "ADS_WEB_SESSION";

type WorkspaceState = { path?: string; rules?: string; modified?: string[] };
type ProjectTab = {
  id: string;
  name: string;
  path: string;
  sessionId: string;
  initialized: boolean;
  createdAt: number;
  updatedAt: number;
};

type BufferedTaskChatEvent =
  | { kind: "message"; role: "user" | "assistant" | "system"; content: string }
  | { kind: "delta"; role: "assistant"; delta: string; source?: "chat" | "step"; modelUsed?: string | null }
  | { kind: "command"; command: string };

type TaskChatBuffer = { firstTs: number; events: BufferedTaskChatEvent[] };

const TASK_CHAT_BUFFER_TTL_MS = 5 * 60_000;
const TASK_CHAT_BUFFER_MAX_EVENTS = 64;

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
// Avoid unbounded in-memory growth during long-running sessions.
const MAX_CHAT_MESSAGES = 200;

type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
  streaming?: boolean;
};
const LIVE_STEP_ID = "live-step";
type IncomingImage = { name?: string; mime?: string; data: string };
type QueuedPrompt = { id: string; text: string; images: IncomingImage[]; createdAt: number };

const isMobile = ref(false);
const mobilePane = ref<"tasks" | "chat">("chat");

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);

type ProjectRuntime = {
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
  runBusyIds: ReturnType<typeof ref<Set<string>>>;
  busy: ReturnType<typeof ref<boolean>>;
  messages: ReturnType<typeof ref<ChatItem[]>>;
  recentCommands: ReturnType<typeof ref<string[]>>;
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
  startedTaskIds: Set<string>;
  taskChatBufferByTaskId: Map<string, TaskChatBuffer>;
};

function createProjectRuntime(): ProjectRuntime {
  return {
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
    runBusyIds: ref<Set<string>>(new Set()),
    busy: ref(false),
    messages: ref<ChatItem[]>([]),
    recentCommands: ref<string[]>([]),
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
  return { id, name, path, sessionId, initialized, createdAt: now, updatedAt: now };
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

  projects.value = normalized;

  const storedActive = String(localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "").trim();
  const initialActive = normalized.some((p) => p.id === storedActive) ? storedActive : normalized[0]!.id;
  activeProjectId.value = initialActive;
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

function clearChatState(): void {
  busy.value = false;
  activeRuntime.value.pendingCdRequestedPath = null;
  queuedPrompts.value = [];
  pendingImages.value = [];
  recentCommands.value = [];
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
  persistProjects();
  void activateProject(nextId);
}

function requestProjectSwitch(id: string): void {
  const nextId = String(id ?? "").trim();
  if (!nextId) return;
  if (nextId === activeProjectId.value) return;
  performProjectSwitch(nextId);
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
  persistProjects();

  closeProjectDialog();
  void activateProject(project.id);
}

function runtimeOrActive(rt?: ProjectRuntime): ProjectRuntime {
  return rt ?? activeRuntime.value;
}

function runtimeTasksBusy(rt: ProjectRuntime): boolean {
  return rt.tasks.value.some((t) => t.status === "planning" || t.status === "running");
}

function runtimeAgentBusy(rt: ProjectRuntime): boolean {
  return rt.busy.value || runtimeTasksBusy(rt);
}

function trimChatItems(items: ChatItem[]): ChatItem[] {
  const existing = Array.isArray(items) ? items : [];
  const live = existing.find((m) => m.id === LIVE_STEP_ID) ?? null;
  const nonLive = existing.filter((m) => m.id !== LIVE_STEP_ID);
  if (nonLive.length <= MAX_CHAT_MESSAGES) {
    return live ? [...nonLive, live] : nonLive;
  }
  const trimmed = nonLive.slice(nonLive.length - MAX_CHAT_MESSAGES);
  return live ? [...trimmed, live] : trimmed;
}

function setMessages(items: ChatItem[], rt?: ProjectRuntime): void {
  runtimeOrActive(rt).messages.value = trimChatItems(items);
}

function pushMessageBeforeLive(item: Omit<ChatItem, "id">, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const next = { ...item, id: randomId("msg") };
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
  const next = [...state.recentCommands.value, trimmed];
  state.recentCommands.value = next.slice(Math.max(0, next.length - MAX_RECENT_COMMANDS));
}

function resetConversation(rt: ProjectRuntime, notice: string, keepLatestTurn = true): void {
  const existing = rt.messages.value.slice();
  const withoutLive = existing.filter((m) => m.id !== LIVE_STEP_ID);
  const tail = (() => {
    if (!keepLatestTurn) return [];
    for (let i = withoutLive.length - 1; i >= 0; i--) {
      if (withoutLive[i]!.role === "user") return withoutLive.slice(i);
    }
    return [];
  })();

  rt.recentCommands.value = [];
  rt.seenCommandIds.clear();
  rt.pendingImages.value = [];
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

function ingestCommand(rawCmd: string, rt?: ProjectRuntime, id?: string | null): void {
  const state = runtimeOrActive(rt);
  const cmd = String(rawCmd ?? "").trim();
  if (!cmd) return;

  const normalized = `$ ${cmd}`;
  if (id) {
    if (state.seenCommandIds.has(id)) return;
    state.seenCommandIds.add(id);
  } else {
    const prev = state.recentCommands.value[state.recentCommands.value.length - 1] ?? "";
    if (prev === normalized) return;
  }

  pushRecentCommand(normalized, state);
  upsertCommandBlock(state);
}

function upsertCommandBlock(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const lines = state.recentCommands.value.slice();
  const content = lines.join("\n").trim();
  const existing = state.messages.value.slice();
  let idx = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.kind === "command" && m.streaming) {
      idx = i;
      break;
    }
  }
  if (!content) {
    if (idx >= 0) {
      setMessages([...existing.slice(0, idx), ...existing.slice(idx + 1)], state);
    }
    return;
  }

  if (idx >= 0) {
    existing[idx]!.content = content;
    setMessages(existing.slice(), state);
    return;
  }

  let insertAt = existing.length;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) {
      insertAt = i;
      continue;
    }
    if (m.role === "assistant" && m.streaming) {
      insertAt = i;
      break;
    }
  }
  const item: ChatItem = { id: randomId("cmd"), role: "system", kind: "command", content, streaming: true };
  setMessages([...existing.slice(0, insertAt), item, ...existing.slice(insertAt)], state);
}

function finalizeCommandBlock(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  state.recentCommands.value = [];
  state.seenCommandIds.clear();
  const existing = state.messages.value.slice();
  let idx = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.kind === "command" && m.streaming) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  existing[idx]!.streaming = false;
  setMessages(existing.slice(), state);
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
    { id: randomId("q"), text: content, images: imgs, createdAt: Date.now() },
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

    pushMessageBeforeLive({ role: "user", kind: "text", content: display }, state);
    pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
    state.busy.value = true;
    clearStepLive(state);
    finalizeCommandBlock(state);
    state.ws.sendPrompt(next.images.length > 0 ? { text: next.text, images: next.images } : next.text);
	  } catch {
    state.queuedPrompts.value = [next, ...state.queuedPrompts.value];
	  }
}

function upsertStreamingDelta(delta: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = state.messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
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

  const nextItem: ChatItem = { id: randomId("stream"), role: "assistant", kind: "text", content: chunk, streaming: true };
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  if (liveIndex < 0) {
    setMessages([...existing, nextItem], state);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), nextItem, ...existing.slice(liveIndex)], state);
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
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = state.messages.value
    .filter(
      (m) =>
        !(
          m.id !== LIVE_STEP_ID &&
          m.role === "assistant" &&
          m.streaming &&
          m.kind === "text" &&
          String(m.content ?? "").length === 0
        ),
    )
    .slice();
  const idx = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const current = idx >= 0 ? existing[idx]!.content : "";
  const nextText = trimToLastLines(current + chunk, 14);
  const nextItem: ChatItem = { id: LIVE_STEP_ID, role: "assistant", kind: "text", content: nextText, streaming: true };
  const next = idx >= 0 ? [...existing.slice(0, idx), nextItem, ...existing.slice(idx + 1)] : [...existing, nextItem];
  setMessages(next, state);
}

function clearStepLive(rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  const next = existing.filter((m) => m.id !== LIVE_STEP_ID);
  if (next.length === existing.length) return;
  setMessages(next, state);
}

function finalizeAssistant(content: string, rt?: ProjectRuntime): void {
  const state = runtimeOrActive(rt);
  const text = String(content ?? "");
  if (!text) return;
  const existing = state.messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.role === "assistant" && m.streaming) {
      streamIndex = i;
      break;
    }
  }
  if (streamIndex >= 0) {
    existing[streamIndex]!.content = text;
    existing[streamIndex]!.streaming = false;
    setMessages(existing.slice(), state);
    return;
  }

  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  if (!normalizedText) return;
  const lastNonLive = (() => {
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (m.id === LIVE_STEP_ID) continue;
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
  if ((plansByTaskId.value.get(id)?.length ?? 0) > 0) return;
  try {
    const detail = await api.get<TaskDetail>(withWorkspaceQuery(`/api/tasks/${id}`));
    plansByTaskId.value.set(id, detail.plan);
    plansByTaskId.value = new Map(plansByTaskId.value);
  } catch {
    // ignore
  }
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
      pushMessageBeforeLive({ role: "user", kind: "text", content }, state);
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
    if (t.result && t.result.trim()) {
      finalizeAssistant(t.result, state);
    }
    flushQueuedPrompts(state);
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

    if (msg.type === "welcome") {
      let nextPath = "";
      const maybeWorkspace = (msg as { workspace?: unknown }).workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        const wsState = maybeWorkspace as WorkspaceState;
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
      if (current && nextPath) updateProject(current.id, { path: nextPath, initialized: true });
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
        if (current && nextPath) updateProject(current.id, { path: nextPath, initialized: true });
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
      const flushCommands = () => {
        if (cmdGroup.length === 0) return;
        next.push({ id: randomId("h-cmd"), role: "system", kind: "command", content: cmdGroup.join("\n") });
        cmdGroup = [];
      };
      for (let idx = 0; idx < items.length; idx++) {
        const entry = items[idx] as { role?: unknown; text?: unknown; kind?: unknown };
        const role = String(entry.role ?? "");
        const text = String(entry.text ?? "");
        const kind = String(entry.kind ?? "");
        const trimmed = text.trim();
        if (!trimmed) continue;
        const isCommand = kind === "command" || (role === "status" && trimmed.startsWith("$ "));
        if (isCommand) {
          cmdGroup = [...cmdGroup, trimmed].slice(-MAX_RECENT_COMMANDS);
          continue;
        }
        flushCommands();
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed });
      }
      flushCommands();
      applyMergedHistory(next, rt);
      return;
    }
    if (msg.type === "delta") {
      rt.busy.value = true;
      upsertStreamingDelta(String(msg.delta ?? ""), rt);
      return;
    }
    if (msg.type === "explored") {
      rt.busy.value = true;
      const entry = (msg as { entry?: unknown }).entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (summary) {
          // "Execute" is already rendered in the dedicated EXECUTE panel (command block).
          // Showing it again here causes duplicate command UI.
          if (category === "Execute") return;
          const categoryLabels: Record<string, string> = {
            List: "列出",
            Search: "搜索",
            Read: "读取",
            Write: "写入",
            Execute: "执行",
            Agent: "代理",
            Tool: "工具",
            WebSearch: "网页搜索",
          };
          const label = categoryLabels[category] ?? category;
          const prefix = label ? `· ${label}: ` : "· ";
          upsertStepLiveDelta(`${prefix}${summary}\n`, rt);
        }
      }
      return;
    }
    if (msg.type === "result") {
      rt.busy.value = false;
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
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      pushMessageBeforeLive({ role: "system", kind: "text", content: String(msg.message ?? "error") }, rt);
      flushQueuedPrompts(rt);
      return;
    }
    if (msg.type === "command") {
      const cmd = String(msg.command?.command ?? "").trim();
      const id = String(msg.command?.id ?? "").trim();
      ingestCommand(cmd, rt, id || null);
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
  <LoginGate v-if="!loggedIn" @logged-in="handleLoggedIn" />
  <div v-else class="app">
    <header class="topbar">
      <div class="brand">ADS</div>
      <div class="topbarMain">
        <div class="projectTabs" role="tablist" aria-label="项目">
          <button
            v-for="p in projects"
            :key="p.id"
            type="button"
            class="projectTab"
            :class="{ active: p.id === activeProjectId }"
            role="tab"
            :aria-selected="p.id === activeProjectId"
            :title="p.path || p.name"
            @click="requestProjectSwitch(p.id)"
          >
            <span class="projectTabText">{{ p.path || p.name }}</span>
          </button>
          <button type="button" class="projectAdd" title="添加项目" @click="openProjectDialog">＋</button>
        </div>

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
          @reorder="(ids) => reorderPendingTasks(ids)"
          @queueRun="runTaskQueue"
          @queuePause="pauseTaskQueue"
          @runSingle="(id) => runSingleTask(id)"
          @cancel="cancelTask"
          @retry="retryTask"
          @delete="deleteTask"
          @create="openTaskCreateDialog"
        />
      </aside>

      <section class="rightPane">
        <MainChatView
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

    <div v-if="taskCreateDialogOpen" class="modalOverlay" role="dialog" aria-modal="true" @click.self="closeTaskCreateDialog">
      <div class="modalCard modalCardWide">
        <TaskCreateForm
          class="taskCreateModal"
          :models="models"
          :workspace-root="resolveActiveWorkspaceRoot() || ''"
          @submit="submitTaskCreate"
          @reset-thread="clearActiveChat"
        />
      </div>
    </div>

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
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--accent);
  font-weight: 800;
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
  flex: 1;
  display: grid;
  grid-template-columns: 380px 1fr;
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
.taskBoard {
  /* Keep the list compact; it should scroll internally when there are many tasks. */
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.modalCardWide {
  width: min(760px, 100%);
  max-height: 85vh;
  overflow: hidden;
  padding: 0;
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
