<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { ApiClient } from "./api/client";
import type { CreateTaskInput, ModelConfig, PlanStep, Task, TaskDetail, TaskEventPayload, TaskQueueStatus } from "./api/types";
import { AdsWebSocket } from "./api/ws";
import TokenGate from "./components/TokenGate.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";

const TOKEN_KEY = "ADS_WEB_TOKEN";
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

const token = ref(localStorage.getItem(TOKEN_KEY) ?? "");
const connected = ref(false);
const apiError = ref<string | null>(null);
const wsError = ref<string | null>(null);
const queueStatus = ref<TaskQueueStatus | null>(null);
const workspacePath = ref("");

const projects = ref<ProjectTab[]>([]);
const activeProjectId = ref("");
const pendingProjectCd = ref<{ projectId: string; requestedPath: string } | null>(null);
const projectDialogOpen = ref(false);
const projectDialogPath = ref("");
const projectDialogName = ref("");
const projectDialogError = ref<string | null>(null);
const switchConfirmOpen = ref(false);
const pendingSwitchProjectId = ref<string | null>(null);
const deleteConfirmOpen = ref(false);
const pendingDeleteTaskId = ref<string | null>(null);
const deleteConfirmButtonEl = ref<HTMLButtonElement | null>(null);
const projectPathEl = ref<HTMLInputElement | null>(null);
const projectNameEl = ref<HTMLInputElement | null>(null);
const projectDialogPathStatus = ref<"idle" | "checking" | "ok" | "error">("idle");
const projectDialogPathMessage = ref("");
const lastValidatedProjectPath = ref("");
let projectPathValidationSeq = 0;

type PathValidateResponse = {
  ok: boolean;
  allowed: boolean;
  exists: boolean;
  isDirectory: boolean;
  resolvedPath?: string;
  error?: string;
  allowedDirs?: string[];
};

const api = new ApiClient({ baseUrl: "", token: token.value });

const tasks = ref<Task[]>([]);
const models = ref<ModelConfig[]>([]);
const selectedId = ref<string | null>(null);

type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
  streaming?: boolean;
};
const busy = ref(false);
const messages = ref<ChatItem[]>([]);
const LIVE_STEP_ID = "live-step";
const recentCommands = ref<string[]>([]);
type IncomingImage = { name?: string; mime?: string; data: string };
const pendingImages = ref<IncomingImage[]>([]);
type QueuedPrompt = { id: string; text: string; images: IncomingImage[]; createdAt: number };
const queuedPrompts = ref<QueuedPrompt[]>([]);

const tasksBusy = computed(() => tasks.value.some((t) => t.status === "planning" || t.status === "running"));
const agentBusy = computed(() => busy.value || tasksBusy.value);

const isMobile = ref(false);
const mobilePane = ref<"tasks" | "chat">("chat");

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);
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
  pendingProjectCd.value = null;
  queuedPrompts.value = [];
  pendingImages.value = [];
  recentCommands.value = [];
  clearStepLive();
  finalizeCommandBlock();
  setMessages([]);
}

function performProjectSwitch(id: string): void {
  const nextId = String(id ?? "").trim();
  if (!nextId) return;
  if (nextId === activeProjectId.value) return;

  ws?.close();
  ws = null;
  connected.value = false;
  wsError.value = null;
  clearChatState();

  activeProjectId.value = nextId;
  persistProjects();
  connectWs();
}

function requestProjectSwitch(id: string): void {
  const nextId = String(id ?? "").trim();
  if (!nextId) return;
  if (nextId === activeProjectId.value) return;

  const hasUnsavedDraft = queuedPrompts.value.length > 0 || pendingImages.value.length > 0;
  if (busy.value || hasUnsavedDraft) {
    pendingSwitchProjectId.value = nextId;
    switchConfirmOpen.value = true;
    return;
  }
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
    await api.delete<{ success: boolean }>(`/api/tasks/${taskId}`);
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
}

async function validateProjectDialogPath(options?: { force?: boolean }): Promise<boolean> {
  const path = projectDialogPath.value.trim();
  if (!path) {
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
    lastValidatedProjectPath.value = "";
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
      const resolved = String(result.resolvedPath ?? "").trim();
      if (resolved && resolved !== path) {
        projectDialogPath.value = resolved;
      }
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
  const project = createProjectTab({ path, name, initialized: false });
  projects.value = [...projects.value, project];
  activeProjectId.value = project.id;
  persistProjects();

  closeProjectDialog();
  clearChatState();
  connectWs();
}

function setMessages(items: ChatItem[]): void {
  messages.value = items;
}

function pushMessageBeforeLive(item: Omit<ChatItem, "id">): void {
  const existing = messages.value.slice();
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const next = { ...item, id: randomId("msg") };
  if (liveIndex < 0) {
    setMessages([...existing, next]);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), next, ...existing.slice(liveIndex)]);
}

function pushRecentCommand(command: string): void {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return;
  const next = [...recentCommands.value, trimmed];
  recentCommands.value = next.slice(Math.max(0, next.length - 5));
}

function upsertCommandBlock(): void {
  const lines = recentCommands.value.slice();
  const content = lines.join("\n").trim();
  const existing = messages.value.slice();
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
      setMessages([...existing.slice(0, idx), ...existing.slice(idx + 1)]);
    }
    return;
  }

  if (idx >= 0) {
    existing[idx]!.content = content;
    setMessages(existing.slice());
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
  setMessages([...existing.slice(0, insertAt), item, ...existing.slice(insertAt)]);
}

function finalizeCommandBlock(): void {
  recentCommands.value = [];
  const existing = messages.value.slice();
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
  setMessages(existing.slice());
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

function flushQueuedPrompts(): void {
  if (agentBusy.value) return;
  if (!connected.value) return;
  if (!ws) return;
  if (queuedPrompts.value.length === 0) return;

  const next = queuedPrompts.value[0]!;
  queuedPrompts.value = queuedPrompts.value.slice(1);

  try {
    const display =
      next.text && next.images.length > 0
        ? `${next.text}\n\n[图片 x${next.images.length}]`
        : next.text
          ? next.text
          : `[图片 x${next.images.length}]`;

	    pushMessageBeforeLive({ role: "user", kind: "text", content: display });
	    pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true });
	    busy.value = true;
	    clearStepLive();
	    finalizeCommandBlock();
	    ws.sendPrompt(next.images.length > 0 ? { text: next.text, images: next.images } : next.text);
	  } catch {
	    queuedPrompts.value = [next, ...queuedPrompts.value];
	  }
}

function upsertStreamingDelta(delta: string): void {
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = messages.value.slice();
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
    setMessages(existing.slice());
    return;
  }

  const nextItem: ChatItem = { id: randomId("stream"), role: "assistant", kind: "text", content: chunk, streaming: true };
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  if (liveIndex < 0) {
    setMessages([...existing, nextItem]);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), nextItem, ...existing.slice(liveIndex)]);
}

function trimToLastLines(text: string, maxLines: number, maxChars = 2500): string {
  const normalized = String(text ?? "");
  const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
  const lines = recent.split("\n");
  if (lines.length <= maxLines) return recent;
  return lines.slice(lines.length - maxLines).join("\n");
}

function upsertStepLiveDelta(delta: string): void {
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = messages.value
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
  setMessages(next);
}

function clearStepLive(): void {
  const existing = messages.value.slice();
  const next = existing.filter((m) => m.id !== LIVE_STEP_ID);
  if (next.length === existing.length) return;
  setMessages(next);
}

function finalizeAssistant(content: string): void {
  const text = String(content ?? "");
  if (!text) return;
  const existing = messages.value.slice();
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
    setMessages(existing.slice());
    return;
  }
  pushMessageBeforeLive({ role: "assistant", kind: "text", content: text });
}

const expanded = ref<Set<string>>(new Set());
const plansByTaskId = ref<Map<string, PlanStep[]>>(new Map());

async function ensurePlan(taskId: string): Promise<void> {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  if ((plansByTaskId.value.get(id)?.length ?? 0) > 0) return;
  try {
    const detail = await api.get<TaskDetail>(`/api/tasks/${id}`);
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

let ws: AdsWebSocket | null = null;

const hasToken = computed(() => Boolean(token.value.trim()));
const tokenRequired = ref<boolean | null>(null);

function setToken(next: string): void {
  token.value = next;
  localStorage.setItem(TOKEN_KEY, next);
  api.setToken(next);
  void bootstrap();
}

async function detectTokenRequirement(): Promise<void> {
  if (tokenRequired.value !== null) return;
  try {
    const probe = new ApiClient({ baseUrl: "", token: "" });
    await probe.get<ModelConfig[]>("/api/models");
    tokenRequired.value = false;
  } catch {
    tokenRequired.value = true;
  }
}

async function loadModels(): Promise<void> {
  models.value = await api.get<ModelConfig[]>("/api/models");
}

async function loadQueueStatus(): Promise<void> {
  queueStatus.value = await api.get<TaskQueueStatus>("/api/task-queue/status");
}

async function loadTasks(): Promise<void> {
  tasks.value = await api.get<Task[]>("/api/tasks?limit=100");
  if (!selectedId.value && tasks.value.length > 0) {
    const nextPending = tasks.value
      .filter((t) => t.status === "pending")
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      })[0];
    selectedId.value = (nextPending ?? tasks.value[0])!.id;
  }
}

function upsertTask(t: Task): void {
  const idx = tasks.value.findIndex((x) => x.id === t.id);
  if (idx >= 0) {
    tasks.value[idx] = t;
  } else {
    tasks.value.unshift(t);
  }
}

function onTaskEvent(payload: { event: TaskEventPayload["event"]; data: unknown }): void {
  if (payload.event === "task:updated") {
    const t = payload.data as Task;
    upsertTask(t);
    return;
  }
  if (payload.event === "command") {
    const data = payload.data as { taskId: string; command: string };
    void data.taskId;
    pushRecentCommand(`$ ${data.command}`);
    upsertCommandBlock();
    return;
  }
  if (payload.event === "message:delta") {
    const data = payload.data as { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" };
    if (data.role === "assistant") {
      if (data.source === "step") {
        upsertStepLiveDelta(data.delta);
      } else {
        upsertStreamingDelta(data.delta);
      }
    }
    return;
  }
  if (payload.event === "task:started") {
    const t = payload.data as Task;
    upsertTask(t);
    finalizeCommandBlock();
    return;
  }
  if (payload.event === "task:planned") {
    const data = payload.data as { task: Task; plan?: Array<{ stepNumber: number; title: string; description?: string | null }> };
    upsertTask(data.task);
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
      plansByTaskId.value.set(data.task.id, steps);
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    return;
  }
  if (payload.event === "task:running") {
    const t = payload.data as Task;
    upsertTask(t);
    return;
  }
  if (payload.event === "step:started") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    const plan = plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "running";
      }
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    clearStepLive();
    return;
  }
  if (payload.event === "step:completed") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    const plan = plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "completed";
      }
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    clearStepLive();
    return;
  }
  if (payload.event === "message") {
    const data = payload.data as { taskId: string; role: string; content: string };
    if (data.role === "assistant") {
      finalizeAssistant(data.content);
      return;
    }
    if (data.role === "user") {
      pushMessageBeforeLive({ role: "user", kind: "text", content: data.content });
      return;
    }
    if (data.role === "system") {
      pushMessageBeforeLive({ role: "system", kind: "text", content: data.content });
      return;
    }
    return;
  }
  if (payload.event === "task:completed") {
    const t = payload.data as Task;
    upsertTask(t);
    clearStepLive();
    finalizeCommandBlock();
    if (t.result && t.result.trim()) {
      pushMessageBeforeLive({ role: "assistant", kind: "text", content: t.result });
    }
    flushQueuedPrompts();
    return;
  }
  if (payload.event === "task:failed") {
    const data = payload.data as { task: Task; error: string };
    upsertTask(data.task);
    clearStepLive();
    finalizeCommandBlock();
    pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` });
    flushQueuedPrompts();
    return;
  }
  if (payload.event === "task:cancelled") {
    const t = payload.data as Task;
    upsertTask(t);
    clearStepLive();
    finalizeCommandBlock();
    pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" });
    flushQueuedPrompts();
    return;
  }
}

function connectWs(): void {
  if (tokenRequired.value && !hasToken.value) return;
  const project = activeProject.value;
  if (!project) return;
  ws?.close();
  ws = new AdsWebSocket({ token: token.value, sessionId: project.sessionId });
  ws.onOpen = () => {
    connected.value = true;
    wsError.value = null;
    flushQueuedPrompts();
  };
  ws.onClose = (ev) => {
    connected.value = false;
    if (ev.code === 4401) {
      wsError.value = "Unauthorized (token invalid)";
    }
  };
  ws.onError = () => {
    connected.value = false;
    wsError.value = "WebSocket error";
  };
  ws.onTaskEvent = onTaskEvent;
  ws.onMessage = (msg) => {
    if (msg.type === "welcome") {
      let nextPath = "";
      const maybeWorkspace = (msg as { workspace?: unknown }).workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        const wsState = maybeWorkspace as WorkspaceState;
        nextPath = String(wsState.path ?? "").trim();
        if (nextPath) workspacePath.value = nextPath;
      }

      const current = activeProject.value;
      if (current && !current.initialized && current.path.trim()) {
        pendingProjectCd.value = { projectId: current.id, requestedPath: current.path.trim() };
        ws?.send("command", { command: `/cd ${current.path.trim()}`, silent: true });
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
        if (nextPath) workspacePath.value = nextPath;

        if (pendingProjectCd.value && pendingProjectCd.value.projectId === activeProjectId.value) {
          updateProject(pendingProjectCd.value.projectId, { path: nextPath || pendingProjectCd.value.requestedPath, initialized: true });
          pendingProjectCd.value = null;
          return;
        }
        const current = activeProject.value;
        if (current && nextPath) updateProject(current.id, { path: nextPath, initialized: true });
      }
      return;
    }

    if (msg.type === "history") {
      // 如果正在忙或有排队消息，跳过 history 更新，避免覆盖正在进行的消息
      if (busy.value || queuedPrompts.value.length > 0) return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      recentCommands.value = [];
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
          cmdGroup = [...cmdGroup, trimmed].slice(-5);
          continue;
        }
        flushCommands();
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed });
      }
      flushCommands();
      setMessages(next);
      return;
    }
    if (msg.type === "delta") {
      busy.value = true;
      upsertStreamingDelta(String(msg.delta ?? ""));
      return;
    }
    if (msg.type === "explored") {
      busy.value = true;
      const entry = (msg as { entry?: unknown }).entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (summary) {
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
          upsertStepLiveDelta(`${prefix}${summary}\n`);
        }
      }
      return;
    }
    if (msg.type === "result") {
      busy.value = false;
      if (pendingProjectCd.value && msg.ok === false) {
        const output = String(msg.output ?? "");
        if (output.includes("/cd") || output.includes("目录")) {
          pendingProjectCd.value = null;
        }
      }
      clearStepLive();
      finalizeCommandBlock();
      finalizeAssistant(String(msg.output ?? ""));
      flushQueuedPrompts();
      return;
    }
    if (msg.type === "error") {
      busy.value = false;
      clearStepLive();
      finalizeCommandBlock();
      pushMessageBeforeLive({ role: "system", kind: "text", content: String(msg.message ?? "error") });
      flushQueuedPrompts();
      return;
    }
	    if (msg.type === "command") {
	      const cmd = String(msg.command?.command ?? "").trim();
	      if (cmd) {
	        pushRecentCommand(`$ ${cmd}`);
	        upsertCommandBlock();
	      }
	      const outputDelta = String(msg.command?.outputDelta ?? "");
	      if (outputDelta) {
	        upsertStepLiveDelta(outputDelta);
	      }
	      return;
	    }
	  };
	  ws.connect();
	}

async function createTask(input: CreateTaskInput): Promise<void> {
  apiError.value = null;
  try {
    const created = await api.post<Task>("/api/tasks", input);
    upsertTask(created);
    selectedId.value = created.id;
    if (created.prompt && created.prompt.trim()) {
      pushMessageBeforeLive({ role: "user", kind: "text", content: created.prompt });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function cancelTask(id: string): Promise<void> {
  apiError.value = null;
  try {
    const res = await api.patch<{ success: boolean; task?: Task | null }>(`/api/tasks/${id}`, { action: "cancel" });
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
  try {
    const res = await api.post<{ success: boolean; task?: Task | null }>(`/api/tasks/${id}/retry`, {});
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
  try {
    const res = await api.patch<{ success: boolean; task?: Task }>(`/api/tasks/${id}`, updates);
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

async function bootstrap(): Promise<void> {
  await detectTokenRequirement();
  if (tokenRequired.value && !hasToken.value) return;
  apiError.value = null;
  wsError.value = null;
  try {
    await loadModels();
    await loadQueueStatus();
    await loadTasks();
    connectWs();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

onMounted(() => {
  initializeProjects();
  updateIsMobile();
  window.addEventListener("resize", updateIsMobile);
  void bootstrap();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateIsMobile);
  ws?.close();
  ws = null;
});

function select(id: string): void {
  selectedId.value = id;
}
</script>

<template>
  <div v-if="tokenRequired === null" class="boot">Loading…</div>
  <TokenGate v-else-if="tokenRequired && !hasToken" v-model="token" @update:modelValue="setToken" />
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

        <TaskBoard
          class="taskBoard"
          :tasks="tasks"
          :models="models"
          :selected-id="selectedId"
          :plans="plansByTaskId"
          :expanded="expanded"
          @select="select"
          @togglePlan="togglePlan"
          @ensurePlan="ensurePlan"
          @update="({ id, updates }) => updateQueuedTask(id, updates)"
          @cancel="cancelTask"
          @retry="retryTask"
          @delete="deleteTask"
        />
        <TaskCreateForm :models="models" @submit="createTask" />
      </aside>

      <section class="rightPane">
        <MainChatView
          class="chatHost"
          :messages="messages"
          :queued-prompts="queuedPrompts.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length }))"
          :pending-images="pendingImages"
          :connected="connected"
          :busy="agentBusy"
          :api-token="token"
          @send="sendMainPrompt"
          @interrupt="() => ws?.interrupt()"
          @clear="() => { setMessages([]); finalizeCommandBlock(); pendingImages = []; ws?.clearHistory(); }"
          @addImages="(imgs) => { pendingImages = [...pendingImages, ...imgs]; }"
          @clearImages="() => { pendingImages = []; }"
          @removeQueued="removeQueuedPrompt"
        />
      </section>
    </main>

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
  min-height: 100%;
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
  background: var(--surface);
  border-color: rgba(37, 99, 235, 0.35);
  color: var(--text);
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
  padding: 12px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
  min-height: 0;
  overflow: hidden;
}
.chatHost {
  height: 100%;
  min-height: 0;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.taskBoard {
  flex: 1 1 auto;
  min-height: 0;
}
.rightPane {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
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
    display: block;
  }
}
</style>
